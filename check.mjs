// Writes the worker's files (only to paths the ticket allows), syntax-checks them, runs the ticket's test.
// As a module: applyAndCheck(). As a CLI (arm B and queued tickets):
//   node check.mjs --run runs/<id> --ticket N --files out.json [--usage-in N --usage-out N] [--attempt K]
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadBrief } from "./lib/brief.mjs";
import { TESTS_BASE, WORK_ROOT } from "./lib/paths.mjs";
import { loadTickets } from "./lib/prompt.mjs";
import { DEFAULTS } from "./lib/settings.mjs";
import { runPaths, updateMeta, readMeta } from "./lib/runs.mjs";
import { appendJsonl, latestByKey } from "./lib/jsonl.mjs";

export function syntaxCheck(absPath) {
  if (absPath.endsWith(".mjs") || absPath.endsWith(".js")) {
    const r = spawnSync(process.execPath, ["--check", absPath], { encoding: "utf8" });
    return r.status === 0 ? null : (r.stderr || r.stdout).trim();
  }
  if (absPath.endsWith(".html")) {
    const html = readFileSync(absPath, "utf8");
    // The <canvas> requirement is the Flappy bench's; project mode only needs a parseable-looking page.
    if (process.env.IS_WORKER_PROJECT) return /<html\b|<!doctype html>/i.test(html) ? null : "html file has no <html> or <!doctype html>";
    if (!/<canvas\b/.test(html)) return "index.html has no <canvas>";
    return null;
  }
  return null;
}

export function runTest(testRel, workDir, timeoutS = DEFAULTS.test_timeout_s) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", resolve(TESTS_BASE, testRel)], {
    cwd: WORK_ROOT || ROOT, encoding: "utf8", timeout: timeoutS * 1000,
    env: { ...process.env, IS_WORKER_WORK: workDir, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: undefined, FORCE_COLOR: undefined, NO_COLOR: "1" },
  });
  const out = ((r.stdout || "") + (r.stderr || "")).replace(/\x1b\[[0-9;]*m/g, "");
  const count = (name) => Number((out.match(new RegExp(`^(?:# |\\u2139 )${name} (\\d+)`, "m")) || [])[1] ?? 0);
  const pass = count("pass"), fail = count("fail");
  const noTests = pass === 0 && fail === 0;
  return { ok: r.status === 0 && fail === 0 && !r.error && !noTests, pass, fail, output: (noTests ? "no tests ran\n" : "") + out.slice(-6000), timedOut: Boolean(r.error) };
}

// files: [{path, content}] from the worker. Returns { ok, error, test }.
export function applyAndCheck({ runDir, ticket, files, attempt, alsoTests = [] }) {
  const p = runPaths(runDir);
  const outDir = resolve(p.outputs, `t${ticket.id}-attempt${attempt}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "worker.json"), JSON.stringify({ files }, null, 2));
  for (const f of files) {
    const norm = f.path.replace(/^\.\//, "");
    if (!ticket.writes.includes(norm)) return { ok: false, error: `path not allowed for ticket ${ticket.id}: ${f.path} (allowed: ${ticket.writes.join(", ")})` };
    const abs = resolve(p.work, norm);
    if (relative(p.work, abs).startsWith("..")) return { ok: false, error: `path escapes work dir: ${f.path}` };
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    writeFileSync(resolve(outDir, norm.replace(/\//g, "__")), f.content);
  }
  const written = new Set(files.map((f) => f.path.replace(/^\.\//, "")));
  for (const w of ticket.writes) if (!written.has(w)) return { ok: false, error: `ticket requires file ${w} but the answer did not include it` };
  // harness-owned constants are always present in the work dir
  if (!WORK_ROOT) { const constSrc = resolve(ROOT, "game/constants.mjs"), constDst = resolve(p.work, "game/constants.mjs"); if (existsSync(constSrc) && !existsSync(constDst)) copyFileSync(constSrc, constDst); }
  for (const w of ticket.writes) {
    const err = syntaxCheck(resolve(p.work, w));
    if (err) return { ok: false, error: `syntax check failed for ${w}:\n${err}` };
  }
  const test = runTest(ticket.test, p.work);
  writeFileSync(resolve(outDir, "test.txt"), test.output);
  if (!test.ok) return { ok: false, error: `tests: ${test.pass} passed, ${test.fail} failed${test.timedOut ? " (timed out)" : ""}\n${test.output}`, test };
  // regression check (round 2): every earlier passed ticket's tests must still pass
  for (const other of alsoTests) {
    const r = runTest(other, p.work);
    if (!r.ok) return { ok: false, error: `regression: ${other} now fails after this ticket (${r.pass} passed, ${r.fail} failed)\n${r.output}`, test: r };
  }
  return { ok: true, test };
}

export function recordTicket(runDir, row) {
  appendJsonl(runPaths(runDir).tickets, { ts: new Date().toISOString(), ...row });
}
export function enqueueForClaude(runDir, ticket, reason) {
  appendJsonl(runPaths(runDir).queue, { ts: new Date().toISOString(), ticket: ticket.id, title: ticket.title, writes: ticket.writes, test: ticket.test, reason: reason.slice(0, 4000) });
}

// Final count across all tickets' tests (used for the results table).
export function finalTestCount(runDir) {
  const p = runPaths(runDir);
  let pass = 0, fail = 0;
  for (const t of loadTickets()) { const r = runTest(t.test, p.work); pass += r.pass; fail += r.fail; }
  return { pass, fail };
}

function cli() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length));
  if (!args.run || !args.ticket || !args.files) { console.error("usage: node check.mjs --run runs/<id> --ticket N --files out.json [--usage-in N --usage-out N] [--note text]"); process.exit(2); }
  loadBrief();
  const runDir = resolve(ROOT, args.run);
  const ticket = loadTickets().find((t) => t.id === Number(args.ticket));
  if (!ticket) { console.error(`no ticket ${args.ticket}`); process.exit(2); }
  const prev = latestByKey(runPaths(runDir).tickets, (r) => r.ticket).get(ticket.id);
  const attempt = (prev?.attempts || 0) + 1;
  const { files } = JSON.parse(readFileSync(resolve(args.files), "utf8"));
  const meta = readMeta(runDir) || {};
  const r = applyAndCheck({ runDir, ticket, files, attempt });
  appendJsonl(runPaths(runDir).calls, {
    ts: new Date().toISOString(), stage: "worker", arm: meta.arm, ticket: ticket.id, attempt, kind: r.ok ? "ok" : "check_failed",
    source: meta.mode === "claude" ? "claude_session" : "manual", seconds: null,
    prompt_tokens: Number(args["usage-in"]) || 0, completion_tokens: Number(args["usage-out"]) || 0, reasoning_tokens: 0, note: args.note || null,
  });
  recordTicket(runDir, { ticket: ticket.id, status: r.ok ? "ok" : "failed", attempts: attempt, error: r.ok ? null : r.error.slice(0, 2000), tests_pass: r.test?.pass ?? null, tests_fail: r.test?.fail ?? null });
  if (r.ok) {
    const all = latestByKey(runPaths(runDir).tickets, (x) => x.ticket);
    const done = loadTickets().every((t) => all.get(t.id)?.status === "ok");
    if (done) updateMeta(runDir, { status: "done", finished: meta.finished || new Date().toISOString(), testsFinal: finalTestCount(runDir) });
  }
  console.log(r.ok ? `ticket ${ticket.id} OK (${r.test.pass} tests)` : `ticket ${ticket.id} FAILED attempt ${attempt}:\n${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "check.mjs")) cli();
