// 0.11 chunk route, for small tasks in existing code: Opus plans, qwen edits, scripts check.
// qwen 3.8 27B (FP8, one L40S, 245K context) is not run as an agent: it cannot explore a repo, and every turn costs
// latency. Instead Opus breaks the task into self-contained chunks in `.is-worker/chunks.json`; each chunk is one
// single-shot qwen call that sees only what Opus listed for it and returns the new text of one region of one file.
// The harness applies it, checks it, and retries with the error (best of 3). A chunk that still fails is reverted
// and summarised in `.is-worker/chunks-failed.md`, sized so Opus can fix it from that file alone.
//
// chunks.json: { "goal": "one line", "chunks": [ {
//   "id": "pause-overlay",
//   "file": "src/render.mjs",                         // file to change or create
//   "region": { "start": "export function drawHud(", "end": "\n}\n" }  // exact text bounding the region to replace;
//                                                     // omit to write the whole file (new or small files)
//   "task": "what the new region must do, one to five lines",
//   "context": ["src/state.mjs", "src/config.mjs:1-40"],  // whole files or line ranges qwen may read
//   "checks": ["m.drawHud.length === 2"],              // JS expressions, m = the changed module (optional)
//   "run": ["node", "--test", "test/render.test.mjs"]  // a command to run after the chunk (optional, no shell)
// } ],
//   "after": ["npx", "tsc", "--noEmit"]   // optional: ONE project-wide check run once after all chunks (fast for TS)
// }  Each chunk may carry "req": ["FR-KS-010"] to tie it to a requirement; the run log records it.
// Works the same on Windows and macOS: Node only, no shell, file URLs from pathToFileURL, LF/CRLF preserved.
//   IS_WORKER_PROJECT=<dir> IS_WORKER_API_KEY=… node scripts/chunks.mjs [--spec .is-worker/chunks.json] [--verbose]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { IS_WORKER_DIR, WORK_ROOT } from "../lib/paths.mjs";
import { FILES_SCHEMA, parseFiles } from "../lib/schema.mjs";
import { DEFAULTS, armConfig } from "../lib/settings.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta } from "../lib/runs.mjs";
import { appendJsonl } from "../lib/jsonl.mjs";
import { createLimiter } from "../lib/limiter.mjs";

export const CONTEXT_BUDGET_CHARS = 60000; // ~15k tokens per call: keeps prefill fast on one L40S

// Region helpers. A region is the text from the first `start` match through the first `end` match after it.
export function findRegion(text, region) {
  if (!region) return { from: 0, to: text.length };
  const i = text.indexOf(region.start);
  if (i < 0) return { error: `region start not found: ${JSON.stringify(region.start.slice(0, 60))}` };
  if (text.indexOf(region.start, i + 1) >= 0) return { error: `region start is not unique: ${JSON.stringify(region.start.slice(0, 60))}` };
  if (!region.end) return { from: i, to: text.length };
  const j = text.indexOf(region.end, i + region.start.length);
  if (j < 0) return { error: `region end not found after start: ${JSON.stringify(region.end.slice(0, 60))}` };
  return { from: i, to: j + region.end.length };
}

// "path" or "path:10-40" → that text, numbered, for qwen to read.
export function contextSlice(project, ref) {
  const m = String(ref).match(/^(.*?)(?::(\d+)-(\d+))?$/);
  const p = resolve(project, m[1]);
  if (!existsSync(p)) return `=== ${m[1]} (missing) ===`;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const a = m[2] ? Math.max(1, +m[2]) : 1, b = m[3] ? Math.min(lines.length, +m[3]) : lines.length;
  return `=== ${m[1]}${m[2] ? `:${a}-${b}` : ""} ===\n${lines.slice(a - 1, b).join("\n")}`;
}

const BROWSER = /\b(document|window|localStorage|sessionStorage|navigator|location|HTMLElement|requestAnimationFrame|matchMedia|AudioContext|Image|alert|confirm|prompt)\b is not defined/;

