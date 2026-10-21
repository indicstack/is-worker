// Option G: contract-first, two lanes, commit in order.
//   * Contract-first: the frozen brief pins every interface. A ticket whose 'reads' are all contract-covered (harness-owned
//     files that already exist, or modules listed in the brief's Interfaces section) starts at t=0; any other ticket waits
//     for its deps to commit so its prompt shows real code. A dependency orders the COMMIT and the TEST, not the writing.
//   * Two lanes: the qwen lane runs up to --qwen-concurrency tickets at once (IndicStack batches: 4 ticket-sized calls took
//     7.5 s against 5.5 s for one). The Opus lane takes tickets longest-first (calibration tokens ÷ tok/s × expected attempts)
//     while Opus stays under the token-share cap, or when a ticket is known-bad on qwen (expected attempts ≥ 2), since every
//     failed qwen attempt is wasted bottleneck time. Rejected tickets do not stop the scan.
//   * Commit in order: files land in the work dir only after every dep has committed, so when two tickets write one file
//     the later one in dependency order wins, whichever finished first.
//   * Snapshot tests: a ticket's tests run in a snapshot holding only harness-owned files, its deps' and co-writers' committed
//     files and its own, never a half-committed sibling. The full tree is tested once at the end (regression).
//   * Keep-green: a ticket that rewrites an earlier ticket's file gets that ticket's test in its prompt and its test run.
//   * Ladder: a failed ticket retries on the cheap lane if it has a free slot, then goes to Opus; an Opus ticket falls back to
//     qwen. The regression blames the last writer of the failing test's files and uses the same ladder.
//   * Review: cross-file statements (+ per-ticket statements of escalated tickets), Opus, no gate. Sharded into parallel
//     calls when the prompt would exceed --review-shard-tokens; an unparsable answer is an error, never "0 findings".
//   IS_WORKER_PROJECT=<dir> node option-g.mjs [--all-qwen] [--frontier 6] [--qwen-concurrency 4] [--share-cap 0.4] [--out G.json]
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { askOpus } from "./opus.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
const PROJECT = resolve(process.env.IS_WORKER_PROJECT);
const ISW = resolve(PROJECT, ".is-worker");
const { buildMessages, buildBody, loadTickets, ticketKey } = await import("../../lib/prompt.mjs");
const keys = Object.fromEntries(readFileSync(resolve(homedir(), ".is-worker", "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const QWEN = { key: keys.IS_WORKER_KEY_A, base: "https://api.indicstack.ai/v1", model: "qwen38-27b" };
const QWEN_INR_PER_TOKEN = 1.3697810000000001 / (28241 + 4088);
const QWEN_CONC = Number(args["qwen-concurrency"] || 4);
const SHARE_CAP = Number(args["share-cap"] || 0.4);        // owner's rule: qwen ≥ 3/5 of all tokens
const REVIEW_SHARD_TOKENS = Number(args["review-shard-tokens"] || 10000);
const OPUS_TPS = 120, OPUS_ALONE_TOKENS = 37553;           // measured 21 Oct
const CHARS_PER_TOKEN = 3.45;

const tickets = loadTickets();
const brief = readFileSync(resolve(ISW, "BRIEF.md"), "utf8");
const checklist = JSON.parse(readFileSync(resolve(ISW, "checklist.json"), "utf8"));
const RUN_ID = `option-G-${Date.now()}`; // in every prompt: IndicStack's response cache answers a repeated prompt in 0 s
const work = resolve(tmpdir(), RUN_ID);
mkdirSync(work, { recursive: true });

// Calibration: per-ticket answer tokens (keyed by ticket id in older files, by ticketKey in newer), speed, ttft, and
// attempts per ticket from the latest run. Unknown tickets fall back to an estimate from the task text.
const calPath = resolve(ISW, "state", "calibration-A.json");
const cal = existsSync(calPath) ? JSON.parse(readFileSync(calPath, "utf8")) : {};
const QWEN_TPS = cal.speed_tps_p50 || 50, QWEN_TTFT = cal.ttft_p95 || 2;
const byTicket = cal.answer_tokens_p95_by_ticket || {};
const expOut = (t) => byTicket[ticketKey(t)] ?? byTicket[String(t.id)] ?? Math.round(t.task.length / CHARS_PER_TOKEN * 1.5);
const runsDir = resolve(ISW, "runs");
const lastRun = existsSync(runsDir) ? readdirSync(runsDir).filter((n) => existsSync(resolve(runsDir, n, "tickets.jsonl"))).sort().at(-1) : null;
const attemptsByTicket = {};
if (lastRun) for (const l of readFileSync(resolve(runsDir, lastRun, "tickets.jsonl"), "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); attemptsByTicket[r.ticket] = Math.max(attemptsByTicket[r.ticket] || 0, r.attempts || 1); }
const expAttempts = (t) => attemptsByTicket[t.id] || 1;
const expPrompt = (t) => Math.round((brief.length + 1200 + t.task.length + 2500) / CHARS_PER_TOKEN);
const qwenSeconds = (t) => expAttempts(t) * (QWEN_TTFT + expOut(t) / QWEN_TPS);
const opusSeconds = (t) => 1 + expOut(t) / OPUS_TPS;

// Contract coverage: a read is covered when the file already exists in the project (harness-owned) or its module is
// named in the brief's Interfaces section.
const interfaces = (brief.split(/^## Interfaces/m)[1] || "").split(/^## /m)[0];
const covered = (rel) => existsSync(resolve(PROJECT, rel)) || interfaces.includes(`\`${rel}\``);
const harnessOwned = [...new Set(tickets.flatMap((t) => t.reads))].filter((f) => !tickets.some((t) => t.writes.includes(f)) && existsSync(resolve(PROJECT, f)));
for (const f of harnessOwned) { mkdirSync(dirname(resolve(work, f)), { recursive: true }); cpSync(resolve(PROJECT, f), resolve(work, f)); }

// Lane assignment (the knapsack rule).
const REVIEW_OPUS_TOKENS = 9000;
let frontier = new Set(); const laneWhy = {};
if (args.frontier) for (const id of String(args.frontier).split(",").map(Number)) { frontier.add(id); laneWhy[id] = "--frontier"; }
else if (!args["all-qwen"]) {
  let opusTok = REVIEW_OPUS_TOKENS, qwenTok = tickets.reduce((s, t) => s + expAttempts(t) * (expPrompt(t) + expOut(t)), 0);
  for (const t of [...tickets].sort((a, b) => qwenSeconds(b) - qwenSeconds(a))) {
    const o = Math.round(expPrompt(t) * 1.1) + expOut(t), q = expAttempts(t) * (expPrompt(t) + expOut(t));
    const share = (opusTok + o) / (opusTok + o + qwenTok - q);
    const faster = qwenSeconds(t) > opusSeconds(t) * 1.5, knownBad = expAttempts(t) >= 2;
    if (!faster) continue;
    if (share <= SHARE_CAP || knownBad) { frontier.add(t.id); opusTok += o; qwenTok -= q; laneWhy[t.id] = knownBad ? `qwen needed ${expAttempts(t)} attempts last run` : `share ${(100 * share).toFixed(0)}% ≤ cap`; }
    else laneWhy[t.id] = `rejected: share would be ${(100 * share).toFixed(0)}%`;
  }
}
console.log(`lanes: opus ← [${[...frontier].map((id) => `t${id} (${laneWhy[id]})`).join(", ") || "none"}], qwen ← the rest (concurrency ${QWEN_CONC})${Object.entries(laneWhy).filter(([id]) => !frontier.has(Number(id))).map(([id, w]) => `; t${id} ${w}`).join("")}`);

const res = { runId: RUN_ID, frontier: [...frontier], laneWhy, qwenConcurrency: QWEN_CONC, work, tickets: [], qwen: { calls: 0, in: 0, out: 0, seconds: 0, inr: 0 }, opus: { write: { calls: 0, in: 0, out: 0, cost_usd: 0, seconds: 0 }, review: { calls: 0, in: 0, out: 0, cost_usd: 0, seconds: 0, shards: 0 } }, tests: { pass: 0, fail: 0 }, findings: [], timeline: [], errors: [] };
const T0 = performance.now();
const now = () => Number(((performance.now() - T0) / 1000).toFixed(1));
const mark = (what) => { res.timeline.push({ t: now(), what }); console.log(`[${now().toFixed(1).padStart(5)}s] ${what}`); };

async function qwenWrite(messages, temperature) {
  const body = { ...buildBody({ model: QWEN.model, messages, maxTokens: 2048, thinking: false, temperature }), stream: false };
  delete body.stream_options;
  const t0 = performance.now();
  const r = await fetch(`${QWEN.base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${QWEN.key}` }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(`IndicStack: ${JSON.stringify(j.error).slice(0, 200)}`);
  const u = j.usage || {};
  const usage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cost: Number.isFinite(u.cost) ? u.cost : null };
  res.qwen.calls++; res.qwen.in += usage.input; res.qwen.out += usage.output; res.qwen.seconds += (performance.now() - t0) / 1000; res.qwen.inr += usage.cost ?? (usage.input + usage.output) * QWEN_INR_PER_TOKEN;
  return { text: j.choices?.[0]?.message?.content || "", seconds: (performance.now() - t0) / 1000, usage };
}
async function opusWrite(messages) {
  const r = await askOpus(messages, { maxTokens: 6000 });
  const w = res.opus.write; w.calls++; w.in += r.usage.input; w.out += r.usage.output; w.cost_usd += r.usage.cost_usd || 0; w.seconds += r.seconds;
  return r;
}
const parseFiles = (t, text) => { let files = null; try { files = JSON.parse(text.replace(/^```json\s*|```\s*$/g, "").trim()).files; } catch {} return files ? files.filter((f) => t.writes.includes(f.path)) : null; };
const committedFiles = new Map(); // ticket id → [{path, content}] as committed
const commit = (t, files) => { for (const f of files) { mkdirSync(dirname(resolve(work, f.path)), { recursive: true }); writeFileSync(resolve(work, f.path), f.content); } committedFiles.set(t.id, files); };

// Snapshot: harness-owned files + transitive deps' and co-writers' committed files + the ticket's own files.
const topo = []; { const seen = new Set(); while (topo.length < tickets.length) for (const x of tickets) if (!seen.has(x.id) && (x.deps || []).every((d) => seen.has(d))) { topo.push(x); seen.add(x.id); } }
const coWriters = (t) => topo.filter((w) => w.id !== t.id && topo.indexOf(w) < topo.indexOf(t) && w.writes.some((f) => t.writes.includes(f)));
const transitiveDeps = (t, acc = new Set()) => { for (const d of t.deps || []) if (!acc.has(d)) { acc.add(d); transitiveDeps(tickets.find((x) => x.id === d), acc); } return acc; };
function runTests(t, files, snapshot = true) {
  let dir = work;
  if (snapshot) {
    dir = resolve(work, `.snap-t${t.id}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    for (const f of harnessOwned) { mkdirSync(dirname(resolve(dir, f)), { recursive: true }); cpSync(resolve(PROJECT, f), resolve(dir, f)); }
    for (const id of [...transitiveDeps(t), ...coWriters(t).map((w) => w.id)]) for (const f of committedFiles.get(id) || []) { mkdirSync(dirname(resolve(dir, f.path)), { recursive: true }); writeFileSync(resolve(dir, f.path), f.content); }
    for (const f of files || []) { mkdirSync(dirname(resolve(dir, f.path)), { recursive: true }); writeFileSync(resolve(dir, f.path), f.content); }
  }
  const extra = snapshot ? coWriters(t).map((w) => resolve(ISW, w.test)) : [];
  const tr = spawnSync("node", ["--test", resolve(ISW, t.test), ...extra], { cwd: PROJECT, encoding: "utf8", env: { ...process.env, IS_WORKER_WORK: dir } });
  const out = tr.stdout + tr.stderr;
  return { pass: Number((out.match(/^(?:ℹ|#) pass (\d+)/m) || [0, 0])[1]), fail: Number((out.match(/^(?:ℹ|#) fail (\d+)/m) || [0, 0])[1]), out };
}

// qwen lane semaphore.
let qwenBusy = 0; const qwenWaiters = [];
const qwenSlot = () => new Promise((ok) => { const tryGo = () => { if (qwenBusy < QWEN_CONC) { qwenBusy++; ok(() => { qwenBusy--; const n = qwenWaiters.shift(); if (n) n(); }); } else qwenWaiters.push(tryGo); }; tryGo(); });

const keepGreen = (t) => coWriters(t).map((w) => ({ name: `keep-green ${w.test}`, text: `You are rewriting ${w.writes.filter((f) => t.writes.includes(f)).join(", ")}, which ticket ${w.id} also wrote. Its test below must still pass:\n${readFileSync(resolve(ISW, w.test), "utf8")}` }));
async function produce(t, lane, fixes) {
  const messages = buildMessages(t, work, [...keepGreen(t), ...fixes], RUN_ID); // 'reads' already committed appear; the rest are absent
  if (lane === "qwen") { const release = await qwenSlot(); try { mark(`t${t.id} qwen start${fixes.length ? " (escalated)" : ""}`); return { lane, r: await qwenWrite(messages, fixes.length ? 0.5 : 0) }; } finally { release(); } }
  mark(`t${t.id} opus start${fixes.length ? " (escalated)" : ""}`);
  return { lane, r: await opusWrite(messages) };
}

const committed = new Map(); const rows = new Map();
async function runTicket(t) {
  const lane = frontier.has(t.id) ? "opus" : "qwen";
  const row = { id: t.id, lane, attempts: [], contractFirst: t.reads.every(covered) }; rows.set(t.id, row);
  const depsDone = Promise.all((t.deps || []).map((d) => committed.get(d)));
  if (!row.contractFirst) { mark(`t${t.id} waits for deps (a read is not in the contract)`); await depsDone; }
  const first = produce(t, lane, []);
  await depsDone;
  let { lane: usedLane, r } = await first;
  let files = parseFiles(t, r.text);
  let tr = files ? runTests(t, files) : { pass: 0, fail: 1, out: "unparsed" };
  row.attempts.push({ lane: usedLane, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, tests: { pass: tr.pass, fail: tr.fail } });
  mark(`t${t.id} ${usedLane} done in ${r.seconds.toFixed(1)}s, tests ${tr.pass}/${tr.pass + tr.fail}`);
  for (let n = 0; (tr.fail || !tr.pass) && n < 2; n++) {
    const next = usedLane === "opus" ? "qwen" : n === 0 && qwenBusy < QWEN_CONC ? "qwen" : "opus";
    mark(`t${t.id} → escalate to ${next}`); row.escalated = true;
    if (files) commit(t, files); // so the fixer's prompt shows the failing files as 'reads'
    ({ lane: usedLane, r } = await produce(t, next, [{ name: "test-output", text: `The tests failed. Output:\n${tr.out.slice(0, 3000)}\nFix the files and return them in full.` }]));
    files = parseFiles(t, r.text);
    tr = files ? runTests(t, files) : { pass: 0, fail: 1, out: "unparsed" };
    row.attempts.push({ lane: usedLane, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, tests: { pass: tr.pass, fail: tr.fail } });
    mark(`t${t.id} ${usedLane} fix done in ${r.seconds.toFixed(1)}s, tests ${tr.pass}/${tr.pass + tr.fail}`);
  }
  if (files) commit(t, files);
  mark(`t${t.id} committed`);
  res.tickets.push(row);
}
for (const t of tickets) committed.set(t.id, (async () => { await runTicket(t); })());
await Promise.all(committed.values());
res.writeSeconds = now();

// Final regression on the full tree; blame the last writer of the failing test's files; same ladder; one round.
async function regression(round) {
  res.tests = { pass: 0, fail: 0 }; const failing = [];
  for (const t of tickets) { const tr = runTests(t, null, false); res.tests.pass += tr.pass; res.tests.fail += tr.fail; if (tr.fail) failing.push({ t, tr }); }
  mark(`regression ${round}: ${res.tests.pass}/${res.tests.pass + res.tests.fail}`);
  return failing;
}
let failing = await regression(1);
if (failing.length) {
  const fixes = new Map();
  for (const { t, tr } of failing) { const blamed = [...topo].reverse().find((w) => w.writes.some((f) => t.writes.includes(f))) || t; if (!fixes.has(blamed.id)) fixes.set(blamed.id, []); fixes.get(blamed.id).push(`test ${t.test}:\n${tr.out.slice(0, 2500)}`); }
  await Promise.all([...fixes].map(async ([id, outs]) => {
    const t = tickets.find((x) => x.id === id), row = rows.get(id);
    const next = row.attempts.at(-1).lane === "opus" ? "qwen" : qwenBusy < QWEN_CONC ? "qwen" : "opus";
    mark(`regression blames t${id} → escalate to ${next}`); row.escalated = true;
    const { lane, r } = await produce(t, next, [{ name: "regression", text: `Earlier tickets' tests now fail against your files. Output:\n${outs.join("\n\n")}\nFix the files and return them in full; keep every earlier ticket's rule.` }]);
    const files = parseFiles(t, r.text); if (files) commit(t, files);
    row.attempts.push({ lane, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, tests: null, regression_fix: true });
  }));
  failing = await regression(2);
}

// Review: cross statements + per-ticket statements of escalated tickets. Sharded when the prompt would be large; shards
// run in parallel, so sharding never adds wall time. A shard whose answer does not parse is an error.
const allFiles = [...new Set(tickets.flatMap((t) => t.writes))].sort();
const numbered = (f) => `=== ${f} ===\n` + readFileSync(resolve(work, f), "utf8").split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
const statements = [...tickets.filter((t) => rows.get(t.id)?.escalated).flatMap((t) => (checklist[String(t.id)] || []).map((q) => ({ ...q, files: t.writes }))), ...(checklist.cross || []).map((q) => ({ ...q, files: q.files || allFiles }))];
const promptFor = (qs) => { const files = [...new Set(qs.flatMap((q) => q.files))].sort(); return `You are the lead reviewer. Answer each numbered statement about the code below. YES means the statement is true of the code. Judge across files where a statement needs it. Output only a JSON array, one object per statement in order: {"id":"<id>","answer":"YES"|"NO","file":"<path or null>","line":<number or null>,"why":"<one line, max 25 words>"}.\n\n=== BRIEF ===\n${brief}\n\n=== FILES ===\n${files.map(numbered).join("\n\n")}\n\n=== STATEMENTS ===\n${qs.map((q, i) => `${i + 1}. id ${q.id} (${q.files.join(", ")}): ${q.text}`).join("\n")}`; };
const estTokens = (s) => Math.round(s.length / CHARS_PER_TOKEN);
let shards = [statements];
if (estTokens(promptFor(statements)) > REVIEW_SHARD_TOKENS) { const n = Math.ceil(estTokens(promptFor(statements)) / REVIEW_SHARD_TOKENS); const size = Math.ceil(statements.length / n); shards = Array.from({ length: n }, (_, i) => statements.slice(i * size, (i + 1) * size)).filter((s) => s.length); }
mark(`review start: ${statements.length} statements in ${shards.length} call${shards.length > 1 ? "s (parallel)" : ""}`);
await Promise.all(shards.map(async (qs) => {
  const rv = await askOpus([{ role: "user", content: promptFor(qs) }], { maxTokens: 4000 });
  const rr = res.opus.review; rr.calls++; rr.in += rv.usage.input; rr.out += rv.usage.output; rr.cost_usd += rv.usage.cost_usd || 0; rr.seconds = Math.max(rr.seconds, rv.seconds); rr.shards = shards.length;
  let arr = null; try { const p = JSON.parse(rv.text.replace(/```json|```/g, "").trim()); arr = Array.isArray(p) ? p : p.answers || p.results || null; } catch {}
  if (!arr) { res.errors.push(`review answer did not parse (${qs.length} statements): ${rv.text.slice(0, 160)}`); return; }
  qs.forEach((q, i) => { const a = arr.find((x) => String(x.id) === q.id) || arr[i]; if (!a) res.errors.push(`no answer for ${q.id}`); else if (/^NO$/i.test(String(a.answer))) res.findings.push({ id: q.id, file: a.file, line: a.line, why: a.why }); });
}));
res.wallSeconds = now();
mark(`review done${res.errors.length ? ` with ${res.errors.length} error(s)` : ""}`);
writeFileSync(resolve(args.out || resolve(work, "result.json")), JSON.stringify(res, null, 2));
for (const f of res.findings) console.log(`  finding ${f.id}: ${f.file}:${f.line} — ${f.why}`);
for (const e of res.errors) console.error(`  ERROR ${e}`);
const opusTok = res.opus.write.in + res.opus.write.out + res.opus.review.in + res.opus.review.out, qwenTok = res.qwen.in + res.qwen.out;
console.log(`\nqwen: ${res.qwen.calls} calls, ${qwenTok} tokens, ₹${res.qwen.inr.toFixed(2)}`);
console.log(`opus write: ${res.opus.write.calls} calls, ${res.opus.write.in + res.opus.write.out} tokens, $${res.opus.write.cost_usd.toFixed(4)}; review ${res.opus.review.calls} call(s), ${res.opus.review.in + res.opus.review.out} tokens, $${res.opus.review.cost_usd.toFixed(4)}, ${res.opus.review.seconds.toFixed(1)}s`);
console.log(`opus share ${(100 * opusTok / (opusTok + qwenTok)).toFixed(0)}% of all tokens (${opusTok} / ${opusTok + qwenTok}); opus ${(100 * opusTok / OPUS_ALONE_TOKENS).toFixed(0)}% of Opus-alone; tests ${res.tests.pass}/${res.tests.pass + res.tests.fail}; findings ${res.findings.length}; write ${res.writeSeconds}s, wall ${res.wallSeconds}s`);
if (res.errors.length) process.exit(1);
