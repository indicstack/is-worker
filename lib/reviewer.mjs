// Pluggable blind reviewer. Chosen by `--reviewer <name>` or IS_WORKER_REVIEWER (default claude).
// Every reviewer gets the same one-line prompt, runs inside the isolated review folder with the IndicStack key
// blanked in its environment, and must write REVIEW.md there; scripts/is-worker.mjs reads the verdict from that file.
//
// CLI flags below were written against these versions (edit the arrays if yours differ; nothing else depends on them):
//   claude    Claude Code 2.1.x, Oct 2026     claude -p --model <m> --output-format json --no-session-persistence --allowedTools …   (prompt on stdin)
//   codex     OpenAI Codex CLI 0.x, Oct 2026  codex exec --cd <folder> --sandbox workspace-write --skip-git-repo-check [--model <m>] "<prompt>"
//   opencode  OpenCode 1.x, Oct 2026          opencode run [--model <m>] "<prompt>"   (cwd = folder)
//   custom    IS_WORKER_REVIEW_CMD template with {folder} and {prompt}, run through the shell with cwd = folder
//   openrouter  no CLI: the prompt file and every other file in the folder are sent in one chat completion to
//               https://openrouter.ai/api/v1 with the key in OPENROUTER_API_KEY or IS_WORKER_KEY_C (~/.is-worker/keys.env);
//               the reply is written to the output file. Exact token counts and USD cost come back with the reply.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { claudeBin } from "./claude-bin.mjs";
import { keyFor } from "./keys.mjs";

export const PROMPT = "Read PROMPT-REVIEW.md in this folder and do exactly what it says. Write REVIEW.md here, then stop.";
// Typed mode (default since 0.8.0): the reviewer answers the open checklist statements as JSON instead of writing prose.
export const PROMPT_TYPED = "Read PROMPT-TYPED.md in this folder and do exactly what it says. Write ANSWERS.json here, then stop.";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// IS_WORKER_KEY_C in the environment (even empty) beats the keys file, so tests and CI can pin it.
const openrouterKey = (env) => env.OPENROUTER_API_KEY || (env.IS_WORKER_KEY_C !== undefined ? env.IS_WORKER_KEY_C : keyFor("C")) || null;
export const DEFAULT_REVIEWER = "claude";
const WIN = process.platform === "win32";
const needShell = (bin) => WIN && /\.(cmd|bat)$/i.test(bin);

// Path of a CLI on the PATH, or null. Env override (<NAME>_BIN) must exist to count.
export function which(name, env = process.env) {
  const override = env[`${name.toUpperCase()}_BIN`];
  if (override) return existsSync(override) ? override : null;
  const r = spawnSync(WIN ? "where" : "which", [name], { encoding: "utf8" });
  const found = (r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!found.length) return null;
  return WIN ? found.find((f) => /\.(exe|cmd)$/i.test(f)) || found[0] : found[0];
}

export function fillTemplate(template, { folder, prompt }) {
  return String(template).replaceAll("{folder}", () => folder).replaceAll("{prompt}", () => prompt);
}

export const reviewers = {
  claude: {
    label: "Claude Code CLI",
    bin: () => { const b = claudeBin(); if (b !== "claude") return b; return spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0 ? "claude" : null; },
    args: ({ model }) => ["-p", "--model", model || "opus", "--output-format", "json", "--no-session-persistence", "--allowedTools", "Read", "Write", "Glob", "Grep"],
    stdin: PROMPT, // replaced by the prompt runReview is given
    usage: (stdout) => {
      let j = null; try { j = JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop()); } catch {}
      if (!j) return null;
      const u = j.usage || {};
      return { input: u.input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, cost_usd: j.total_cost_usd ?? null, model: Object.keys(j.modelUsage || {})[0] || null };
    },
  },
  codex: {
    label: "OpenAI Codex CLI",
    bin: (env) => which("codex", env),
    args: ({ folder, model, prompt = PROMPT }) => ["exec", "--cd", folder, "--sandbox", "workspace-write", "--skip-git-repo-check", ...(model ? ["--model", model] : []), prompt],
    usage: () => null,
  },
  opencode: {
    label: "OpenCode",
    bin: (env) => which("opencode", env),
    args: ({ model, prompt = PROMPT }) => ["run", ...(model ? ["--model", model] : []), prompt],
    usage: () => null,
  },
  custom: {
    label: "custom command (IS_WORKER_REVIEW_CMD)",
    bin: (env) => env.IS_WORKER_REVIEW_CMD || null,
    shell: true,
    command: ({ folder, env, prompt = PROMPT }) => fillTemplate(env.IS_WORKER_REVIEW_CMD, { folder, prompt }),
    usage: () => null,
  },
  openrouter: {
    label: "OpenRouter API (no CLI)",
    bin: (env) => (openrouterKey(env) ? "OPENROUTER_API_KEY / IS_WORKER_KEY_C set" : null),
    api: true,
    usage: (json) => { const u = json?.usage || {}; return { input: u.prompt_tokens || 0, cache_write: 0, cache_read: u.prompt_tokens_details?.cached_tokens || 0, output: u.completion_tokens || 0, cost_usd: u.cost ?? null, model: json?.model || null }; },
  },
};

