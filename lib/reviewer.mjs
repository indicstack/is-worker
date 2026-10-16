// Pluggable blind reviewer. Chosen by `--reviewer <name>` or IS_WORKER_REVIEWER (default claude).
// Every reviewer gets the same one-line prompt, runs inside the isolated review folder with the IndicStack key
// blanked in its environment, and must write REVIEW.md there; scripts/is-worker.mjs reads the verdict from that file.
//
// CLI flags below were written against these versions (edit the arrays if yours differ; nothing else depends on them):
//   claude    Claude Code 2.1.x, Oct 2026     claude -p --model <m> --output-format json --no-session-persistence --allowedTools …   (prompt on stdin)
//   codex     OpenAI Codex CLI 0.x, Oct 2026  codex exec --cd <folder> --sandbox workspace-write --skip-git-repo-check [--model <m>] "<prompt>"
//   opencode  OpenCode 1.x, Oct 2026          opencode run [--model <m>] "<prompt>"   (cwd = folder)
//   custom    IS_WORKER_REVIEW_CMD template with {folder} and {prompt}, run through the shell with cwd = folder
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { claudeBin } from "./claude-bin.mjs";

export const PROMPT = "Read PROMPT-REVIEW.md in this folder and do exactly what it says. Write REVIEW.md here, then stop.";
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
    stdin: PROMPT,
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
    args: ({ folder, model }) => ["exec", "--cd", folder, "--sandbox", "workspace-write", "--skip-git-repo-check", ...(model ? ["--model", model] : []), PROMPT],
    usage: () => null,
  },
  opencode: {
    label: "OpenCode",
    bin: (env) => which("opencode", env),
    args: ({ model }) => ["run", ...(model ? ["--model", model] : []), PROMPT],
    usage: () => null,
  },
  custom: {
    label: "custom command (IS_WORKER_REVIEW_CMD)",
    bin: (env) => env.IS_WORKER_REVIEW_CMD || null,
    shell: true,
    command: ({ folder, env }) => fillTemplate(env.IS_WORKER_REVIEW_CMD, { folder, prompt: PROMPT }),
    usage: () => null,
  },
};

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
export function runReview({ name, folder, model = null, env = process.env }) {
  const r = reviewers[name];
  if (!r) throw new Error(`unknown reviewer "${name}"`);
  const skip = (reason) => ({ skipped: true, verdict: `skipped (no ${name} CLI)`, reason, usage: null, seconds: 0, status: null, stdout: "", stderr: "" });
  const bin = r.bin(env);
  if (!bin) return skip(name === "custom" ? "IS_WORKER_REVIEW_CMD is not set" : `${r.label} (${name}) not found on PATH`);
  const childEnv = { ...env, IS_WORKER_API_KEY: "", INDICSTACK_API_KEY: "" };
  const common = { cwd: folder, encoding: "utf8", maxBuffer: 50e6, env: childEnv };
  const t0 = Date.now();
  const res = r.shell
    ? spawnSync(r.command({ folder, env }), { ...common, shell: true })
    : spawnSync(bin, r.args({ folder, model }), { ...common, input: r.stdin, shell: needShell(bin) });
  const seconds = (Date.now() - t0) / 1000;
  const notFound = res.error?.code === "ENOENT" || res.status === 127 || res.status === 9009;
  if (notFound) return skip(`${r.label} (${name}) could not be started: ${res.error?.message || `exit ${res.status}`}`);
  return { skipped: false, status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", usage: r.usage(res.stdout || ""), seconds, error: res.error ? String(res.error.message) : null };
}
