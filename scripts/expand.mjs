// `expand`: the one job qwen38-27b is measured to be good at — writing siblings of a pattern. The frontier model writes
// ONE example file per pattern plus data for the tests; qwen writes every other target from them, four at a time; the
// harness tests each target. No brief, no tickets, no planning turns.
//   IS_WORKER_PROJECT=<dir> IS_WORKER_API_KEY=… node scripts/expand.mjs --spec .is-worker/expand.json
// expand.json, one pattern:
//   { "instructions": "…", "example": {"path": "src/x.mjs", "content": "…", …test fields}, "reads": ["src/shared.mjs"],
//     "test": {"kind": "pure-fn" | "html-view" | "svg-chart", …} | "test_template": "node:test source with {{path}} and {{params.NAME}}",
//     "digest": false, "samples": 3, "retries": 1,
//     "targets": [ {"path": "src/y.mjs", "params": {"NAME": "…"}, …test fields} … ] }
// or several patterns in one run (M3): { "instructions": "shared", "reads": ["shared"], "patterns": [ {…one pattern…} … ] }
// What the harness does for the frontier model:
//   M1  runs each pattern's test on its example first; a broken test stops that pattern before any qwen call.
//   N2  builds the test from `test.kind` (lib/testkinds.mjs) so the frontier writes data, not test code.
//   N1  `digest: true` sends the reads' export signatures instead of their full text, and, with an html-view fixture,
//       the live shape of the fixture (lib/digest.mjs), so nobody describes the interface in prose.
//   M2+N6  a failed target gets `samples` parallel retries at rising temperature, each with the test error and a passing
//       sibling as a second example; the first candidate that passes wins (CodeT-style selection by execution). If none
//       pass, the closest candidate stays on disk for the frontier to fix rather than rewrite.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { IS_WORKER_DIR, WORK_ROOT } from "../lib/paths.mjs";
import { FILES_SCHEMA, parseFiles } from "../lib/schema.mjs";
import { DEFAULTS, armConfig } from "../lib/settings.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta } from "../lib/runs.mjs";
import { appendJsonl } from "../lib/jsonl.mjs";
import { createLimiter } from "../lib/limiter.mjs";
import { buildTest } from "../lib/testkinds.mjs";
import { exportsDigest, shapeOf } from "../lib/digest.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const key = process.env.IS_WORKER_API_KEY || process.env.INDICSTACK_API_KEY;
const specPath = resolve(String(args.spec || resolve(IS_WORKER_DIR, "expand.json")));
if (!existsSync(specPath)) { console.error(`no spec at ${specPath}`); process.exit(2); }
const raw = JSON.parse(readFileSync(specPath, "utf8"));
const patterns = (Array.isArray(raw.patterns) ? raw.patterns : [raw]).map((p, k) => ({
  ...p, name: p.name || p.example?.path || `pattern ${k + 1}`,
  instructions: [raw.patterns ? raw.instructions : "", p.instructions].filter(Boolean).join("\n"),
  reads: [...new Set([...(raw.patterns ? raw.reads || [] : []), ...(p.reads || [])])],
}));
for (const p of patterns) if (!p.example?.path || !p.example?.content || !Array.isArray(p.targets) || !p.targets.length) { console.error(`${p.name}: needs example {path, content} and a non-empty targets list`); process.exit(2); }
const project = WORK_ROOT || process.cwd();
const selfTestOnly = Boolean(args["self-test"]);
if (!key && !selfTestOnly) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
const cfg = armConfig("A");
const total = patterns.reduce((a, p) => a + p.targets.length, 0);
const run = selfTestOnly ? null : newRunDir("A", "expand");
const p0 = run ? runPaths(run.dir) : null;
const tmpDir = run ? run.dir : resolve(IS_WORKER_DIR, "self-test");
const specHash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
if (run) writeMeta(run.dir, { id: run.id, arm: "A", mode: cfg.mode, kind: "expand", model: cfg.model, baseUrl: cfg.baseUrl, concurrency: cfg.concurrency, briefHash: specHash, spec: specPath, started: new Date().toISOString(), status: "running", ticketsTotal: total, patterns: patterns.map((p) => ({ name: p.name, targets: p.targets.length })), defaults: { samples: 3, retries: 1 } });
const log = (m) => { console.log(`${new Date().toISOString()} ${m}`); if (p0) appendJsonl(p0.log.replace(/\.log$/, ".events.jsonl"), { ts: new Date().toISOString(), msg: m }); };
const jsonl = (k, row) => { if (p0) appendJsonl(p0[k], { ts: new Date().toISOString(), ...row }); };

const render = (tpl, t) => String(tpl).replace(/\{\{path\}\}/g, t.path).replace(/\{\{params\.([A-Za-z0-9_]+)\}\}/g, (_, k) => String(t.params?.[k] ?? ""));
const testSource = (p, t) => (p.test ? buildTest(p.test, t) : p.test_template ? render(p.test_template, t) : null);

