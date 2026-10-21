// /is-worker orchestrator: IndicStack-only planner-worker-reviewer for any project.
//   node scripts/is-worker.mjs <cmd> --project <dir> [...]
//   cmds: init [--ide claude|cursor|codex|opencode|antigravity|all] | doctor | status | preflight | run | review [--reviewer claude|codex|opencode|custom|openrouter] [--model m] [--force] [--full] [--gate] | table [--rate INR_PER_USD]
//   doctor exit codes: 0 ready, 3 key missing, 4 key rejected by IndicStack, 5 IndicStack unreachable, 6 selected reviewer CLI not found
//   The reviewer is also picked by IS_WORKER_REVIEWER; "custom" runs the IS_WORKER_REVIEW_CMD template, "openrouter" calls the API (see lib/reviewer.mjs).
//   review is typed by default (0.8.0): the reviewer answers the planner's cross-file checklist statements (plus the
//   per-ticket ones of troubled tickets) over the whole code in one call. --gate first has the worker model judge every
//   statement and close the confident ones (0.8.0–0.8.2 default; 36 s of qwen for little gain). --full is the pre-0.8.0
//   prose review of the diff.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

// HOME is computed here, not imported from lib/paths.mjs: that module reads IS_WORKER_PROJECT when first loaded, and it
// must see the --project value set below. Every lib module is therefore imported lazily (await import) after that line.
const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = Object.fromEntries(process.argv.slice(3).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const cmd = process.argv[2];
const project = resolve(String(args.project || process.env.IS_WORKER_PROJECT || process.cwd()));
process.env.IS_WORKER_PROJECT = project; // so in-process lib imports (settings, runs, paths) see the same project the child scripts get via env
const pwr = resolve(project, ".is-worker");
// One-time migration: project folders created before 12 Oct 2026 used <project>/.pwr
if (!existsSync(pwr) && existsSync(resolve(project, ".pwr"))) { (await import("node:fs")).renameSync(resolve(project, ".pwr"), pwr); console.log(".pwr/ renamed to .is-worker/"); }
const env = { ...process.env, IS_WORKER_PROJECT: project };
const node = (script, extra = [], opts = {}) => spawnSync(process.execPath, [resolve(HOME, script), ...extra], { cwd: HOME, encoding: "utf8", env: { ...env, ...(opts.env || {}) }, stdio: opts.quiet ? "pipe" : "inherit", maxBuffer: 50e6 });
const say = (m) => console.log(m);
const die = (m) => { console.error(m); process.exit(2); };
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
// One line from a child's failure output: the line that names the problem, never a stack frame.
const firstError = (out) => { const lines = String(out || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean); return lines.find((l) => /Error:|^(no |review folder|PROMPT-REVIEW|usage:)/.test(l)) || lines.find((l) => !/^(at |node:|Node\.js v|\^+$)/.test(l)) || "failed"; };

async function keyFor() {
  const { keyFor } = await import("../lib/keys.mjs");
  return process.env.INDICSTACK_API_KEY || keyFor("A");
}
function listRuns() { const d = resolve(pwr, "runs"); return existsSync(d) ? readdirSync(d).filter((n) => existsSync(resolve(d, n, "meta.json"))).sort() : []; }
function lastRun() { const r = listRuns().filter((n) => /-A(-\d+)?$/.test(n)); return r.length ? resolve(pwr, "runs", r.at(-1)) : null; }
// The run `review` and `table` work on: --run <dir> if given, else the latest. Fails in one line that says where it looked and what to do.
function pickRun() {
  const run = args.run ? resolve(String(args.run)) : lastRun();
  if (!run || !existsSync(resolve(run, "meta.json"))) die(`no run found${args.run ? ` at ${run} (no meta.json there)` : ` under ${resolve(pwr, "runs")}`}. Run \`node "${resolve(HOME, "scripts/is-worker.mjs")}" run --project ${project}\` first, or pass --run ${resolve(pwr, "runs")}/<id>`);
  return run;
}

// The connection check. Prints one banner line first so a human and Claude both see the state at a glance.
async function doctor() {
  const { selectedReviewer, reviewerStatus } = await import("../lib/reviewer.mjs");
  const { armConfig } = await import("../lib/settings.mjs");
  const cfg = armConfig("A");
  const lines = [];
  let code = 0;
  lines.push(`node: ${process.versions.node} (${process.platform})`);
  // One line per reviewer CLI (claude, codex, opencode; custom only when selected). Only the selected one can set
  // DEGRADED, and only after the key checks below, so a missing key is never hidden behind a missing reviewer.
  let selected; try { selected = selectedReviewer(args.reviewer); } catch (e) { die(e.message); }
  let reviewerMissing = false;
  for (const s of reviewerStatus(selected)) {
    if (s.name === "custom" && !s.selected) continue;
    const found = s.bin ? (s.name === "custom" ? "IS_WORKER_REVIEW_CMD set" : s.bin) : s.name === "custom" ? "IS_WORKER_REVIEW_CMD not set (blind reviews will not run)" : s.name === "openrouter" ? `no key${s.selected ? " (blind reviews will not run)" : ""}` : s.selected ? "NOT FOUND (blind reviews will not run)" : "not found";
    lines.push(`reviewer ${s.name}${s.selected ? " (selected)" : ""}: ${found}`);
    if (s.selected && !s.bin) reviewerMissing = true;
  }
  const key = await keyFor();
  const { keyStatus } = await import("../lib/keys.mjs");
  const ks = keyStatus();
  if (!key) { lines.push(`indicstack key: MISSING (looked in INDICSTACK_API_KEY and ${ks.path})`); code = code || 3; }
  else {
    lines.push(`indicstack key: present (${process.env.INDICSTACK_API_KEY ? "env INDICSTACK_API_KEY" : ks.path + ", mode " + ks.mode}), length ${key.length}`);
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal });
      clearTimeout(t);
      const body = await r.text().catch(() => "");
      if (r.status === 200) { let n = "?"; try { n = JSON.parse(body).data.length; } catch {} lines.push(`indicstack api: connected (${cfg.baseUrl}, ${n} models listed, model ${cfg.model})`); }
      else if (r.status === 401 || r.status === 403) { lines.push(`indicstack api: KEY REJECTED (HTTP ${r.status}: ${body.slice(0, 120)})`); code = code || 4; }
      else { lines.push(`indicstack api: HTTP ${r.status} from ${cfg.baseUrl} (${body.slice(0, 120)})`); code = code || 5; }
    } catch (e) { lines.push(`indicstack api: UNREACHABLE (${e?.cause?.code || e?.message || e})`); code = code || 5; }
  }
  if (reviewerMissing) code = code || 6;
  const probe = readJson(resolve(pwr, "state", "probe-A.json"));
  lines.push(`probe: ${probe ? `window ${probe.context_window} (${probe.at.slice(0, 16)})` : "none yet (preflight runs it)"}`);
  const banner = code === 0 ? "IS-WORKER: READY — IndicStack connected; the worker will write the code."
    : code === 3 ? "IS-WORKER: NOT CONNECTED — no IndicStack key. Nothing may be planned or coded until it is saved."
    : code === 4 ? "IS-WORKER: NOT CONNECTED — IndicStack rejected the key. Save the correct key before anything else."
    : code === 5 ? "IS-WORKER: NOT CONNECTED — IndicStack unreachable. Check the network or ask ops; do not fall back to Claude writing the code."
    : `IS-WORKER: DEGRADED — reviewer "${selected}" ${selected === "custom" ? "has no IS_WORKER_REVIEW_CMD" : selected === "openrouter" ? "has no key (OPENROUTER_API_KEY or IS_WORKER_KEY_C)" : "CLI not found"}; runs work, blind reviews will not (pick another with --reviewer claude|codex|opencode|custom|openrouter).`;
  say(banner); for (const l of lines) say("  " + l);
  if (code === 3 || code === 4) say(`\nTo save the key, run this in your own terminal (hidden input), then say "saved":\n  node "${resolve(HOME, "scripts", "key.mjs")}"`);
  process.exit(code);
}