// The API reviewer: the prompt file, then every other .md/.json file in the folder, in one user message. Blind like the
// CLIs (nothing outside the folder is sent). Returns the same shape as a CLI run; the reply is written to outFile.
async function apiReview({ folder, model, promptFile, outFile, maxTokens, env }) {
  const key = openrouterKey(env);
  const files = readdirSync(folder).filter((f) => /\.(md|json)$/i.test(f) && f !== promptFile && f !== outFile).sort();
  const content = `${readFileSync(resolve(folder, promptFile), "utf8")}\n\n` + files.map((f) => `=== ${f} ===\n${readFileSync(resolve(folder, f), "utf8")}`).join("\n\n") + `\n\nWrite the full contents of ${outFile} now, nothing else.`;
  const t0 = Date.now();
  let json;
  try {
    const res = await fetch(OPENROUTER_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: maxTokens, temperature: 0, usage: { include: true } }) });
    json = await res.json();
  } catch (e) { return { skipped: false, status: 1, stdout: "", stderr: String(e?.cause?.code || e?.message || e), usage: null, seconds: (Date.now() - t0) / 1000, error: String(e?.message || e) }; }
  const seconds = (Date.now() - t0) / 1000;
  if (json?.error) return { skipped: false, status: 1, stdout: "", stderr: JSON.stringify(json.error).slice(0, 500), usage: null, seconds, error: json.error.message || "openrouter error" };
  const text = json?.choices?.[0]?.message?.content || "";
  writeFileSync(resolve(folder, outFile), text);
  return { skipped: false, status: 0, stdout: text, stderr: "", usage: reviewers.openrouter.usage(json), seconds, error: null };
}

export function selectedReviewer(flag, env = process.env) {
  const name = String(flag || env.IS_WORKER_REVIEWER || DEFAULT_REVIEWER).toLowerCase();
  if (!reviewers[name]) throw new Error(`unknown reviewer "${name}"; one of ${Object.keys(reviewers).join("|")}`);
  return name;
}

// One row per reviewer: { name, label, bin (path or null), selected }.
export function reviewerStatus(selected = DEFAULT_REVIEWER, env = process.env) {
  return Object.entries(reviewers).map(([name, r]) => ({ name, label: r.label, bin: r.bin(env), selected: name === selected }));
}

// Runs the reviewer in `folder`. Never throws for a missing CLI: returns { skipped: true, verdict, reason }.
// mode "full" (prose REVIEW.md, the pre-0.8.0 review) or "typed" (ANSWERS.json for the open checklist statements).
// Sync for the CLIs; the openrouter reviewer returns a promise, so callers `await` the result either way.
export function runReview({ name, folder, model = null, mode = "full", maxTokens = 8000, env = process.env }) {
  const r = reviewers[name];
  if (!r) throw new Error(`unknown reviewer "${name}"`);
  const skip = (reason) => ({ skipped: true, verdict: `skipped (no ${name} CLI)`, reason, usage: null, seconds: 0, status: null, stdout: "", stderr: "" });
  const bin = r.bin(env);
  if (!bin) return skip(name === "custom" ? "IS_WORKER_REVIEW_CMD is not set" : name === "openrouter" ? "no OpenRouter key (OPENROUTER_API_KEY or IS_WORKER_KEY_C)" : `${r.label} (${name}) not found on PATH`);
  const prompt = mode === "typed" ? PROMPT_TYPED : PROMPT;
  const promptFile = mode === "typed" ? "PROMPT-TYPED.md" : "PROMPT-REVIEW.md", outFile = mode === "typed" ? "ANSWERS.json" : "REVIEW.md";
  if (r.api) return apiReview({ folder, model, promptFile, outFile, maxTokens, env });
  const childEnv = { ...env, IS_WORKER_API_KEY: "", INDICSTACK_API_KEY: "" };
  const common = { cwd: folder, encoding: "utf8", maxBuffer: 50e6, env: childEnv };
  const t0 = Date.now();
  const res = r.shell
    ? spawnSync(r.command({ folder, env, prompt }), { ...common, shell: true })
    : spawnSync(bin, r.args({ folder, model, prompt }), { ...common, input: prompt, shell: needShell(bin) });
  const seconds = (Date.now() - t0) / 1000;
  const notFound = res.error?.code === "ENOENT" || res.status === 127 || res.status === 9009;
  if (notFound) return skip(`${r.label} (${name}) could not be started: ${res.error?.message || `exit ${res.status}`}`);
  return { skipped: false, status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", usage: r.usage(res.stdout || ""), seconds, error: res.error ? String(res.error.message) : null };
}
