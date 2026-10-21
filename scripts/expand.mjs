// `expand`: the one job qwen38-27b is measured to be good at — writing siblings of a pattern. The frontier model writes
// ONE example file and a test template; qwen writes every other target from them, four at a time; the harness renders the
// test per target and runs it; a failed target gets one retry with the error, then is left for the frontier. No brief, no
// tickets, no planning turns: the frontier's whole output is the example, the template and the target list.
//   IS_WORKER_PROJECT=<dir> IS_WORKER_API_KEY=… node scripts/expand.mjs --spec .is-worker/expand.json
// expand.json: { "instructions": "…", "example": {"path": "src/x.mjs", "content": "…"}, "reads": ["src/shared.mjs"],
//                "test_template": "js source with {{path}} and {{params.NAME}} placeholders, run with node --test",
//                "targets": [ {"path": "src/y.mjs", "params": {"NAME": "…"}} … ] }
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ROOT } from "../lib/brief.mjs";
import { IS_WORKER_DIR, WORK_ROOT } from "../lib/paths.mjs";
import { FILES_SCHEMA, parseFiles } from "../lib/schema.mjs";
import { DEFAULTS, armConfig } from "../lib/settings.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta } from "../lib/runs.mjs";
import { appendJsonl } from "../lib/jsonl.mjs";
import { createLimiter } from "../lib/limiter.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const key = process.env.IS_WORKER_API_KEY || process.env.INDICSTACK_API_KEY;
if (!key) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
const specPath = resolve(String(args.spec || resolve(IS_WORKER_DIR, "expand.json")));
if (!existsSync(specPath)) { console.error(`no spec at ${specPath}`); process.exit(2); }
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (!spec.example?.path || !spec.example?.content || !Array.isArray(spec.targets) || !spec.targets.length) { console.error("expand.json needs example {path, content} and a non-empty targets list"); process.exit(2); }
const cfg = armConfig("A");
const project = WORK_ROOT || process.cwd();
const run = newRunDir("A", "expand");
const p = runPaths(run.dir);
const specHash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
writeMeta(run.dir, { id: run.id, arm: "A", mode: cfg.mode, kind: "expand", model: cfg.model, baseUrl: cfg.baseUrl, concurrency: cfg.concurrency, briefHash: specHash, spec: specPath, started: new Date().toISOString(), status: "running", ticketsTotal: spec.targets.length, defaults: { retries: 1 } });
const log = (m) => { console.log(`${new Date().toISOString()} ${m}`); appendJsonl(p.log.replace(/\.log$/, ".events.jsonl"), { ts: new Date().toISOString(), msg: m }); };
// The example itself is written by the frontier model; put it in place so targets can import siblings the same way.
mkdirSync(dirname(resolve(project, spec.example.path)), { recursive: true });
if (!existsSync(resolve(project, spec.example.path))) writeFileSync(resolve(project, spec.example.path), spec.example.content);

const reads = (spec.reads || []).filter((f) => existsSync(resolve(project, f))).map((f) => `=== existing file ${f} ===\n${readFileSync(resolve(project, f), "utf8")}`);
const system = [
  "You write one source file that follows an example exactly: same structure, same exports, same style, different content as the parameters say.",
  'Output only a JSON object {"files":[{"path":"…","content":"…"}]} with exactly one file at the given path. No prose, no markdown fences.',
  "Never invent an identifier, path or constant the example, the existing files or the instructions do not name.",
  spec.instructions || "",
].join("\n");
const render = (tpl, t) => String(tpl).replace(/\{\{path\}\}/g, t.path).replace(/\{\{params\.([A-Za-z0-9_]+)\}\}/g, (_, k) => String(t.params?.[k] ?? ""));