async function status() {
  const brief = existsSync(resolve(pwr, "BRIEF.md"));
  const frozen = brief && /^SHA-256: [0-9a-f]{64}/m.test(readFileSync(resolve(pwr, "BRIEF.md"), "utf8"));
  const tickets = existsSync(resolve(pwr, "tickets.jsonl")) ? readFileSync(resolve(pwr, "tickets.jsonl"), "utf8").trim().split("\n").filter(Boolean).length : 0;
  const key = Boolean(await keyFor());
  const probe = readJson(resolve(pwr, "state", "probe-A.json"));
  const cal = readJson(resolve(pwr, "state", "calibration-A.json"));
  const run = lastRun();
  const meta = run ? readJson(resolve(run, "meta.json")) : null;
  say(`project: ${project}`);
  say(`brief: ${brief ? (frozen ? "frozen" : "NOT frozen") : "missing"} | tickets: ${tickets} | key: ${key ? "saved" : "MISSING"} | probe: ${probe ? `window ${probe.context_window} (${probe.at.slice(0, 10)})` : "none"} | calibration: ${cal ? `${cal.n_ok}/${cal.n} ok, ${cal.speed_tps_p10?.toFixed(1)} tok/s p10 (${cal.at.slice(0, 10)})` : "none"}`);
  say(`last run: ${run ? `${run.split("/").pop()} ${meta.status} tests ${JSON.stringify(meta.testsFinal || null)} review ${meta.reviewVerdict || "none"}` : "none"}`);
}

