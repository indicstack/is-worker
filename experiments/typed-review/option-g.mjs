// Option G: contract-first, two lanes, commit in order.
//   * Contract-first: the frozen brief pins every interface, so EVERY ticket starts at t=0. A dependency orders the
//     COMMIT and the TEST of a ticket, not its writing. 'reads' files that do not exist yet are simply absent from the prompt.
//   * Two lanes: the qwen lane runs up to review_lane_qwen_concurrency tickets at once (IndicStack batches: 4 ticket-sized
//     calls took 7.5 s against 5.5 s for one). The Opus lane takes the tickets with the longest expected qwen time
//     (longest-first) while Opus stays under opus_token_share of all tokens — the knapsack rule — or none with --all-qwen.
//   * Commit in order: a ticket's files are written to the work dir only after every dep has committed, so when two
//     tickets write the same file the later one in dependency order wins, whichever finished first.
//   * Escalate, don't retry: a ticket whose test fails goes to the OTHER lane at once (qwen → Opus with the test output;
//     Opus → qwen); the lane it came from moves on. One escalation per ticket.
//   * Review: cross-file statements only (per-ticket statements never found a bug; tests pin per-ticket behaviour), plus
//     the per-ticket statements of any ticket that was escalated. One Opus call, no gate.
//   IS_WORKER_PROJECT=<dir> node option-g.mjs [--all-qwen] [--frontier 6] [--qwen-concurrency 4] [--out G.json]
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { askOpus } from "./opus.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
const PROJECT = resolve(process.env.IS_WORKER_PROJECT);
const ISW = resolve(PROJECT, ".is-worker");
const { buildMessages, buildBody, loadTickets } = await import("../../lib/prompt.mjs");
const keys = Object.fromEntries(readFileSync(resolve(homedir(), ".is-worker", "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const QWEN = { key: keys.IS_WORKER_KEY_A, base: "https://api.indicstack.ai/v1", model: "qwen38-27b" };
const QWEN_INR_PER_TOKEN = 1.3697810000000001 / (28241 + 4088);
const QWEN_CONC = Number(args["qwen-concurrency"] || 4);
const OPUS_SHARE_MAX = 0.4;          // owner's rule: qwen ≥ 3/5 of all tokens
const QWEN_TPS = 50, OPUS_TPS = 120;  // measured 21 Oct
// Expected qwen output tokens per ticket from the 12 Oct calibration run (completion_tokens of attempt 1); any project
// would take these from state/calibration-A.json. Unknown tickets: estimated from the task text length.
const CAL = { 1: 490, 2: 203, 3: 398, 4: 301, 5: 261, 6: 1239 };
const CHARS_PER_TOKEN = 3.45;

const tickets = loadTickets();
const brief = readFileSync(resolve(ISW, "BRIEF.md"), "utf8");
const checklist = JSON.parse(readFileSync(resolve(ISW, "checklist.json"), "utf8"));
const work = resolve(tmpdir(), `option-g-${Date.now()}`);
mkdirSync(resolve(work, "game"), { recursive: true });
cpSync(resolve(PROJECT, "game/constants.mjs"), resolve(work, "game/constants.mjs"));

// Lane assignment: the knapsack rule. Expected qwen seconds = ttft + out/QWEN_TPS; expected Opus tokens = prompt (~1.2× the
// qwen prompt, no reads) + out. Take tickets longest-first into the Opus lane while Opus tokens / all tokens ≤ OPUS_SHARE_MAX,
// counting the review's expected Opus tokens too.
const expOut = (t) => CAL[t.id] ?? Math.round(t.task.length / CHARS_PER_TOKEN * 1.5);
const expPrompt = (t) => Math.round((brief.length + 1200 + t.task.length + 2500) / CHARS_PER_TOKEN); // rules + brief + test + ticket
const REVIEW_OPUS_TOKENS = 7500;
let frontier = new Set();
if (args.frontier) frontier = new Set(String(args.frontier).split(",").map(Number));
else if (!args["all-qwen"]) {
  const byTime = [...tickets].sort((a, b) => expOut(b) - expOut(a));
  let opusTok = REVIEW_OPUS_TOKENS, qwenTok = tickets.reduce((s, t) => s + expPrompt(t) + expOut(t), 0);
  for (const t of byTime) {
    const o = Math.round(expPrompt(t) * 1.1) + expOut(t), q = expPrompt(t) + expOut(t);
    if ((opusTok + o) / (opusTok + o + qwenTok - q) <= OPUS_SHARE_MAX && expOut(t) / QWEN_TPS > 10) { frontier.add(t.id); opusTok += o; qwenTok -= q; } else break;
  }
}
console.log(`lanes: opus ← tickets [${[...frontier].join(", ") || "none"}], qwen ← the rest (concurrency ${QWEN_CONC})`);

const res = { frontier: [...frontier], qwenConcurrency: QWEN_CONC, work, tickets: [], qwen: { calls: 0, in: 0, out: 0, seconds: 0, inr: 0 }, opus: { write: { calls: 0, in: 0, out: 0, cost_usd: 0, seconds: 0 }, review: { in: 0, out: 0, cost_usd: 0, seconds: 0 } }, tests: { pass: 0, fail: 0 }, findings: [], timeline: [] };
const RUN_ID = `option-G-${Date.now()}`;
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
const commit = (files) => { for (const f of files) { mkdirSync(dirname(resolve(work, f.path)), { recursive: true }); writeFileSync(resolve(work, f.path), f.content); } };
function runTests(t, extraTests = []) {
  const tr = spawnSync("node", ["--test", resolve(ISW, t.test), ...extraTests.map((x) => resolve(ISW, x))], { cwd: PROJECT, encoding: "utf8", env: { ...process.env, IS_WORKER_WORK: work } });
  const out = tr.stdout + tr.stderr;
  return { pass: Number((out.match(/^(?:ℹ|#) pass (\d+)/m) || [0, 0])[1]), fail: Number((out.match(/^(?:ℹ|#) fail (\d+)/m) || [0, 0])[1]), out };
}

// A small semaphore for the qwen lane.
let qwenBusy = 0; const qwenWaiters = [];
const qwenSlot = () => new Promise((ok) => { const tryGo = () => { if (qwenBusy < QWEN_CONC) { qwenBusy++; ok(() => { qwenBusy--; const n = qwenWaiters.shift(); if (n) n(); }); } else qwenWaiters.push(tryGo); }; tryGo(); });

// Commit-in-order: a ticket commits only after its deps have committed. The promise map makes that a simple await.
const committed = new Map(); // ticket id → promise resolving when its files are in the work dir and its test has run
const rows = new Map();

// Contract-first makes this static: tickets.jsonl says which earlier tickets share a file with t, so their tests go into
// t's prompt up front instead of being discovered by a regression pass afterwards.
const topoOrder = []; { const seen = new Set(); while (topoOrder.length < tickets.length) for (const x of tickets) if (!seen.has(x.id) && (x.deps || []).every((d) => seen.has(d))) { topoOrder.push(x); seen.add(x.id); } }
const keepGreen = (t) => topoOrder.filter((w) => w.id !== t.id && topoOrder.indexOf(w) < topoOrder.indexOf(t) && w.writes.some((f) => t.writes.includes(f)))
  .map((w) => ({ name: `keep-green ${w.test}`, text: `You are rewriting ${w.writes.filter((f) => t.writes.includes(f)).join(", ")}, which ticket ${w.id} also wrote. Its test below must still pass:\n${readFileSync(resolve(ISW, w.test), "utf8")}` }));

async function produce(t, lane, fixes) {
  // The prompt is built at call time: 'reads' that are already committed appear, the rest are absent (contract-first).
  const messages = buildMessages(t, work, [...keepGreen(t), ...fixes], RUN_ID);
  if (lane === "qwen") { const release = await qwenSlot(); try { mark(`t${t.id} qwen start${fixes.length ? " (escalated)" : ""}`); return { lane, r: await qwenWrite(messages, fixes.length ? 0.5 : 0) }; } finally { release(); } }
  mark(`t${t.id} opus start${fixes.length ? " (escalated)" : ""}`);
  return { lane, r: await opusWrite(messages) };
}

async function runTicket(t) {
  const lane = frontier.has(t.id) ? "opus" : "qwen";
  const row = { id: t.id, lane, attempts: [] }; rows.set(t.id, row);
  // Write now, commit later: the write starts at t=0 for every ticket.
  const first = produce(t, lane, []);
  await Promise.all((t.deps || []).map((d) => committed.get(d)));
  let { lane: usedLane, r } = await first;
  let files = parseFiles(t, r.text);
  mark(`t${t.id} ${usedLane} done in ${r.seconds.toFixed(1)}s, committing`);
  if (files) commit(files);
  const shared = keepGreen(t).map((k) => k.name.replace("keep-green ", "")); // the co-writers' tests run with the ticket's own
  let tr = files ? runTests(t, shared) : { pass: 0, fail: 1, out: "unparsed" };
  row.attempts.push({ lane: usedLane, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, tests: { pass: tr.pass, fail: tr.fail } });
  // Escalation ladder: a failed qwen ticket retries on qwen first if the lane has a free slot (cheap, and it runs beside the
  // other tickets), then goes to Opus; a failed Opus ticket goes to qwen. Two escalations at most.
  for (let n = 0; (tr.fail || !tr.pass) && n < 2; n++) {
    const next = usedLane === "opus" ? "qwen" : n === 0 && qwenBusy < QWEN_CONC ? "qwen" : "opus";
    mark(`t${t.id} ${tr.pass}/${tr.pass + tr.fail} tests → escalate to ${next}`);
    row.escalated = true;
    ({ lane: usedLane, r } = await produce(t, next, [{ name: "test-output", text: `The tests failed. Output:\n${tr.out.slice(0, 3000)}\nFix the files and return them in full.` }]));
    files = parseFiles(t, r.text); if (files) commit(files);
    tr = files ? runTests(t, shared) : { pass: 0, fail: 1, out: "unparsed" };
    row.attempts.push({ lane: usedLane, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, tests: { pass: tr.pass, fail: tr.fail } });
  }
  mark(`t${t.id} tests ${tr.pass}/${tr.pass + tr.fail}`);
  res.tickets.push(row);
}
for (const t of tickets) committed.set(t.id, (async () => { await runTicket(t); })());
await Promise.all(committed.values());
res.writeSeconds = now();
// Final regression: every test once more against the finished tree (a later ticket may rewrite an earlier one's file).
// A failing test of ticket k is blamed on the LAST ticket in dependency order that writes one of k's files; that ticket is
// escalated to the other lane with the failing output (one round), then the regression runs again.
const topo = []; { const seen = new Set(); while (topo.length < tickets.length) for (const t of tickets) if (!seen.has(t.id) && (t.deps || []).every((d) => seen.has(d))) { topo.push(t); seen.add(t.id); } }
async function regression(round) {
  res.tests = { pass: 0, fail: 0 }; const failing = [];
  for (const t of tickets) { const tr = runTests(t); res.tests.pass += tr.pass; res.tests.fail += tr.fail; if (tr.fail) failing.push({ t, tr }); }
  mark(`regression ${round}: ${res.tests.pass}/${res.tests.pass + res.tests.fail}`);
  return failing;
}
let failing = await regression(1);
if (failing.length) {
  const fixes = new Map(); // blamed ticket → failing outputs
  for (const { t, tr } of failing) { const blamed = [...topo].reverse().find((w) => w.writes.some((f) => t.writes.includes(f))) || t; if (!fixes.has(blamed.id)) fixes.set(blamed.id, []); fixes.get(blamed.id).push(`test ${t.test}:\n${tr.out.slice(0, 2500)}`); }
  await Promise.all([...fixes].map(async ([id, outs]) => {
    const t = tickets.find((x) => x.id === id), row = rows.get(id);
    const other = row.attempts.at(-1).lane === "opus" ? "qwen" : qwenBusy < QWEN_CONC && !row.attempts.some((a) => a.regression_fix) ? "qwen" : "opus";
    mark(`regression blames t${id} → escalate to ${other}`); row.escalated = true;
    const { lane, r } = await produce(t, other, [{ name: "regression", text: `Earlier tickets' tests now fail against your files. Output:\n${outs.join("\n\n")}\nFix the files and return them in full; keep every earlier ticket's rule.` }]);
    const files = parseFiles(t, r.text); if (files) commit(files);
    row.attempts.push({ lane, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, tests: null, regression_fix: true });
  }));
  failing = await regression(2);
}

// Review: cross statements + per-ticket statements of escalated tickets. One Opus call.
const allFiles = [...new Set(tickets.flatMap((t) => t.writes))].sort();
const diff = allFiles.map((f) => `=== ${f} ===\n` + readFileSync(resolve(work, f), "utf8").split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n")).join("\n\n");
const statements = [...tickets.filter((t) => rows.get(t.id)?.escalated).flatMap((t) => (checklist[String(t.id)] || []).map((q) => ({ ...q, files: t.writes }))), ...(checklist.cross || []).map((q) => ({ ...q, files: allFiles }))];
const list = statements.map((q, i) => `${i + 1}. id ${q.id} (${q.files.join(", ")}): ${q.text}`).join("\n");
const prompt = `You are the lead reviewer. Answer each numbered statement about the code below. YES means the statement is true of the code. Judge across files where a statement needs it. Output only a JSON array, one object per statement in order: {"id":"<id>","answer":"YES"|"NO","file":"<path or null>","line":<number or null>,"why":"<one line, max 25 words>"}.\n\n=== BRIEF ===\n${brief}\n\n=== FILES ===\n${diff}\n\n=== STATEMENTS ===\n${list}`;
mark(`review start: ${statements.length} statements`);
const rv = await askOpus([{ role: "user", content: prompt }], { maxTokens: 3000 });
res.opus.review = { in: rv.usage.input, out: rv.usage.output, cost_usd: rv.usage.cost_usd || 0, seconds: Number(rv.seconds.toFixed(1)), statements: statements.length };
let arr = []; try { arr = JSON.parse(rv.text.replace(/```json|```/g, "").trim()); } catch {}
statements.forEach((q, i) => { const a = arr.find((x) => String(x.id) === q.id) || arr[i]; if (a && /^NO$/i.test(String(a.answer))) res.findings.push({ id: q.id, file: a.file, line: a.line, why: a.why }); });
res.wallSeconds = now();
mark("review done");
writeFileSync(resolve(args.out || resolve(work, "result.json")), JSON.stringify(res, null, 2));
for (const f of res.findings) console.log(`  finding ${f.id}: ${f.file}:${f.line} — ${f.why}`);
const opusTok = res.opus.write.in + res.opus.write.out + res.opus.review.in + res.opus.review.out, qwenTok = res.qwen.in + res.qwen.out;
console.log(`\nqwen: ${res.qwen.calls} calls, ${qwenTok} tokens, ₹${res.qwen.inr.toFixed(2)}`);
console.log(`opus write: ${res.opus.write.calls} calls, ${res.opus.write.in + res.opus.write.out} tokens, $${res.opus.write.cost_usd.toFixed(4)}; review ${res.opus.review.in + res.opus.review.out} tokens, $${res.opus.review.cost_usd.toFixed(4)}, ${res.opus.review.seconds}s`);
console.log(`opus share ${(100 * opusTok / (opusTok + qwenTok)).toFixed(0)}% of all tokens (${opusTok} / ${opusTok + qwenTok}); opus ${(100 * opusTok / 37553).toFixed(0)}% of Opus-alone; tests ${res.tests.pass}/${res.tests.pass + res.tests.fail}; findings ${res.findings.length}; write ${res.writeSeconds}s, wall ${res.wallSeconds}s`);