async function ask(messages, temperature) {
  const body = { model: cfg.model, temperature, max_tokens: DEFAULTS.first_run_answer_tokens * 2, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: FILES_SCHEMA }, messages };
  const t0 = performance.now();
  const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const j = await r.json();
  const u = j.usage || {};
  return { ok: r.ok && !j.error, text: j.choices?.[0]?.message?.content || "", error: j.error ? JSON.stringify(j.error).slice(0, 300) : null, seconds: (performance.now() - t0) / 1000, usage: { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, cost: Number.isFinite(u.cost) ? u.cost : null } };
}
function test(t, i) {
  if (!spec.test_template) return { pass: 1, fail: 0, out: "(no test template: syntax check only)", ...syntax(t) };
  const f = resolve(run.dir, "tests", `target-${i + 1}.test.mjs`);
  mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, render(spec.test_template, t));
  const tr = spawnSync(process.execPath, ["--test", f], { cwd: project, encoding: "utf8", env: { ...process.env, IS_WORKER_WORK: project }, timeout: DEFAULTS.test_timeout_s * 1000 });
  const out = tr.stdout + tr.stderr;
  return { pass: Number((out.match(/^(?:ℹ|#) pass (\d+)/m) || [0, 0])[1]), fail: Number((out.match(/^(?:ℹ|#) fail (\d+)/m) || [0, 0])[1]), out };
}
function syntax(t) { const r = spawnSync(process.execPath, ["--check", resolve(project, t.path)], { encoding: "utf8" }); return r.status === 0 ? { pass: 1, fail: 0 } : { pass: 0, fail: 1, out: r.stderr }; }

const limiter = createLimiter({ start: cfg.concurrency || 1, max: cfg.concurrency || 1, cleanMultiplier: DEFAULTS.aimd_clean_multiplier });
let ok = 0, left = [];
await Promise.all(spec.targets.map(async (t, i) => {
  const id = i + 1;
  let fixes = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = [...reads, `=== example ${spec.example.path} ===\n${spec.example.content}`, `=== write ${t.path} ===\nparameters: ${JSON.stringify(t.params || {})}${fixes.length ? `\n\n[fix] ${fixes.join("\n")}` : ""}`].join("\n\n");
    await limiter.acquire();
    const r = await ask([{ role: "system", content: system }, { role: "user", content: user }], attempt === 1 ? 0 : DEFAULTS.retry_temperature);
    limiter.release(r.ok ? "clean" : "other");
    const parsed = r.ok ? parseFiles(r.text) : { ok: false, error: r.error };
    appendJsonl(p.calls, { ts: new Date().toISOString(), stage: "worker", arm: "A", ticket: id, attempt, kind: r.ok ? (parsed.ok ? "ok" : "bad_json") : "http_error", seconds: +r.seconds.toFixed(3), prompt_tokens: r.usage.prompt_tokens, completion_tokens: r.usage.completion_tokens, cost: r.usage.cost, error: parsed.ok ? null : parsed.error });
    if (!parsed.ok) { fixes = [`previous answer was not valid: ${parsed.error}`]; log(`t${id} ${t.path} attempt ${attempt}: ${parsed.error}`); continue; }
    const file = parsed.files.find((f) => f.path === t.path) || parsed.files[0];
    mkdirSync(dirname(resolve(project, t.path)), { recursive: true }); writeFileSync(resolve(project, t.path), file.content);
    const tr = test(t, i);
    log(`t${id} ${t.path} attempt ${attempt}: ${tr.pass} pass ${tr.fail} fail (${r.seconds.toFixed(1)}s, ${r.usage.completion_tokens} out)`);
    if (!tr.fail && tr.pass) { ok++; appendJsonl(p.tickets, { ts: new Date().toISOString(), ticket: id, path: t.path, status: "ok", attempts: attempt, tests_pass: tr.pass, tests_fail: 0 }); return; }
    fixes = [`the test failed:\n${String(tr.out).slice(0, 2500)}`];
  }
  left.push(t.path); appendJsonl(p.tickets, { ts: new Date().toISOString(), ticket: id, path: t.path, status: "queued", attempts: 2, error: "check_failed" });
}));
updateMeta(run.dir, { status: left.length ? "needs_claude" : "done", finished: new Date().toISOString(), testsFinal: { pass: ok, fail: left.length } });
console.log(`\nexpand: ${ok}/${spec.targets.length} targets written and tested by ${cfg.model}; ${left.length ? `left for you: ${left.join(", ")}` : "nothing left"}. Run ${run.id}.`);
if (left.length) process.exit(1);