async function requireConnected() {
  const r = node("scripts/is-worker.mjs", ["doctor", "--project", project, ...(args.reviewer ? ["--reviewer", String(args.reviewer)] : [])], { quiet: true });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0 && r.status !== 6) die(`refusing to continue: not connected (doctor exit ${r.status})`);
}

async function preflight() {
  await requireConnected();
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) die(`Node ${process.versions.node} is too old; install Node 18 or later.`);
  mkdirSync(resolve(pwr, "state"), { recursive: true });
  const gi = resolve(project, ".gitignore"); const want = [".is-worker/runs/", ".is-worker/state/"];
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = want.filter((l) => !cur.split("\n").includes(l));
  if (missing.length) { writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n"); say(`.gitignore: added ${missing.join(", ")}`); }
  const key = await keyFor();
  if (!key) die(`No IndicStack key. Run once in your terminal:\n  node ${resolve(HOME, "scripts/key.mjs")}\n(or set INDICSTACK_API_KEY). Never paste the key into chat.`);
  const r0 = node("lib/brief.mjs", [], { quiet: true });
  const check = spawnSync(process.execPath, ["-e", "import('./lib/brief.mjs').then(m=>{m.loadBrief();console.log('ok')})"], { cwd: HOME, encoding: "utf8", env });
  if (!/ok/.test(check.stdout)) die(`brief problem: ${firstError(check.stderr)}`);
  if (!existsSync(resolve(pwr, "tickets.jsonl"))) die("no .is-worker/tickets.jsonl");
  const probe = readJson(resolve(pwr, "state", "probe-A.json"));
  const fresh = probe && Date.now() - new Date(probe.at) < 24 * 3600 * 1000;
  if (!fresh) { say("probe: running (one call + max_tokens ladder)"); const r = node("probe.mjs", ["--arm", "A"], { env: { IS_WORKER_API_KEY: key } }); if (r.status !== 0) die("probe failed"); } else say(`probe: fresh (${probe.at.slice(0, 16)}, window ${probe.context_window})`);
  const cal = readJson(resolve(pwr, "state", "calibration-A.json"));
  const model = (await import("../lib/settings.mjs")).armConfig("A").model;
  if (args.calibrate) { const n = Number(args.calls || 48); say(`calibration: running ${n} calls for ${model}`); const r = node("calibrate.mjs", ["--arm", "A", "--calls", String(n)], { env: { IS_WORKER_API_KEY: key } }); if (r.status !== 0) die("calibration failed"); }
  else say(cal && cal.model === model ? `calibration: from ${cal.source || "calibration run"} ${cal.at.slice(0, 16)} (${cal.n_measured ?? cal.n_ok} calls)` : "calibration: none yet; first run uses defaults and then calibrates itself from its own calls");
  say("preflight ok");
}

