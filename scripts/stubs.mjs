// 0.10.1B stub route: the frontier writes the whole app in one pass, but marks repetitive files `// @qwen` and writes
// them only as stubs: imports, exported signatures, one comment per export saying what it does, and optional
// `// @test <expression>` lines (evaluated with `m` bound to the module). qwen fills in every stub; the harness tests
// each filled file against its own stub, so the frontier writes no spec, fixture or test file.
// Per stub: attempt 1 at temperature 0; on failure 3 candidates in parallel with the error (first that passes wins);
// if none pass, the closest stays on disk and is listed.
//   IS_WORKER_PROJECT=<dir> IS_WORKER_API_KEY=… node scripts/stubs.mjs [--dir src] [--verbose]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { spawnSync } from "node:child_process";
import { IS_WORKER_DIR, WORK_ROOT } from "../lib/paths.mjs";
import { FILES_SCHEMA, parseFiles } from "../lib/schema.mjs";
import { DEFAULTS, armConfig } from "../lib/settings.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta } from "../lib/runs.mjs";
import { appendJsonl } from "../lib/jsonl.mjs";
import { createLimiter } from "../lib/limiter.mjs";
import { exportsDigest } from "../lib/digest.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
const key = process.env.IS_WORKER_API_KEY || process.env.INDICSTACK_API_KEY;
const project = WORK_ROOT || process.cwd();
const verbose = Boolean(args.verbose);
export const MARK = /\/\/\s*@qwen\b/;

export function findStubs(root) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name) && statSync(p).size < 2e5 && MARK.test(readFileSync(p, "utf8"))) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// Export names a stub promises, read from its text.
export function stubExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of m[1].split(",")) { const x = n.trim().split(/\s+as\s+/).pop(); if (x) names.add(x); }
  if (/^export\s+default\b/m.test(src)) names.add("default");
  return [...names];
}
export const stubTests = (src) => [...src.matchAll(/^\s*\/\/\s*@test\s+(.+)$/gm)].map((m) => m[1].trim());

const BROWSER = /\b(document|window|localStorage|sessionStorage|navigator|location|HTMLElement|customElements|requestAnimationFrame|matchMedia|AudioContext|Image|alert|confirm|prompt)\b is not defined/;

