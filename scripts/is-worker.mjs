// /is-worker orchestrator: IndicStack-only planner-worker-reviewer for any project.
//   node scripts/is-worker.mjs <cmd> --project <dir> [...]
//   cmds: init [--ide claude|cursor|codex|opencode|antigravity|all] | doctor | status | preflight | run | review [--reviewer claude|codex|opencode|custom|openrouter] [--model m] [--force] [--full] [--gate] | table [--rate INR_PER_USD]
//   doctor exit codes: 0 ready, 3 key missing, 4 key rejected by IndicStack, 5 IndicStack unreachable, 6 selected reviewer CLI not found
//   The reviewer is also picked by IS_WORKER_REVIEWER; "custom" runs the IS_WORKER_REVIEW_CMD template, "openrouter" calls the API (see lib/reviewer.mjs).
//   review is typed by default (0.8.0): the reviewer answers the planner's cross-file checklist statements (plus the
//   per-ticket ones of troubled tickets) over the whole code in one call. --gate first has the worker model judge every
//   statement and close the confident ones (0.8.0–0.8.2 default; 36 s of qwen for little gain). --full is the pre-0.8.0
//   prose review of the diff.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
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
function lastRun() { const r = listRuns().filter((n) => /-A(-\d+)?(-expand(-\d+)?)?$/.test(n)); return r.length ? resolve(pwr, "runs", r.at(-1)) : null; }
// The run `review` and `table` work on: --run <dir> if given, else the latest. Fails in one line that says where it looked and what to do.
function pickRun() {
  const run = args.run ? resolve(String(args.run)) : lastRun();
  if (!run || !existsSync(resolve(run, "meta.json"))) die(`no run found${args.run ? ` at ${run} (no meta.json there)` : ` under ${resolve(pwr, "runs")}`}. Run \`node "${resolve(HOME, "scripts/is-worker.mjs")}" run --project ${project}\` first, or pass --run ${resolve(pwr, "runs")}/<id>`);
  return run;
}