async function run() {
  await requireConnected();
  const key = await keyFor(); if (!key) die("no key");
  const r = node("worker.mjs", ["--arm", "A", ...(args.resume ? ["--run", String(args.resume)] : [])], { env: { IS_WORKER_API_KEY: key } });
  if (r.status === 75) die("credit breaker tripped: 6 consecutive 429s. Top up, then rerun with --resume <run dir>.");
  if (r.status !== 0) die(`worker exited ${r.status}`);
  const meta = readJson(resolve(lastRun(), "meta.json"));
  say(`run ${meta.id}: ${meta.status}, final tests ${JSON.stringify(meta.testsFinal)}`);
  // self-calibration: recompute speed, chars/token and answer budgets from this run's own calls
  const rc = node("calibrate.mjs", ["--arm", "A", "--recompute", lastRun(), "--source", `run ${meta.id}`], { env: { IS_WORKER_API_KEY: key }, quiet: true });
  say(rc.status === 0 ? "calibration updated from this run" : `calibration not updated: ${(rc.stderr || rc.stdout).slice(0, 200)}`);
  if (meta.status === "needs_claude") say(`tickets queued for the planner: see ${resolve(lastRun(), "claude-queue.jsonl")}. If a test was wrong, fix the test, then resume (re-runs only the queued tickets): node ${resolve(HOME, "scripts", "is-worker.mjs")} run --project ${project} --resume ${lastRun()}. Write code yourself only for a ticket the worker still fails after resume: node ${resolve(HOME, "check.mjs")} --run ${lastRun()} --ticket N --files '[{"path":"…","content":"…"}]' (IS_WORKER_PROJECT set).`);
}