let testSeq = 0;
function test(p, t) {
  const src = testSource(p, t);
  if (!src) return syntax(t);
  const f = resolve(tmpDir, "tests", `t${++testSeq}.test.mjs`);
  mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, src);
  const tr = spawnSync(process.execPath, ["--test", f], { cwd: project, encoding: "utf8", env: { ...process.env, IS_WORKER_WORK: project }, timeout: DEFAULTS.test_timeout_s * 1000 });
  const out = tr.stdout + tr.stderr;
  const pass = Number((out.match(/^(?:ℹ|#) pass (\d+)/m) || [0, 0])[1]), fail = Number((out.match(/^(?:ℹ|#) fail (\d+)/m) || [0, 0])[1]);
  return { pass, fail: fail || (pass ? 0 : 1), out: out.replace(/^\s+at .*\n/gm, "") };
}
function syntax(t) { const r = spawnSync(process.execPath, ["--check", resolve(project, t.path)], { encoding: "utf8" }); return r.status === 0 ? { pass: 1, fail: 0, out: "" } : { pass: 0, fail: 1, out: r.stderr }; }

// N1: what qwen reads about the existing code — full text, or export signatures plus the fixture's live shape.
async function readsFor(p) {
  const files = p.reads.filter((f) => existsSync(resolve(project, f)));
  if (!p.digest) return files.map((f) => `=== existing file ${f} ===\n${readFileSync(resolve(project, f), "utf8")}`);
  const parts = files.map((f) => exportsDigest(f, readFileSync(resolve(project, f), "utf8")));
  if (p.test?.fixture) {
    try {
      const fx = (await import(pathToFileURL(resolve(project, p.test.fixture)).href)).default;
      const v = typeof fx === "function" ? fx({}) : fx;
      parts.push(`=== shape of the argument passed to ${p.test.fn || "render"} (built by ${p.test.fixture} from the real modules) ===\n${await shapeOf(v, { probe: p.test.probe || {} })}`);
    } catch (e) { log(`${p.name}: fixture shape unavailable (${e.message})`); }
  }
  return [`=== interface of existing code (digest) ===\n${parts.join("\n\n")}`];
}

async function ask(messages, temperature) {
  const body = { model: cfg.model, temperature, max_tokens: DEFAULTS.first_run_answer_tokens * 2, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: FILES_SCHEMA }, messages };
  const t0 = performance.now();
  try {
    const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const j = await r.json();
    const u = j.usage || {};
    return { ok: r.ok && !j.error, text: j.choices?.[0]?.message?.content || "", error: j.error ? JSON.stringify(j.error).slice(0, 300) : null, seconds: (performance.now() - t0) / 1000, usage: { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, cost: Number.isFinite(u.cost) ? u.cost : null } };
  } catch (e) { return { ok: false, text: "", error: String(e.message || e), seconds: (performance.now() - t0) / 1000, usage: { prompt_tokens: null, completion_tokens: null, cost: null } }; }
}

// M1: the pattern's own test must pass on its example before qwen is asked anything.
const ready = [];
let blocked = 0;
for (const p of patterns) {
  mkdirSync(dirname(resolve(project, p.example.path)), { recursive: true });
  if (!existsSync(resolve(project, p.example.path))) writeFileSync(resolve(project, p.example.path), p.example.content);
  let st;
  try { st = test(p, p.example); } catch (e) { st = { pass: 0, fail: 1, out: e.message }; }
  if (st.fail || !st.pass) {
    blocked += p.targets.length;
    console.log(`\nself-test FAILED for ${p.name}: its test does not pass on the example, so no target was sent. Fix the test or the example and rerun.\n${String(st.out).slice(0, 3000)}`);
    for (const t of p.targets) jsonl("tickets", { ticket: t.path, path: t.path, status: "queued", attempts: 0, error: "self_test_failed" });
    continue;
  }
  log(`${p.name}: self-test passed on the example (${st.pass} pass)`);
  ready.push(p);
}
if (selfTestOnly) { console.log(`\nself-test: ${ready.length}/${patterns.length} pattern(s) ready.`); process.exit(ready.length === patterns.length ? 0 : 2); }

const limiter = createLimiter({ start: cfg.concurrency || 1, max: cfg.concurrency || 1, cleanMultiplier: DEFAULTS.aimd_clean_multiplier });
let ok = 0, firstTry = 0, id = 0;
const left = [];
const system = (p) => [
  "You write one source file that follows an example exactly: same structure, same exports, same style, different content as the parameters say.",
  'Output only a JSON object {"files":[{"path":"…","content":"…"}]} with exactly one file at the given path. No prose, no markdown fences.',
  "Never invent an identifier, path or constant the example, the existing files or the instructions do not name.",
  p.instructions || "",
].join("\n");
const targetText = (t) => { const { path, ...rest } = t; return `=== write ${path} ===\nrequirements: ${JSON.stringify(rest)}`; };

async function call(p, t, tid, attempt, user, temperature) {
  await limiter.acquire();
  const r = await ask([{ role: "system", content: system(p) }, { role: "user", content: user }], temperature);
  limiter.release(r.ok ? "clean" : "other");
  const parsed = r.ok ? parseFiles(r.text) : { ok: false, error: r.error };
  jsonl("calls", { stage: "worker", arm: "A", ticket: tid, attempt, temperature, kind: r.ok ? (parsed.ok ? "ok" : "bad_json") : "http_error", seconds: +r.seconds.toFixed(3), prompt_tokens: r.usage.prompt_tokens, completion_tokens: r.usage.completion_tokens, cost: r.usage.cost, error: parsed.ok ? null : parsed.error });
  return { r, parsed, content: parsed.ok ? (parsed.files.find((f) => f.path === t.path) || parsed.files[0]).content : null };
}

await Promise.all(ready.map(async (p) => {
  const reads = await readsFor(p);
  const passed = []; // paths of siblings that passed, used as a second example on retries
  const samples = Math.max(1, Number(p.samples ?? 3)), retries = Math.max(0, Number(p.retries ?? 1));
  await Promise.all(p.targets.map(async (t) => {
    const tid = ++id, dest = resolve(project, t.path);
    mkdirSync(dirname(dest), { recursive: true });
    const base = [...reads, `=== example ${p.example.path} ===\n${p.example.content}`];
    const tryContent = (content) => { writeFileSync(dest, content); return test(p, t); };
    // Attempt 1: one deterministic call.
    const a = await call(p, t, tid, 1, [...base, targetText(t)].join("\n\n"), 0);
    let best = null, err = a.parsed.ok ? null : `previous answer was not valid: ${a.parsed.error}`;
    if (a.content != null) {
      const tr = tryContent(a.content);
      log(`t${tid} ${t.path} attempt 1: ${tr.pass} pass ${tr.fail} fail (${a.r.seconds.toFixed(1)}s, ${a.r.usage.completion_tokens} out)`);
      if (!tr.fail && tr.pass) { ok++; firstTry++; passed.push(t.path); jsonl("tickets", { ticket: tid, path: t.path, status: "ok", attempts: 1, tests_pass: tr.pass, tests_fail: 0 }); return; }
      best = { content: a.content, ...tr }; err = `the test failed:\n${String(tr.out).slice(0, 2500)}`;
    } else log(`t${tid} ${t.path} attempt 1: ${a.parsed.error}`);
    // Retries: `samples` candidates in parallel, each with the error and a passing sibling; first passer wins.
    for (let round = 1; round <= retries; round++) {
      const sib = passed.find((x) => x !== t.path);
      const extra = sib ? [`=== a sibling that already passes its test: ${sib} ===\n${readFileSync(resolve(project, sib), "utf8")}`] : [];
      const user = [...base, ...extra, targetText(t), `[fix] ${err}`].join("\n\n");
      const temps = Array.from({ length: samples }, (_, k) => +(0.3 + (samples > 1 ? (0.6 * k) / (samples - 1) : 0)).toFixed(2));
      const cands = await Promise.all(temps.map((temp) => call(p, t, tid, round + 1, user, temp)));
      for (const c of cands) {
        if (c.content == null) continue;
        const tr = tryContent(c.content);
        if (!best || tr.pass - tr.fail > best.pass - best.fail) best = { content: c.content, ...tr };
        if (!tr.fail && tr.pass) {
          log(`t${tid} ${t.path} retry ${round}: a candidate passed (${tr.pass} pass) of ${samples}`);
          ok++; passed.push(t.path); jsonl("tickets", { ticket: tid, path: t.path, status: "ok", attempts: round + 1, samples, tests_pass: tr.pass, tests_fail: 0 }); return;
        }
      }
      log(`t${tid} ${t.path} retry ${round}: 0 of ${samples} candidates passed${best ? ` (best ${best.pass} pass ${best.fail} fail)` : ""}`);
      if (best) err = `the test failed:\n${String(best.out).slice(0, 2500)}`;
    }
    if (best) writeFileSync(dest, best.content); // closest candidate stays for the frontier to fix
    left.push(t.path); jsonl("tickets", { ticket: tid, path: t.path, status: "queued", attempts: retries + 1, error: "check_failed", closest: best ? { pass: best.pass, fail: best.fail } : null });
  }));
}));
updateMeta(run.dir, { status: left.length || blocked ? "needs_claude" : "done", finished: new Date().toISOString(), testsFinal: { pass: ok, fail: total - ok }, firstTry, selfTestBlocked: blocked });
console.log(`\nexpand: ${ok}/${total} targets written and tested by ${cfg.model} (${firstTry} first try)${blocked ? `; ${blocked} not sent because a self-test failed` : ""}; ${left.length ? `left for you (closest candidate on disk): ${left.join(", ")}` : "nothing left"}. Run ${run.id}.`);
if (left.length || blocked) process.exit(1);