// Checks after a chunk is applied: syntax, import (browser-only modules pass), expressions, an optional command.
export function checkChunk(project, chunk) {
  const file = resolve(project, chunk.file);
  const problems = [];
  if (/\.m?js$/.test(file)) {
    const syn = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (syn.status !== 0) problems.push(`syntax: ${(syn.stderr.split(/\r?\n/).find((l) => /Error/.test(l)) || "").trim()}`);
    if (!problems.length) {
      const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}).catch((e) => ({ __err: String(e && e.message || e) }));
const out = { err: m.__err || null, fails: [] };
if (!m.__err) for (const t of ${JSON.stringify(chunk.checks || [])}) {
  try { if (!(await (0, eval)("(async (m) => (" + t + "))")(m))) out.fails.push(t + " (false)"); }
  catch (e) { out.fails.push(t + " (" + String(e && e.message || e).slice(0, 160) + ")"); }
}
console.log("@@" + JSON.stringify(out));`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: project, encoding: "utf8", timeout: 30000 });
      let o; try { o = JSON.parse((r.stdout.split("@@")[1] || "").trim()); } catch { o = { err: (r.stderr || "check did not run").split(/\r?\n/)[0], fails: [] }; }
      if (o.err && !BROWSER.test(o.err)) problems.push(`import: ${o.err}`);
      if (o.err && BROWSER.test(o.err) && (chunk.checks || []).length) problems.push(`checks need a browser (${o.err}); move them to "run" or test a pure module`);
      for (const f of o.fails || []) problems.push(`check failed: ${f}`);
    }
  }
  if (!problems.length && Array.isArray(chunk.run) && chunk.run.length) {
    const [cmd, ...rest] = chunk.run;
    // Windows: npx, npm, tsc are .cmd shims that only start through the shell; node runs directly on both systems.
    const r = spawnSync(cmd === "node" ? process.execPath : cmd, rest, { cwd: project, encoding: "utf8", timeout: DEFAULTS.test_timeout_s * 1000, shell: process.platform === "win32" && cmd !== "node" });
    if (r.status !== 0) problems.push(`run failed: ${chunk.run.join(" ")}\n${String(r.stdout + r.stderr).split(/\r?\n/).filter((l) => /fail|error|assert|expected|✖/i.test(l)).slice(0, 8).join("\n")}`);
  }
  return problems;
}

export function validateSpec(spec, project) {
  const errs = [];
  if (!Array.isArray(spec?.chunks) || !spec.chunks.length) return ["chunks.json needs a non-empty chunks list"];
  const ids = new Set();
  for (const [i, c] of spec.chunks.entries()) {
    const at = `chunk ${c.id || i + 1}`;
    if (!c.file || !c.task) errs.push(`${at}: needs file and task`);
    if (c.id) { if (ids.has(c.id)) errs.push(`${at}: duplicate id`); ids.add(c.id); }
    if (c.region && existsSync(resolve(project, c.file))) { const r = findRegion(readFileSync(resolve(project, c.file), "utf8"), c.region); if (r.error) errs.push(`${at}: ${r.error}`); }
    if (c.region && !existsSync(resolve(project, c.file))) errs.push(`${at}: region given but ${c.file} does not exist`);
    const size = (c.context || []).reduce((a, ref) => a + contextSlice(project, ref).length, 0);
    if (size > CONTEXT_BUDGET_CHARS) errs.push(`${at}: context is ${Math.round(size / 1000)}k chars; keep it under ${CONTEXT_BUDGET_CHARS / 1000}k (use line ranges)`);
  }
  return errs;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
  const key = process.env.IS_WORKER_API_KEY || process.env.INDICSTACK_API_KEY;
  if (!key) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
  const project = WORK_ROOT || process.cwd();
  const specPath = resolve(String(args.spec || resolve(IS_WORKER_DIR, "chunks.json")));
  if (!existsSync(specPath)) { console.error(`no chunk spec at ${specPath}`); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const bad = validateSpec(spec, project);
  if (bad.length) { console.error(`chunks.json rejected before any worker call:\n  ${bad.join("\n  ")}`); process.exit(2); }
  const verbose = Boolean(args.verbose);
  const cfg = armConfig("A");
  const run = newRunDir("A", "expand");
  const p0 = runPaths(run.dir);
  writeMeta(run.dir, { id: run.id, arm: "A", mode: cfg.mode, kind: "expand", route: "chunks", model: cfg.model, baseUrl: cfg.baseUrl, concurrency: cfg.concurrency, started: new Date().toISOString(), status: "running", ticketsTotal: spec.chunks.length, goal: spec.goal || "" });
  const log = (m) => { if (verbose) console.log(m); appendJsonl(p0.log.replace(/\.log$/, ".events.jsonl"), { ts: new Date().toISOString(), msg: m }); };
  const limiter = createLimiter({ start: cfg.concurrency || 4, max: cfg.concurrency || 4, cleanMultiplier: DEFAULTS.aimd_clean_multiplier });
  const system = [
    "You edit one region of one source file. You are given the goal, the task for this region, read-only context, and the region's current text (or a note that the file is new).",
    "Return the complete new text for that region only: keep everything the task does not ask you to change, keep the surrounding code's style and line endings, and use only identifiers the context shows or the standard library provides.",
    'Output only a JSON object {"files":[{"path":"<the file path>","content":"<new region text>"}]}. No prose, no markdown fences.',
  ].join("\n");
  async function ask(user, temperature) {
    await limiter.acquire();
    const t0 = performance.now();
    try {
      const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: cfg.model, temperature, max_tokens: DEFAULTS.first_run_answer_tokens * 4, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: FILES_SCHEMA }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
      const j = await r.json();
      limiter.release(r.ok && !j.error ? "clean" : "other");
      return { ok: r.ok && !j.error, text: j.choices?.[0]?.message?.content || "", error: j.error ? JSON.stringify(j.error).slice(0, 200) : null, seconds: (performance.now() - t0) / 1000, usage: j.usage || {} };
    } catch (e) { limiter.release("other"); return { ok: false, text: "", error: String(e.message || e), seconds: (performance.now() - t0) / 1000, usage: {} }; }
  }
  // Chunks that touch the same file run in order (each sees the previous result); different files run in parallel.
  const byFile = new Map();
  for (const c of spec.chunks) byFile.set(c.file, [...(byFile.get(c.file) || []), c]);
  let ok = 0, first = 0, id = 0;
  const failed = [];
  await Promise.all([...byFile.values()].map(async (list) => {
    for (const c of list) {
      const tid = ++id, file = resolve(project, c.file), rel = c.file.replace(/\\/g, "/");
      const original = existsSync(file) ? readFileSync(file, "utf8") : null;
      const eol = original && original.includes("\r\n") ? "\r\n" : "\n";
      const region = original == null ? { from: 0, to: 0 } : findRegion(original, c.region);
      if (region.error) { failed.push({ c, problems: [region.error], candidate: null }); continue; }
      const current = original == null ? "" : original.slice(region.from, region.to);
      const ctx = (c.context || []).map((r) => contextSlice(project, r)).join("\n\n");
      const base = [`GOAL: ${spec.goal || "(see task)"}`, ctx, `TASK for ${rel}${c.region ? " (one region)" : ""}: ${c.task}`,
        original == null ? `=== ${rel} is a new file: write all of it ===` : `=== current text of the region in ${rel} ===\n${current}`,
        (c.checks || []).length ? `It must satisfy (m is the module): ${c.checks.join(" ; ")}` : ""].filter(Boolean).join("\n\n");
      const apply = (txt) => {
        const t = eol === "\r\n" ? txt.replace(/\r?\n/g, "\r\n") : txt.replace(/\r\n/g, "\n");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, original == null ? t : original.slice(0, region.from) + t + original.slice(region.to));
      };
      const attempt = async (user, temp, n) => {
        const r = await ask(user, temp);
        const parsed = r.ok ? parseFiles(r.text) : { ok: false, error: r.error };
        appendJsonl(p0.calls, { ts: new Date().toISOString(), stage: "worker", arm: "A", ticket: tid, attempt: n, temperature: temp, kind: r.ok ? (parsed.ok ? "ok" : "bad_json") : "http_error", seconds: +r.seconds.toFixed(3), prompt_tokens: r.usage.prompt_tokens ?? null, completion_tokens: r.usage.completion_tokens ?? null, cost: Number.isFinite(r.usage.cost) ? r.usage.cost : null });
        if (!parsed.ok) return { txt: null, problems: [`answer was not valid: ${parsed.error}`] };
        const txt = parsed.files[0].content;
        apply(txt);
        return { txt, problems: checkChunk(project, c) };
      };
      let best = await attempt(base, 0, 1);
      if (!best.problems.length) { ok++; first++; log(`${rel} [${c.id || tid}]: ok`); appendJsonl(p0.tickets, { ts: new Date().toISOString(), ticket: tid, path: rel, chunk: c.id || null, req: c.req || null, status: "ok", attempts: 1 }); continue; }
      const cands = await Promise.all([0.3, 0.6, 0.9].map((t) => attempt(`${base}\n\n[previous attempt failed] ${best.problems.join("; ")}`, t, 2)));
      const win = cands.find((x) => x.txt != null && !x.problems.length);
      if (win) { apply(win.txt); ok++; log(`${rel} [${c.id || tid}]: ok on retry`); appendJsonl(p0.tickets, { ts: new Date().toISOString(), ticket: tid, path: rel, chunk: c.id || null, req: c.req || null, status: "ok", attempts: 2 }); continue; }
      for (const x of cands) if (x.txt != null && x.problems.length < best.problems.length) best = x;
      if (original == null) writeFileSync(file, ""); else writeFileSync(file, original); // revert: the repo stays as Opus left it
      failed.push({ c, problems: best.problems, candidate: best.txt });
      appendJsonl(p0.tickets, { ts: new Date().toISOString(), ticket: tid, path: rel, chunk: c.id || null, req: c.req || null, status: "queued", attempts: 2, error: best.problems[0] || "failed" });
    }
  }));
  // One project-wide check after every chunk (e.g. tsc or the whole test suite): far faster than one per chunk.
  let afterFail = null;
  if (Array.isArray(spec.after) && spec.after.length) {
    const [cmd, ...rest] = spec.after;
    const r = spawnSync(cmd === "node" ? process.execPath : cmd, rest, { cwd: project, encoding: "utf8", timeout: DEFAULTS.test_timeout_s * 4000, shell: process.platform === "win32" && cmd !== "node" });
    if (r.status !== 0) afterFail = `${spec.after.join(" ")} failed after all chunks were applied:\n${String(r.stdout + r.stderr).split(/\r?\n/).filter((l) => /error|fail|assert|✖/i.test(l)).slice(0, 15).join("\n")}`;
  }
  const fp = resolve(IS_WORKER_DIR, "chunks-failed.md");
  if (failed.length || afterFail) {
    writeFileSync(fp, (afterFail ? `# Project check failed (chunks are applied; fix the errors below)\n\n${afterFail}\n\n` : "") + ["# Chunks the worker could not finish (files reverted; fix these yourself)", "",
      ...failed.flatMap(({ c, problems, candidate }) => [`## ${c.id || c.file} — ${c.file}`, `Task: ${c.task}`, `Problems:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        candidate ? `Closest candidate for the region:\n\`\`\`\n${candidate.slice(0, 4000)}\n\`\`\`` : "", ""])].join("\n"));
  } else if (existsSync(fp)) writeFileSync(fp, "");
  updateMeta(run.dir, { status: failed.length ? "needs_claude" : "done", finished: new Date().toISOString(), testsFinal: { pass: ok, fail: failed.length }, firstTry: first });
  console.log(`chunks: qwen finished ${ok}/${spec.chunks.length} (${first} first try)${failed.length ? `; ${failed.length} reverted and described in ${relative(project, fp).replace(/\\/g, "/")}` : ""}${afterFail ? `; project check failed (see ${relative(project, fp).replace(/\\/g, "/")})` : ""}`);
  if (failed.length || afterFail) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