async function review() {
  const run = pickRun();
  const { runReview, selectedReviewer } = await import("../lib/reviewer.mjs");
  const { summarize, updateMeta } = await import("../lib/runs.mjs");
  const { DEFAULTS } = await import("../lib/settings.mjs");
  let name; try { name = selectedReviewer(args.reviewer); } catch (e) { die(e.message); }
  const s = summarize(run);
  const mode = args.full ? "full" : "typed";
  const model = args.model ? String(args.model) : DEFAULTS.review_models?.[name]?.[mode] ?? null; // CLIs without an entry use their own default
  const unavailable = () => say("review unavailable: the tests already checked every ticket. Do NOT review by hand or with a subagent, and do not start a new brief or milestone from your own reading; show the table and stop.");
  const record = (r, extra) => { const u = r.usage; updateMeta(run, { reviewer: name, reviewerModel: model, reviewMode: mode, reviewUsage: { input: u?.input ?? null, cache_write: u?.cache_write ?? null, cache_read: u?.cache_read ?? null, output: u?.output ?? null, cost_usd: u?.cost_usd ?? null, seconds: r.seconds, model: u?.model || model }, ...extra }); };

  if (mode === "typed") {
    // Same one-line brief checks make-review.mjs does, before any call is made.
    const { BRIEF_PATH, loadBrief } = await import("../lib/brief.mjs");
    if (!existsSync(BRIEF_PATH)) die(`review folder not built: no brief at ${BRIEF_PATH}`);
    try { loadBrief(); } catch (e) { die(`review folder not built: ${e.message}`); }
    // 1. Pick the statements. Default: every cross-file statement plus the per-ticket statements of troubled tickets, no
    //    worker-model calls. --gate: the worker model judges every statement first and closes the confident ones.
    let g;
    if (args.gate) {
      const key = await keyFor();
      if (!key) die("no IndicStack key: --gate runs on the worker model. Save the key (doctor says how), or drop --gate.");
      say(`review (typed, gated): ${s.model} judges every statement, then ${name}${model ? ` (model ${model})` : ""} answers the open ones`);
      g = node("review/typed-gate.mjs", ["--run", run], { env: { IS_WORKER_API_KEY: key } });
    } else {
      say(`review (typed): ${name}${model ? ` (model ${model})` : ""} answers the cross-file statements${s.tickets_troubled.length ? ` and ticket ${s.tickets_troubled.join(", ")}'s own` : ""} in one call`);
      g = node("review/typed-gate.mjs", ["--run", run, "--no-gate", ...(s.tickets_troubled.length ? ["--troubled", s.tickets_troubled.join(",")] : [])]);
    }
    if (g.status !== 0) die("statement selection failed (see above). Pass --full for the prose review.");
    const gate = readJson(resolve(run, "typed-gate.json"));
    if (!gate.open) {
      const verdict = `PASS — 0 findings (${gate.closed} statements closed by ${s.model}, nothing open)`;
      updateMeta(run, { reviewer: name, reviewerModel: model, reviewMode: mode, reviewVerdict: verdict, reviewerCorrections: 0, reviewUsage: { input: 0, cache_write: 0, cache_read: 0, output: 0, cost_usd: 0, seconds: 0, model } });
      say(`verdict: ${verdict}`); return;
    }
    // 2. One blind call over every file the open statements touch; the reviewer answers each statement as JSON.
    const mk = node("review/make-review.mjs", ["--run", run, "--typed"], { quiet: true });
    if (mk.status !== 0) die(`review folder not built: ${firstError(mk.stderr || mk.stdout)}`);
    const meta = readJson(resolve(run, "meta.json"));
    say(`review folder: ${meta.reviewFolder}`);
    const r = await runReview({ name, folder: meta.reviewFolder, model, mode, maxTokens: DEFAULTS.review_answer_max_tokens });
    if (r.skipped) { say(`review skipped: ${r.reason}. Install it, or choose another with --reviewer claude|codex|opencode|custom|openrouter (or IS_WORKER_REVIEWER).`); updateMeta(run, { reviewer: name, reviewerModel: model, reviewMode: mode, reviewVerdict: r.verdict }); return; }
    if (r.status !== 0) say(`${name} exited ${r.status}${r.error ? ` (${r.error})` : ""}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
    const ansPath = resolve(meta.reviewFolder, "ANSWERS.json");
    if (!existsSync(ansPath)) { unavailable(); record(r, { reviewVerdict: `no ANSWERS.json written (${name} exited ${r.status})`, reviewerCorrections: null }); return; }
    let arr = []; try { const p = JSON.parse(readFileSync(ansPath, "utf8").replace(/```json|```/g, "").trim()); arr = Array.isArray(p) ? p : p.answers || p.results || []; } catch { say("ANSWERS.json is not valid JSON"); }
    const open = gate.items.filter((i) => i.open);
    const findings = [], unanswered = [];
    open.forEach((i, idx) => {
      const a = arr.find((x) => String(x.id) === i.id) || arr[idx];
      if (!a || !/^(YES|NO)$/i.test(String(a.answer))) { unanswered.push(i.id); return; }
      if (/^NO$/i.test(String(a.answer))) findings.push({ id: i.id, file: a.file || i.files.join(", "), line: a.line ?? null, statement: i.text, why: a.why || "" });
    });
    const lines = findings.map((f, n) => `${n + 1}. ${f.file}${f.line != null ? `:${f.line}` : ""} — ${f.why} (statement ${f.id})`);
    writeFileSync(resolve(meta.reviewFolder, "FINDINGS.md"), `# Findings\n\n${lines.join("\n") || "none"}\n${unanswered.length ? `\nUnanswered: ${unanswered.join(", ")}\n` : ""}`);
    const verdict = `${findings.length ? "PASS WITH FINDINGS" : "PASS"} — ${findings.length} findings (${gate.gate ? `${gate.closed} closed by ${s.model}, ` : ""}${open.length} answered by ${name}${unanswered.length ? `, ${unanswered.length} unanswered` : ""})`;
    record(r, { reviewVerdict: verdict, reviewerCorrections: findings.length, typedFindings: findings, typedUnanswered: unanswered });
    for (const l of lines) say("  " + l);
    say(`verdict: ${verdict}`);
    return;
  }

  // --full: the pre-0.8.0 prose review of the diff. Skipped on a clean run; only troubled tickets unless --force.
  const clean = s.tickets_total && s.tickets_passed_first_try === s.tickets_total && s.tests_final && s.tests_final.fail === 0;
  if (clean && !args.force) { say(`review: skipped — clean run (${s.tickets_passed_first_try}/${s.tickets_total} first try, ${s.tests_final.pass} tests green). Pass --force to review anyway.`); return; }
  const only = args.force || !(s.tickets_troubled.length && s.tickets_troubled.length < s.tickets_total) ? [] : ["--tickets", s.tickets_troubled.join(",")];
  if (only.length) say(`review: only tickets ${s.tickets_troubled.join(", ")} (retried or failed). Pass --force to review every ticket.`);
  const mk = node("review/make-review.mjs", ["--run", run, ...only], { quiet: true });
  if (mk.status !== 0) die(`review folder not built: ${firstError(mk.stderr || mk.stdout)}`);
  const meta = readJson(resolve(run, "meta.json"));
  say(`review folder: ${meta.reviewFolder}`);
  say(`reviewer: ${name}${model ? ` (model ${model})` : ""}`);
  const r = await runReview({ name, folder: meta.reviewFolder, model, mode: "full", maxTokens: 16000 });
  if (r.skipped) {
    say(`review skipped: ${r.reason}. Install it, or choose another with --reviewer claude|codex|opencode|custom|openrouter (or IS_WORKER_REVIEWER).`);
    updateMeta(run, { reviewer: name, reviewerModel: model, reviewMode: mode, reviewVerdict: r.verdict });
    return;
  }
  if (r.status !== 0) say(`${name} exited ${r.status}${r.error ? ` (${r.error})` : ""}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  if (r.status !== 0 && !existsSync(resolve(meta.reviewFolder, "REVIEW.md"))) unavailable();
  const text = existsSync(resolve(meta.reviewFolder, "REVIEW.md")) ? readFileSync(resolve(meta.reviewFolder, "REVIEW.md"), "utf8") : "";
  const verdict = (text.match(/^.*\b(PASS WITH FINDINGS|PASS|FAIL)\b.*$/m) || [""])[0].replace(/^[#*\s-]+/, "").trim();
  const count = Number((verdict.match(/(\d+)/) || [])[1]);
  record(r, { reviewVerdict: verdict, reviewerCorrections: Number.isFinite(count) ? count : null });
  say(`verdict: ${verdict || "(no REVIEW.md written)"}`);
}

async function table() {
  const run = pickRun();
  const { summarize, readMeta } = await import("../lib/runs.mjs");
  const s = summarize(run), m = readMeta(run);
  const ru = m.reviewUsage || {};
  const who = m.reviewer ? `${m.reviewer}${m.reviewerModel ? " " + m.reviewerModel : ""}` : "Opus"; // runs before 0.7.0 recorded no reviewer; they were all claude/Opus
  const usageKnown = ru.input != null; // codex, opencode and custom reviewers report no tokens
  let rate = Number(args.rate);
  if (!Number.isFinite(rate) && ru.cost_usd != null) { try { const j = await (await fetch("https://api.frankfurter.app/latest?from=USD&to=INR")).json(); rate = j.rates.INR; say(`rate: ₹${rate}/USD (frankfurter, ${j.date})`); } catch { die("could not fetch USD→INR; pass --rate"); } }
  const workerInr = s.cost ?? 0; // IndicStack reports cost in INR
  // Typed review (0.8.0): the gate's worker-model calls are part of the review cost. IndicStack reports ₹ per call; when a
  // call carries no cost, it is priced at this run's own ₹ per worker token.
  const g = m.typedGate?.usage || null;
  const gateTokens = g ? (g.prompt_tokens || 0) + (g.completion_tokens || 0) : 0;
  const perToken = s.prompt_tokens + s.completion_tokens > 0 ? workerInr / (s.prompt_tokens + s.completion_tokens) : 0;
  const gateInr = g ? (g.calls && g.cost_reported === g.calls ? g.cost : gateTokens * perToken) : 0;
  const frontierInr = ru.cost_usd != null ? ru.cost_usd * rate : null;
  const reviewInr = m.reviewMode === "typed" ? (frontierInr ?? 0) + gateInr : frontierInr;
  const wall = s.wall_s || 0, rs = (ru.seconds || 0) + (g?.wall_seconds || 0);
  const fmt = (n) => Number(n).toLocaleString("en-IN");
  const tok = (v) => (v == null ? "?" : fmt(v));
  const inr = (v) => (v == null ? "?" : `₹${v.toFixed(2)}`);
  const mmss = (sec) => `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  const row = `| ${m.id} (IndicStack ${m.model}) | ${fmt(s.prompt_tokens)} | ${fmt(s.completion_tokens)} | ₹${workerInr.toFixed(2)} | ${usageKnown ? fmt((ru.input || 0) + (ru.cache_write || 0) + (ru.cache_read || 0)) : "?"} | ${tok(ru.output)} | ${inr(reviewInr)} | ${s.tickets_passed_first_try}/${s.tickets_total} | ${s.tests_final ? `${s.tests_final.pass}/${s.tests_final.pass + s.tests_final.fail}` : "?"} | ${m.reviewerCorrections ?? "?"} | **₹${(workerInr + (reviewInr || 0)).toFixed(2)}** | ${mmss(wall + rs)} |`;
  const header = `| Run | Worker tokens in | Worker tokens out | Worker cost | ${who} review tokens in | ${who} review tokens out | ${who} review cost | First try | Final tests | Findings | Total cost | Total time |\n|---|---|---|---|---|---|---|---|---|---|---|---|`;
  let note = "";
  if (m.reviewMode === "typed" && m.typedGate) note = `Typed review: ${m.typedGate.statements} statements${m.typedGate.checklist ? "" : " (generic: no checklist.json)"}, ${m.typedGate.gate ? `${m.typedGate.closed} closed by ${m.model} (${fmt(gateTokens)} tokens, ₹${gateInr.toFixed(2)}, ${Math.round(g?.wall_seconds || 0)} s), ` : "no worker-model gate, "}${m.typedGate.open} answered by ${who}${frontierInr != null ? ` (₹${frontierInr.toFixed(2)})` : ""}. ${m.reviewVerdict || ""}\n\n`;
  if (/^skipped/.test(m.reviewVerdict || "")) note += `Review was ${m.reviewVerdict}; the total is the worker cost only.`;
  else if (m.reviewer && !["claude", "openrouter"].includes(m.reviewer)) note += `${who} reports no tokens or cost; the review columns show ? and the total is the worker cost only.`;
  else if (Number.isFinite(rate) && m.reviewer !== "openrouter") {
    try {
      const j = await (await fetch("https://openrouter.ai/api/v1/models")).json();
      const id = String(args["opus-id"] || "anthropic/claude-opus-5.5");
      const o = j.data.find((x) => x.id === id);
      if (o) {
        const pm = (v) => Math.round(Number(v) * 1e8) / 100;
        const px = { in: pm(o.pricing.prompt), out: pm(o.pricing.completion), cr: pm(o.pricing.input_cache_read ?? 0), cw: pm(o.pricing.input_cache_write ?? 0) };
        const usd = ((ru.input || 0) * px.in + (ru.cache_read || 0) * px.cr + (ru.cache_write || 0) * px.cw + (ru.output || 0) * px.out) / 1e6;
        note += `Opus list price (${id}, OpenRouter, ${new Date().toISOString().slice(0, 10)}): $${px.in}/M in, $${px.out}/M out, $${px.cr}/M cache read, $${px.cw}/M cache write. Review at these prices: ₹${(usd * rate).toFixed(2)}; Claude reported ₹${frontierInr.toFixed(2)}.`;
      }
    } catch { note += "(Opus list price lookup failed; review cost is Claude's reported figure)"; }
  }
  note = note.trim();
  say(header + "\n" + row + (note ? "\n\n" + note : ""));
  writeFileSync(resolve(run, "TABLE.md"), header + "\n" + row + "\n" + (note ? "\n" + note + "\n" : ""));
}

// Writes the planner instructions (AGENTS.md with the harness path filled in) where each agentic IDE reads them.
async function init() {
  const { initProject, PLUGIN_COMMANDS } = await import("../lib/init.mjs");
  let r; try { r = initProject({ project, ide: String(args.ide || "all") }); } catch (e) { die(e.message); }
  say(`init: harness ${HOME} → project ${r.project} (--ide ${r.ide})`);
  for (const w of r.written) say(`  ${w.action === "new" ? "wrote" : w.action === "appended" ? "appended is-worker section to" : "replaced is-worker section in"} ${w.path} — read by ${w.readBy}`);
  if (r.claude) { say("  claude: nothing to write; the plugin provides /is-worker. Inside Claude Code run:"); for (const c of PLUGIN_COMMANDS) say(`    ${c}`); }
  if (r.written.length) say(`Next: open ${r.project} in your IDE and type: use is-worker to build <your idea>`);
}

const cmds = { init, doctor, status, preflight, run, review, table };
if (!cmds[cmd]) die("usage: node scripts/is-worker.mjs init|doctor|status|preflight|run|review|table --project <dir> [--ide claude|cursor|codex|opencode|antigravity|all] [--reviewer claude|codex|opencode|custom|openrouter] [--full]");
cmds[cmd]().catch((e) => die(String(e.stack || e)));
