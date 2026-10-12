// /is-worker orchestrator: IndicStack-only planner-worker-reviewer for any project.
//   node scripts/is-worker.mjs <cmd> --project <dir> [...]
//   cmds: doctor | status | preflight | run | review | table [--rate INR_PER_USD]
//   doctor exit codes: 0 ready, 3 key missing, 4 key rejected by IndicStack, 5 IndicStack unreachable, 6 claude CLI not found
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { HOME } from "../lib/paths.mjs";
import { runClaude } from "../lib/claude-bin.mjs";

const args = Object.fromEntries(process.argv.slice(3).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const cmd = process.argv[2];
const project = resolve(String(args.project || process.env.IS_WORKER_PROJECT || process.cwd()));
const pwr = resolve(project, ".is-worker");
// One-time migration: project folders created before 12 Oct 2026 used <project>/.pwr
if (!existsSync(pwr) && existsSync(resolve(project, ".pwr"))) { (await import("node:fs")).renameSync(resolve(project, ".pwr"), pwr); console.log(".pwr/ renamed to .is-worker/"); }
const env = { ...process.env, IS_WORKER_PROJECT: project };
const node = (script, extra = [], opts = {}) => spawnSync(process.execPath, [resolve(HOME, script), ...extra], { cwd: HOME, encoding: "utf8", env: { ...env, ...(opts.env || {}) }, stdio: opts.quiet ? "pipe" : "inherit", maxBuffer: 50e6 });
const say = (m) => console.log(m);
const die = (m) => { console.error(m); process.exit(2); };
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

async function keyFor() {
  const { keyFor } = await import("../lib/keys.mjs");
  return process.env.INDICSTACK_API_KEY || keyFor("A");
}
function listRuns() { const d = resolve(pwr, "runs"); return existsSync(d) ? readdirSync(d).filter((n) => existsSync(resolve(d, n, "meta.json"))).sort() : []; }
function lastRun() { const r = listRuns().filter((n) => /-A(-\d+)?$/.test(n)); return r.length ? resolve(pwr, "runs", r.at(-1)) : null; }

// The connection check. Prints one banner line first so a human and Claude both see the state at a glance.
async function doctor() {
  const { claudeBin } = await import("../lib/claude-bin.mjs");
  const { armConfig } = await import("../lib/settings.mjs");
  const cfg = armConfig("A");
  const lines = [];
  let code = 0;
  lines.push(`node: ${process.versions.node} (${process.platform})`);
  const bin = claudeBin();
  const claudeOk = bin !== "claude" || spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
  lines.push(`claude cli: ${claudeOk ? bin : "NOT FOUND (reviews will not run)"}`);
  if (!claudeOk) code = code || 6;
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
  const probe = readJson(resolve(pwr, "state", "probe-A.json"));
  lines.push(`probe: ${probe ? `window ${probe.context_window} (${probe.at.slice(0, 16)})` : "none yet (preflight runs it)"}`);
  const banner = code === 0 ? "IS-WORKER: READY — IndicStack connected; the worker will write the code."
    : code === 3 ? "IS-WORKER: NOT CONNECTED — no IndicStack key. Nothing may be planned or coded until it is saved."
    : code === 4 ? "IS-WORKER: NOT CONNECTED — IndicStack rejected the key. Save the correct key before anything else."
    : code === 5 ? "IS-WORKER: NOT CONNECTED — IndicStack unreachable. Check the network or ask ops; do not fall back to Claude writing the code."
    : "IS-WORKER: DEGRADED — claude CLI not found; runs work, blind reviews will not.";
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
  const r = node("scripts/is-worker.mjs", ["doctor", "--project", project], { quiet: true });
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
  if (!/ok/.test(check.stdout)) die(`brief problem: ${check.stderr.split("\n").find((l) => /Error/.test(l)) || check.stderr}`);
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
  if (meta.status === "needs_claude") say(`tickets queued for the planner: see ${resolve(lastRun(), "claude-queue.jsonl")}. Submit each with: node ${resolve(HOME, "check.mjs")} --run <run> --ticket N --files <json> (IS_WORKER_PROJECT set).`);
}

async function review() {
  const run = args.run ? resolve(String(args.run)) : lastRun(); if (!run) die("no run");
  const mk = node("review/make-review.mjs", ["--run", run], { quiet: true });
  if (mk.status !== 0) die(mk.stderr || mk.stdout);
  const meta = readJson(resolve(run, "meta.json"));
  say(`review folder: ${meta.reviewFolder}`);
  const t0 = Date.now();
  const r = runClaude(["-p", "--model", String(args.model || "opus"), "--output-format", "json", "--no-session-persistence", "--allowedTools", "Read", "Write", "Glob", "Grep"], { cwd: meta.reviewFolder, input: "Read PROMPT-REVIEW.md in this folder and do exactly what it says. Write REVIEW.md here, then stop.", env: { ...process.env, IS_WORKER_API_KEY: "" } });
  let j = null; try { j = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop()); } catch {}
  const u = j?.usage || {};
  const text = existsSync(resolve(meta.reviewFolder, "REVIEW.md")) ? readFileSync(resolve(meta.reviewFolder, "REVIEW.md"), "utf8") : "";
  const verdict = (text.match(/^.*\b(PASS WITH FINDINGS|PASS|FAIL)\b.*$/m) || [""])[0].replace(/^[#*\s-]+/, "").trim();
  const count = Number((verdict.match(/(\d+)/) || [])[1]);
  const { updateMeta } = await import("../lib/runs.mjs");
  updateMeta(run, { reviewVerdict: verdict, reviewerCorrections: Number.isFinite(count) ? count : null, reviewUsage: { input: u.input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, cost_usd: j?.total_cost_usd ?? null, seconds: (Date.now() - t0) / 1000, model: Object.keys(j?.modelUsage || {})[0] || null } });
  say(`verdict: ${verdict || "(no REVIEW.md written)"}`);
}

async function table() {
  const run = args.run ? resolve(String(args.run)) : lastRun(); if (!run) die("no run");
  const { summarize, readMeta } = await import("../lib/runs.mjs");
  const s = summarize(run), m = readMeta(run);
  let rate = Number(args.rate);
  if (!Number.isFinite(rate)) { try { const j = await (await fetch("https://api.frankfurter.app/latest?from=USD&to=INR")).json(); rate = j.rates.INR; say(`rate: ₹${rate}/USD (frankfurter, ${j.date})`); } catch { die("could not fetch USD→INR; pass --rate"); } }
  const ru = m.reviewUsage || {};
  const workerInr = s.cost ?? 0; // IndicStack reports cost in INR
  const reviewInr = (ru.cost_usd || 0) * rate;
  const wall = s.wall_s || 0, rs = ru.seconds || 0;
  const fmt = (n) => Number(n).toLocaleString("en-IN");
  const mmss = (sec) => `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  const row = `| ${m.id} (IndicStack ${m.model}) | ${fmt(s.prompt_tokens)} | ${fmt(s.completion_tokens)} | ₹${workerInr.toFixed(2)} | ${fmt((ru.input || 0) + (ru.cache_write || 0) + (ru.cache_read || 0))} | ${fmt(ru.output || 0)} | ₹${reviewInr.toFixed(2)} | ${s.tickets_passed_first_try}/${s.tickets_total} | ${s.tests_final ? `${s.tests_final.pass}/${s.tests_final.pass + s.tests_final.fail}` : "?"} | ${m.reviewerCorrections ?? "?"} | **₹${(workerInr + reviewInr).toFixed(2)}** | ${mmss(wall + rs)} |`;
  const header = `| Run | Worker tokens in | Worker tokens out | Worker cost | Opus review tokens in | Opus review tokens out | Opus review cost | First try | Final tests | Findings | Total cost | Total time |\n|---|---|---|---|---|---|---|---|---|---|---|---|`;
  let note = "";
  try {
    const j = await (await fetch("https://openrouter.ai/api/v1/models")).json();
    const id = String(args["opus-id"] || "anthropic/claude-opus-5.5");
    const o = j.data.find((x) => x.id === id);
    if (o) {
      const pm = (v) => Math.round(Number(v) * 1e8) / 100;
      const px = { in: pm(o.pricing.prompt), out: pm(o.pricing.completion), cr: pm(o.pricing.input_cache_read ?? 0), cw: pm(o.pricing.input_cache_write ?? 0) };
      const usd = ((ru.input || 0) * px.in + (ru.cache_read || 0) * px.cr + (ru.cache_write || 0) * px.cw + (ru.output || 0) * px.out) / 1e6;
      note = `Opus list price (${id}, OpenRouter, ${new Date().toISOString().slice(0, 10)}): $${px.in}/M in, $${px.out}/M out, $${px.cr}/M cache read, $${px.cw}/M cache write. Review at these prices: ₹${(usd * rate).toFixed(2)}; Claude reported ₹${reviewInr.toFixed(2)}.`;
    }
  } catch { note = "(Opus list price lookup failed; review cost is Claude's reported figure)"; }
  say(header + "\n" + row + (note ? "\n\n" + note : ""));
  writeFileSync(resolve(run, "TABLE.md"), header + "\n" + row + "\n" + (note ? "\n" + note + "\n" : ""));
}

const cmds = { doctor, status, preflight, run, review, table };
if (!cmds[cmd]) die("usage: node scripts/is-worker.mjs doctor|status|preflight|run|review|table --project <dir>");
cmds[cmd]().catch((e) => die(String(e.stack || e)));