// The connection check. Prints one banner line first so a human and Claude both see the state at a glance.
function economizerPython() {
  for (const bin of [process.env.TE_PYTHON, "python3.13", "python3.12", "python3.11", "python3.10", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3", "python"].filter(Boolean)) {
    const r = spawnSync(bin, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3]); sys.exit(0 if sys.version_info >= (3, 10) else 1)"], { encoding: "utf8" });
    if (r.status === 0) return { bin, version: r.stdout.trim() };
  }
  return null;
}
// `is-worker economizer <status|facts|toolprune|untool|config|repos …>`: the token economizer's own command line.
async function economizer() {
  const sub = process.argv.slice(3).filter((a, i, arr) => a !== "--project" && arr[i - 1] !== "--project");
  const r = spawnSync(resolve(HOME, "economizer/scripts/te"), sub.length ? sub : ["status"], { cwd: project, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

async function doctor() {
  const { selectedReviewer, reviewerStatus } = await import("../lib/reviewer.mjs");
  const { armConfig } = await import("../lib/settings.mjs");
  const cfg = armConfig("A");
  const lines = [];
  let code = 0;
  lines.push(`node: ${process.versions.node} (${process.platform})`);
  // The built-in token economizer (economizer/, vendored TokenEconomizer) runs from Claude Code hooks under Python >= 3.10.
  // Without it the hooks answer "no change": builds still work, they just do not get the economizer's savings.
  const py = economizerPython();
  lines.push(py ? `python: ${py.version} (${py.bin}) — token economizer on` : "python: none >= 3.10 found — token economizer OFF (install Python 3.10+, e.g. `brew install python@3.12` or python.org; set TE_PYTHON to pick one)");
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
  let model = args.model ? String(args.model) : DEFAULTS.review_models?.[name]?.[mode] ?? null; // CLIs without an entry use their own default
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
    let r = await runReview({ name, folder: meta.reviewFolder, model, mode, maxTokens: DEFAULTS.review_answer_max_tokens });
    // The claude CLI can be blocked for an account ("disabled Claude subscription access", expired OAuth). With an
    // OpenRouter key saved, fall back to it instead of leaving no review (paradox runs on 21 Oct 2026 ended with none).
    if (name === "claude" && !r.skipped && /disabled Claude subscription access|Failed to authenticate|OAuth/.test(r.stdout + r.stderr) && (await import("../lib/reviewer.mjs")).reviewers.openrouter.bin(process.env)) {
      say("claude CLI is blocked for this account; falling back to --reviewer openrouter");
      name = "openrouter"; model = args.model ? String(args.model) : DEFAULTS.review_models.openrouter[mode];
      r = await runReview({ name, folder: meta.reviewFolder, model, mode, maxTokens: DEFAULTS.review_answer_max_tokens });
    }
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

// expand (0.9.0): the frontier model writes one example + a test template + a target list (.is-worker/expand.json); qwen
// writes every target, four at a time, tested per target. No brief, no tickets, no planning turns.
async function expand() {
  if (args.reference) { node("scripts/expand.mjs", ["--reference"]); return; }
  const key = await keyFor();
  if (!key) die("no IndicStack key (doctor says how to save it)");
  const r = node("scripts/expand.mjs", ["--spec", String(args.spec || resolve(pwr, "expand.json")), ...(args["self-test"] ? ["--self-test"] : []), ...(args.verbose ? ["--verbose"] : []), ...(args.reference ? ["--reference"] : [])], { env: { IS_WORKER_API_KEY: key } });
  if (r.status === 2) die("expand failed");
}

async function table() {
  const run = pickRun();
  const { summarize, readMeta, runPaths } = await import("../lib/runs.mjs");
  const T = await import("../lib/tokens.mjs");
  const m = readMeta(run), s = summarize(run);
  // The milestone = every run built from the same frozen brief (a resume or a re-run after a queue counts too).
  const runs = m.kind === "expand" && !args.run ? listRuns().map((n) => resolve(pwr, "runs", n)).filter((d) => readMeta(d)?.kind === "expand")
    : m.briefHash ? listRuns().map((n) => resolve(pwr, "runs", n)).filter((d) => { const x = readMeta(d); return x && x.briefHash === m.briefHash && x.mode === m.mode; }) : [run];
  const metas = runs.map((d) => readMeta(d)).filter(Boolean);
  const firstStart = metas.map((x) => x.started).filter(Boolean).sort()[0];
  const ends = metas.flatMap((x) => [x.finished, x.reviewedAt]).filter(Boolean).sort();
  const lastEnd = ends.length ? new Date(ends.at(-1)).getTime() + 15 * 60 * 1000 : Date.now();
  const until = args.until ? new Date(String(args.until)).toISOString() : new Date(Math.min(Date.now(), lastEnd)).toISOString();
  const worker = T.workerUsage(runs);
  const found = T.plannerUsage({ project, firstRunStart: firstStart, until, kind: m.kind || "run", transcript: args.transcript ? resolve(String(args.transcript)) : null });
  const planner = found && !found.none ? found : null;
  const px = await T.listPrices(planner?.models?.[0] || m.reviewerModel || "claude-opus-5-5");
  const orKey = process.env.OPENROUTER_API_KEY || (await import("../lib/keys.mjs")).keyFor("C") || null;
  let outMethod = null;
  if (planner) { const c = await T.countOutput({ text: planner.outputText, model: planner.models[0], key: orKey }); planner.usage.output = Math.max(c.tokens, planner.loggedOutput); outMethod = c.method; }
  // Reviewer calls are recorded on the run that was reviewed (claude and openrouter report tokens; codex/opencode/custom do not).
  const rev = { calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 };
  let revKnown = true, revRan = false;
  for (const x of metas) {
    const ru = x.reviewUsage;
    if (!ru) continue;
    revRan = true;
    if (ru.input == null) { revKnown = false; continue; }
    if ((ru.input || 0) + (ru.output || 0) + (ru.cache_read || 0) === 0) continue; // the reviewer crashed before any call
    rev.calls++; rev.input += ru.input || 0; rev.cache_write += ru.cache_write || 0; rev.cache_read += ru.cache_read || 0; rev.output += ru.output || 0;
  }
  const frontier = planner ? T.add(planner.usage, rev) : null;
  const fModel = planner?.models?.[0] || m.reviewerModel || "frontier";
  const code = T.codeBytes(project);
  const app = String(args.app || project.split(/[\\/]/).pop());
  const alone = T.aloneEstimate({ baselinesFile: resolve(HOME, "alone-baselines.json"), app, baselineApp: args.baseline ? String(args.baseline) : null, model: planner?.models?.[0] || m.reviewerModel || "claude-opus-5-5", bytes: code.bytes });
  const fmt = (n) => (n == null ? "?" : Number(n).toLocaleString("en-IN"));
  const col = (u, k) => (u ? fmt(k === "total" ? T.totalOf(u) : k === "new" ? u.input + u.cache_write : u[k]) : "?");
  const W = worker, F = frontier, A = alone?.usage;
  const rows = [
    ["Model", `IndicStack ${m.model}`, fModel, alone ? alone.basis[0].model : "?"],
    ["Calls", col(W, "calls"), col(F, "calls"), col(A, "calls")],
    ["New input tokens", col(W, "new"), col(F, "new"), col(A, "new")],
    ["Cache-read tokens (context re-read each turn)", "0", col(F, "cache_read"), col(A, "cache_read")],
    ["Output tokens", col(W, "output"), col(F, "output"), col(A, "output")],
    ["**Total tokens**", `**${col(W, "total")}**`, `**${col(F, "total")}**`, `**${col(A, "total")}**`],
  ];
  // Tokens are not alike: a cache read costs a few percent of a new input token, an output token several times one.
  // The cost row weighs them at list price so the columns can be compared; the worker's is what IndicStack billed.
  const pxA = alone && alone.basis[0].model !== (planner?.models?.[0]) ? (await T.listPrices(alone.basis[0].model)) || px : px;
  const usd = (u, p = px) => (u && p ? `$${T.usdAt(u, p).toFixed(3)}` : "?");
  rows.push(["Cost at list price", s.cost != null ? `₹${s.cost.toFixed(2)} (IndicStack)` : "?", usd(F), usd(A, pxA)]);
  if (F && A && alone.kind === "measured" && px) {
    const d = T.usdAt(A, pxA) - T.usdAt(F, px);
    rows.push(["Frontier cost saved vs alone", "—", `${d >= 0 ? "" : "-"}$${Math.abs(d).toFixed(3)} (${Math.round((1 - T.usdAt(F, px) / T.usdAt(A, pxA)) * 100)}%)`, "—"]);
  }
  // Frontier cost per KB of finished code: the comparison that does not depend on how big each build came out.
  const kbOf = (b) => b / 1024;
  const aloneKB = alone?.kind === "measured" ? (alone.code_bytes || alone.basis[0].code_bytes) : code.bytes;
  const perKB = (b) => T.usdAt(b.usage, pxA) / kbOf(b.code_bytes);
  const aloneRange = alone?.n > 1 && pxA ? ` range $${Math.min(...alone.basis.map(perKB)).toFixed(4)}–$${Math.max(...alone.basis.map(perKB)).toFixed(4)}` : "";
  if (px) rows.push(["Frontier $ per KB of code", "—", F ? `$${(T.usdAt(F, px) / kbOf(code.bytes)).toFixed(4)} (${(code.bytes / 1024).toFixed(1)} KB)` : "?", A ? `$${(T.usdAt(A, pxA) / kbOf(aloneKB)).toFixed(4)} (${(aloneKB / 1024).toFixed(1)} KB${aloneRange})` : "?"]);
  const aloneHead = alone ? `Frontier alone (${alone.kind}${alone.n ? `, n=${alone.n}` : ""})` : "Frontier alone (no baseline yet)";
  const tbl = `| | Worker | Frontier with is-worker | ${aloneHead} |\n|---|---|---|---|\n` + rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  const notes = [];
  let expandKB = null;
  if (m.kind === "expand") {
    // Latest status per target path across every expand run of this project.
    const { readJsonl } = await import("../lib/jsonl.mjs");
    const latest = new Map();
    for (const d of runs) for (const t of readJsonl(runPaths(d).tickets)) latest.set(t.path, t);
    const okPaths = [...latest.values()].filter((t) => t.status === "ok").map((t) => t.path);
    const kb = okPaths.reduce((a, f) => a + (existsSync(resolve(project, f)) ? statSync(resolve(project, f)).size : 0), 0) / 1024;
    s.tickets_total = latest.size; s.tickets_passed_first_try = [...latest.values()].filter((t) => t.status === "ok" && t.attempts === 1).length;
    s.tests_final = { pass: okPaths.length, fail: latest.size - okPaths.length };
    expandKB = kb;
    notes.push(`From expand: ${okPaths.length} file(s), ${kb.toFixed(1)} KB of ${(code.bytes / 1024).toFixed(1)} KB (${Math.round((100 * kb * 1024) / code.bytes)}%).`);
  }
  if (planner) {
    const ad = T.adoption({ files: planner.files, since: planner.since, until, project });
    const kb = (b) => (b / 1024).toFixed(1);
    notes.push(`Adoption (from this chat's tool calls): the frontier wrote ${ad.codeFiles} app file(s), ${kb(ad.codeBytes)} KB, itself, plus ${ad.edits} edit(s) (${kb(ad.editBytes)} KB) and ${kb(ad.specBytes)} KB of harness specs in .is-worker/; ${expandKB != null ? `qwen wrote ${kb(expandKB * 1024)} KB (${Math.round((100 * expandKB * 1024) / code.bytes)}% of the app); ` : ""}it opened ${ad.readFiles} project file(s) (${kb(ad.readBytes)} KB) with Read; expand runs ${ad.expandRuns} (+${ad.selfTests} self-test), digest runs ${ad.digestRuns}, digest queries ${ad.digestQueries}.${m.kind === "expand" && !ad.expandRuns ? " ⚠ No expand run in this chat: the worker numbers are not from this build." : ""}`);
  }
  const tests = s.tests_final ? `${s.tests_final.pass}/${s.tests_final.pass + s.tests_final.fail}` : "?";
  notes.push(`Milestone: ${runs.length} run(s) from brief ${String(m.briefHash).slice(0, 8)} (${runs.map((d) => d.split(/[\\/]/).pop()).join(", ")}); ${s.tickets_passed_first_try}/${s.tickets_total} first try, final tests ${tests}. App: ${(code.bytes / 1024).toFixed(1)} KB in ${code.files} files.`);
  notes.push(`Worker: summed from ${W.calls} API calls' usage (calls.jsonl).`);
  const revNote = revRan ? (revKnown ? `${rev.calls} review call(s)` : "a review whose tool reports no tokens (not counted)") : "no review";
  notes.push(planner
    ? `Frontier with is-worker: this Claude Code session only (${planner.session.split(/[\\/]/).pop().slice(0, 8)}…, ${planner.files.length} transcript file(s) incl. its subagents), usage block of every API call from ${planner.since.slice(0, 19)}Z to ${until.slice(0, 19)}Z, plus ${revNote}. Output = visible reply text counted with ${outMethod}; hidden thinking is not counted on either side.`
    : `Frontier with is-worker: ${found?.none || "the running session's transcript was not found (non-Claude IDE)"}; shown as ?. Run \`table\` from the chat that ran /is-worker to count its planning.`);
  if (px) notes.push(`List prices (${px.id}, OpenRouter): $${px.in}/M new input, $${px.cr}/M cache read, $${px.out}/M output. A cache-read token costs ${Math.round(100 * px.cr / px.in)}% of a new-input token; that is why the cost row, not the token total, is the comparison.`);
  if (alone?.kind === "measured") notes.push(`Frontier alone: measured — ${alone.basis.map((b) => `${b.date} ${b.model}: ${b.source}`).join("; ")}.${alone.n === 1 ? " One run only: record more with `baseline` (each run is kept and pooled) before trusting a small difference." : ""}`);
  else if (alone) notes.push(`Frontier alone: estimated as tokens per KB of finished code × this app's ${(code.bytes / 1024).toFixed(1)} KB, pooled over ${alone.basis.length} measured build(s): ${alone.basis.map((b) => `${b.app} ${fmt(Math.round(T.totalOf(b.usage) / (b.code_bytes / 1024)))} tok/KB`).join(", ")}. Range from those builds: ${fmt(alone.range[0])}–${fmt(alone.range[1])} tokens.`);
  else notes.push("Frontier alone: no measured baseline for this model yet. Record one with `is-worker.mjs baseline`.");
  if (alone?.modelMismatch) notes.push(`⚠ Model mismatch: the baseline was built by ${alone.modelMismatch}, this build by ${fModel}. Each column is priced at its own model's list price, but the comparison is not like for like. Record a ${fModel} baseline.`);
  const out = tbl + "\n\n" + notes.join("\n");
  say(out);
  writeFileSync(resolve(run, "TABLE.md"), out + "\n");
}

// Records a measured frontier-alone build: the app folder it wrote and the transcript(s) of the session that wrote it.
//   baseline --app <name> --dir <app folder> --transcript <file.jsonl>[,<file2>] [--since ISO] [--until ISO] [--source text]
async function baseline() {
  const T = await import("../lib/tokens.mjs");
  if (!args.app || !args.dir || !args.transcript) die("usage: is-worker.mjs baseline --app <name> --dir <app folder> --transcript <file.jsonl>[,more] [--since ISO] [--until ISO] [--source text]");
  const files = String(args.transcript).split(",").map((f) => resolve(f));
  const r = T.transcriptUsage({ files, since: args.since ? String(args.since) : null, until: args.until ? String(args.until) : null });
  if (!r.usage.calls) die("no assistant usage found in those transcripts/window");
  const orKey = process.env.OPENROUTER_API_KEY || (await import("../lib/keys.mjs")).keyFor("C") || null;
  const c = await T.countOutput({ text: r.outputText, model: r.models[0], key: orKey });
  r.usage.output = Math.max(c.tokens, r.loggedOutput);
  const code = T.codeBytes(resolve(String(args.dir)));
  const f = resolve(HOME, "alone-baselines.json");
  const j = readJson(f) || { about: "Measured frontier-alone builds (no harness), read by `table` for the Frontier alone column.", baselines: [] };
  // L4: runs are kept and pooled by `table --baseline <app>`; --replace drops this app+model's earlier runs first.
  if (args.replace) j.baselines = j.baselines.filter((b) => b.app !== String(args.app) || b.model !== r.models[0]);
  j.baselines.push({ app: String(args.app), model: r.models[0], date: new Date().toISOString().slice(0, 10), code_bytes: code.bytes, code_files: code.files, usage: r.usage, output_method: c.method, source: String(args.source || `${r.files.length} transcript file(s)`) });
  writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  say(`baseline ${args.app} (${r.models[0]}): ${code.files} files, ${(code.bytes / 1024).toFixed(1)} KB, ${r.usage.calls} calls, ${T.totalOf(r.usage).toLocaleString("en-IN")} tokens (output ${r.usage.output.toLocaleString("en-IN")})`);
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

// N7: qwen digests of long files, cached by content hash, so the planner reads DIGESTS.md instead of the files.
async function digest() {
  const pass = ["files", "dir", "min", "query", "top"].flatMap((k) => (args[k] ? [`--${k}`, String(args[k])] : []));
  if (args.query) { const q = node("scripts/digest.mjs", pass); if (q.status) die("digest query failed"); return; }
  const key = await keyFor();
  if (!key) die("no IndicStack key (doctor says how to save it)");
  const r = node("scripts/digest.mjs", pass, { env: { IS_WORKER_API_KEY: key } });
  if (r.status) die("digest failed");
}

// The whole sibling route in one foreground command: expand (self-test first), verify every module, optional commit,
// then the token table. The planner calls it once after writing expand.json, and once more with --verify-only after
// fixing anything left, so a build stays within a few turns.
async function build() {
  const { verify } = await import("../lib/verify.mjs");
  const spec = String(args.spec || resolve(pwr, "expand.json"));
  let expandStatus = null;
  const { findStubs } = await import("./stubs.mjs");
  const stubCount = findStubs(resolve(project, String(args.dir || "src"))).length;
  // Stubs are filled and tested as plain JavaScript only; say so instead of skipping TypeScript stubs silently.
  const tsStubs = (function walk(d, out = []) { if (!existsSync(d)) return out; for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".") || e.name === "node_modules") continue; const f = resolve(d, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(ts|tsx|jsx)$/.test(e.name) && /\/\/\s*@qwen\b/.test(readFileSync(f, "utf8"))) out.push(f); } return out; })(resolve(project, String(args.dir || "src")));
  if (tsStubs.length) say(`warning: ${tsStubs.length} @qwen stub(s) in .ts/.tsx/.jsx files are not filled (stubs are plain .js/.mjs only): put them in .is-worker/chunks.json as whole-file chunks instead`);
  const chunkSpec = resolve(pwr, "chunks.json");
  if (!args["verify-only"] && (stubCount || existsSync(spec) || existsSync(chunkSpec))) {
    const key = await keyFor();
    if (!key) die(`IS-WORKER: NOT CONNECTED — no IndicStack key. Save it with: node "${resolve(HOME, "scripts/key.mjs")}" (in a terminal), or fill the ${stubCount} @qwen stub(s) yourself and run build --verify-only`);
    // Chunk route (0.11, small tasks in existing code): Opus planned the edits, qwen makes each one, scripts check it.
    if (existsSync(chunkSpec)) {
      const ch = node("scripts/chunks.mjs", ["--spec", chunkSpec, ...(args.verbose ? ["--verbose"] : [])], { env: { IS_WORKER_API_KEY: key } }).status;
      if (ch === 2) die("build stopped: chunks.json was rejected before any worker call (see above). Fix it and run build again.");
      if (ch === 1) expandStatus = 1;
    }
    // Stub route first (0.10.1B): qwen fills every file marked // @qwen, tested against its own stub.
    if (stubCount) {
      const st = node("scripts/stubs.mjs", ["--dir", String(args.dir || "src"), ...(args.verbose ? ["--verbose"] : [])], { env: { IS_WORKER_API_KEY: key } }).status;
      if (st === 1) expandStatus = 1;
      if (st === 2) die("build stopped: stub filling could not start (see above)");
      // Never report success over unfilled stubs: the 0.10.2 Windows bug filled 0 and still committed.
      const still = findStubs(resolve(project, String(args.dir || "src"))).length;
      if (still === stubCount) die(`build stopped: the worker filled 0 of ${stubCount} @qwen stub(s); nothing was committed. Run with --verbose, or fill them yourself and run build --verify-only.`);
      if (still) { say(`${still} of ${stubCount} @qwen stub(s) are still unfilled (listed above).`); expandStatus = 1; }
    }
    if (existsSync(spec)) {
      const es = node("scripts/expand.mjs", ["--spec", spec, ...(args.verbose ? ["--verbose"] : [])], { env: { IS_WORKER_API_KEY: key } }).status;
      if (es === 2) die("build stopped: the spec is invalid or a self-test failed (see above). Fix it and run build again.");
      if (es === 1) expandStatus = 1;
    }
  }
  const v = verify(project, String(args.dir || "src"));
  say(`verify: ${v.files} module(s); syntax errors ${v.syntax.length}; imported ${v.imported}${v.browserOnly.length ? `; browser-only ${v.browserOnly.length} (${v.browserOnly.map((x) => x.file).join(", ")})` : ""}; failed ${v.failed.length}`);
  for (const x of [...v.syntax, ...v.failed]) say(`  ✗ ${x.file}: ${x.error}`);
  if (args["target-kb"]) {
    const { codeBytes } = await import("../lib/tokens.mjs");
    const kb = codeBytes(project).bytes / 1024, want = Number(args["target-kb"]);
    say(kb < 0.8 * want ? `size: ${kb.toFixed(1)} KB of the ${want} KB asked (${Math.round((100 * kb) / want)}%) — under 80%: add targets to expand.json, not hand-written files, then run build again` : `size: ${kb.toFixed(1)} KB of the ${want} KB asked`);
  }
  if (expandStatus === 1) say("the worker left work above (chunks: see .is-worker/chunks-failed.md): fix the closest candidate on disk, then run build --verify-only --commit \"…\"");
  if (!v.ok || expandStatus === 1) process.exit(1);
  if (args.commit) {
    const g = (a) => spawnSync("git", a, { cwd: project, encoding: "utf8" });
    g(["add", "-A"]);
    const c = g(["commit", "-qm", String(args.commit)]);
    say(c.status === 0 ? `committed ${g(["rev-parse", "--short", "HEAD"]).stdout.trim()}` : `commit skipped: ${(c.stdout + c.stderr).trim().split("\n")[0]}`);
  }
  if (listRuns().length) await table();
}

const cmds = { init, doctor, status, preflight, run, review, table, baseline, expand, digest, build, economizer };
if (!cmds[cmd]) die("usage: node scripts/is-worker.mjs init|doctor|status|preflight|run|review|table|baseline|expand|digest|build|economizer --project <dir> [--ide claude|cursor|codex|opencode|antigravity|all] [--reviewer claude|codex|opencode|custom|openrouter] [--full]");
cmds[cmd]().catch((e) => die(String(e.stack || e)));