// Test a filled file against its stub, in a child process. Returns {pass, fail, out}.
export function checkFilled(file, stubSrc, cwd) {
  const filled = readFileSync(file, "utf8");
  const problems = [];
  if (MARK.test(filled)) problems.push("the @qwen marker is still in the file: the stub was not filled");
  if (/not implemented|TODO: implement/i.test(filled)) problems.push("a body still says not implemented");
  const syn = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syn.status !== 0) problems.push(`syntax: ${(syn.stderr.split("\n").find((l) => /Error/.test(l)) || "").trim()}`);
  if (!problems.length) {
    const script = `const m = await import(${JSON.stringify("file://" + file)}).catch((e) => ({ __err: String(e && e.message || e) }));
const out = { err: m.__err || null, keys: m.__err ? [] : Object.keys(m), tests: [] };
if (!m.__err) for (const t of ${JSON.stringify(stubTests(stubSrc))}) {
  try { const v = await (0, eval)("(async (m) => (" + t + "))")(m); out.tests.push({ t, ok: Boolean(v) }); }
  catch (e) { out.tests.push({ t, ok: false, error: String(e && e.message || e).slice(0, 200) }); }
}
console.log("@@" + JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8", timeout: 30000 });
    let o; try { o = JSON.parse((r.stdout.split("@@")[1] || "").trim()); } catch { o = { err: (r.stderr || "import check did not run").split("\n")[0] }; }
    if (o.err && !BROWSER.test(o.err)) problems.push(`import: ${o.err}`);
    if (!o.err) {
      const missing = stubExports(stubSrc).filter((n) => !o.keys.includes(n));
      if (missing.length) problems.push(`missing exports promised by the stub: ${missing.join(", ")}`);
      for (const t of o.tests) if (!t.ok) problems.push(`@test failed: ${t.t}${t.error ? ` (${t.error})` : " (false)"}`);
    }
  }
  const n = 2 + stubTests(stubSrc).length;
  return { pass: problems.length ? Math.max(0, n - problems.length) : n, fail: problems.length, out: problems.join("\n") };
}

// What qwen sees besides the stub: each relative import (full text if small, else its export signatures; a stub's own
// contract if it is a stub too) and one finished file in the same folder for style.
function contextFor(file, stubSet) {
  const src = readFileSync(file, "utf8"), parts = [];
  for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const p = resolve(dirname(file), m[1]);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf8"), rel = relative(project, p);
    parts.push(stubSet.has(p) ? `=== ${rel} (a stub qwen fills too; rely only on its contract) ===\n${t}`
      : t.length <= 5000 ? `=== ${rel} ===\n${t}` : `=== ${rel} (export signatures) ===\n${exportsDigest(rel, t)}`);
  }
  const sib = readdirSync(dirname(file)).map((n) => join(dirname(file), n)).find((p) => p !== file && /\.m?js$/.test(p) && !stubSet.has(p) && statSync(p).size <= 5000);
  if (sib) parts.push(`=== ${relative(project, sib)} (a finished file in the same folder: match its style) ===\n${readFileSync(sib, "utf8")}`);
  return parts;
}

async function main() {
  if (!key) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
  const stubs = findStubs(resolve(project, String(args.dir || "src")));
  if (!stubs.length) { console.log("stubs: none marked // @qwen"); return; }
  const cfg = armConfig("A");
  const run = newRunDir("A", "expand");
  const p0 = runPaths(run.dir);
  writeMeta(run.dir, { id: run.id, arm: "A", mode: cfg.mode, kind: "expand", route: "stubs", model: cfg.model, baseUrl: cfg.baseUrl, concurrency: cfg.concurrency, started: new Date().toISOString(), status: "running", ticketsTotal: stubs.length });
  const log = (m, always = false) => { if (verbose || always) console.log(m); appendJsonl(p0.log.replace(/\.log$/, ".events.jsonl"), { ts: new Date().toISOString(), msg: m }); };
  const stubSet = new Set(stubs);
  const stubSrc = new Map(stubs.map((f) => [f, readFileSync(f, "utf8")]));
  writeFileSync(resolve(run.dir, "stubs.json"), JSON.stringify(Object.fromEntries([...stubSrc].map(([f, s]) => [relative(project, f), s])), null, 1));
  const system = [
    "You complete one source file. You are given a stub: keep every import, export name, signature and contract comment exactly; replace the bodies, and remove the `// @qwen` marker, with a complete, working implementation.",
    "Use only identifiers that the stub, the files shown or the standard library provide. Do not add exports the stub does not have. Satisfy every `// @test` line (m is the module).",
    'Output only a JSON object {"files":[{"path":"…","content":"…"}]} with exactly one file at the given path. No prose, no markdown fences.',
  ].join("\n");
  const limiter = createLimiter({ start: cfg.concurrency || 4, max: cfg.concurrency || 4, cleanMultiplier: DEFAULTS.aimd_clean_multiplier });
  async function ask(user, temperature) {
    await limiter.acquire();
    const t0 = performance.now();
    try {
      const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.model, temperature, max_tokens: DEFAULTS.first_run_answer_tokens * 3, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: FILES_SCHEMA }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
      const j = await r.json();
      limiter.release(r.ok && !j.error ? "clean" : "other");
      return { ok: r.ok && !j.error, text: j.choices?.[0]?.message?.content || "", error: j.error ? JSON.stringify(j.error).slice(0, 200) : null, seconds: (performance.now() - t0) / 1000, usage: j.usage || {} };
    } catch (e) { limiter.release("other"); return { ok: false, text: "", error: String(e.message || e), seconds: (performance.now() - t0) / 1000, usage: {} }; }
  }
  let ok = 0, first = 0, id = 0;
  const left = [];
  await Promise.all(stubs.map(async (file) => {
    const tid = ++id, rel = relative(project, file), stub = stubSrc.get(file);
    const base = [...contextFor(file, stubSet), `=== complete this stub: ${rel} ===\n${stub}`].join("\n\n");
    const tryOne = async (user, temperature, attempt) => {
      const r = await ask(user, temperature);
      const parsed = r.ok ? parseFiles(r.text) : { ok: false, error: r.error };
      appendJsonl(p0.calls, { ts: new Date().toISOString(), stage: "worker", arm: "A", ticket: tid, attempt, temperature, kind: r.ok ? (parsed.ok ? "ok" : "bad_json") : "http_error", seconds: +r.seconds.toFixed(3), prompt_tokens: r.usage.prompt_tokens ?? null, completion_tokens: r.usage.completion_tokens ?? null, cost: Number.isFinite(r.usage.cost) ? r.usage.cost : null });
      if (!parsed.ok) return { content: null, err: `previous answer was not valid: ${parsed.error}` };
      return { content: (parsed.files.find((f) => f.path === rel) || parsed.files[0]).content };
    };
    const test = (content) => { writeFileSync(file, content); return checkFilled(file, stub, project); };
    let best = null, err;
    const a = await tryOne(base, 0, 1);
    if (a.content != null) {
      const tr = test(a.content);
      log(`t${tid} ${rel} attempt 1: ${tr.fail ? `${tr.fail} problem(s)` : "ok"}`);
      if (!tr.fail) { ok++; first++; appendJsonl(p0.tickets, { ts: new Date().toISOString(), ticket: tid, path: rel, status: "ok", attempts: 1, tests_pass: tr.pass, tests_fail: 0 }); return; }
      best = { content: a.content, ...tr }; err = tr.out;
    } else err = a.err;
    const cands = await Promise.all([0.3, 0.6, 0.9].map((t) => tryOne(`${base}\n\n[fix] ${err}`, t, 2)));
    for (const c of cands) {
      if (c.content == null) continue;
      const tr = test(c.content);
      if (!best || tr.fail < best.fail) best = { content: c.content, ...tr };
      if (!tr.fail) { ok++; log(`t${tid} ${rel} retry: passed`); appendJsonl(p0.tickets, { ts: new Date().toISOString(), ticket: tid, path: rel, status: "ok", attempts: 2, tests_pass: tr.pass, tests_fail: 0 }); return; }
    }
    writeFileSync(file, best ? best.content : stub);
    left.push(`${rel} — ${(best ? best.out : err).split("\n")[0]}`);
    appendJsonl(p0.tickets, { ts: new Date().toISOString(), ticket: tid, path: rel, status: "queued", attempts: 2, error: "check_failed" });
  }));
  updateMeta(run.dir, { status: left.length ? "needs_claude" : "done", finished: new Date().toISOString(), testsFinal: { pass: ok, fail: stubs.length - ok }, firstTry: first });
  console.log(`stubs: qwen filled ${ok}/${stubs.length} (${first} first try)${left.length ? `; left for you (closest candidate on disk):\n  ${left.join("\n  ")}` : ""}`);
  if (left.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
