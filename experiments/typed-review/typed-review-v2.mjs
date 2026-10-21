// Options D and E. qwen judges every statement in parallel (1 token each, probability from logprobs). Everything
// qwen is not confidently "fine" on goes to Opus in ONE call over the whole diff, answered as typed JSON.
//   D: default three-question list per ticket.        IS_WORKER_PROJECT=<dir> node typed-review-v2.mjs --out D.json
//   E: planner checklist + Score (pieces 1 and 2).    ... --checklist checklist-planner.json --out E.json
// Flags: --threshold 0.85  --dry (no Opus)  --concurrency 8  --nonce (default on: a fresh run id in the prompt so IndicStack's response cache cannot answer)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { askOpus as opusCall } from "./opus.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
const PROJECT = resolve(process.env.IS_WORKER_PROJECT || ".");
const ISW = resolve(PROJECT, ".is-worker");
const THRESH = Number(args.threshold || 0.85);
const DRY = Boolean(args.dry);
const CONC = Number(args.concurrency || 8);
const NONCE = args.nonce === "off" ? "" : `run ${Date.now()}`;
const OUT = resolve(String(args.out || resolve(ISW, "typed-review-v2.json")));
const CHECKLIST = args.checklist ? JSON.parse(readFileSync(resolve(String(args.checklist)), "utf8")) : null;

const keys = Object.fromEntries(readFileSync(resolve(homedir(), ".is-worker", "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const KEY = keys.IS_WORKER_KEY_A; if (!KEY) throw new Error("no IS_WORKER_KEY_A in ~/.is-worker/keys.env");
const BASE = "https://api.indicstack.ai/v1", MODEL = "qwen38-27b";
const QWEN_INR_PER_TOKEN = 1.3697810000000001 / (28241 + 4088); // 12 Oct run's blended rate

const brief = readFileSync(resolve(ISW, "BRIEF.md"), "utf8");
const tickets = readFileSync(resolve(ISW, "tickets.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fileText = (rel) => existsSync(resolve(PROJECT, rel)) ? readFileSync(resolve(PROJECT, rel), "utf8") : "(missing)";
const ruleText = (r) => { const m = brief.match(new RegExp(`^.*\\b${r}\\b.*$`, "m")); return m ? m[0].trim() : r; };
const allFiles = [...new Set(tickets.flatMap((t) => t.writes))].sort();
const wholeDiff = allFiles.map((f) => `--- ${f} ---\n${fileText(f)}`).join("\n\n");
const ticketCode = (t) => t.writes.map((w) => `--- ${w} ---\n${fileText(w)}`).join("\n\n");

// Statements: default list (as option A) or the planner's checklist. Each carries the code it is judged against.
function statements() {
  const out = [];
  for (const t of tickets) {
    const code = ticketCode(t);
    const list = CHECKLIST ? (CHECKLIST[String(t.id)] || []).map((q) => ({ ...q, kind: "planner" })) : [
      ...t.rules.map((r) => ({ id: `${t.id}.${r}`, kind: "rule", text: `The code meets rule ${r} of the brief: "${ruleText(r)}"` })),
      { id: `${t.id}.logic`, kind: "logic", text: "No function in the code mutates its argument, has an off-by-one error at an edge, leaks state between games, draws while ignoring state, or binds an input to the wrong target." },
      { id: `${t.id}.constants`, kind: "constants", text: "Every number used in the code is imported from constants.mjs, except the literals 0, 1, 2 and 1000." },
    ];
    for (const q of list) out.push({ ...q, ticket: t.id, code, files: t.writes });
  }
  if (CHECKLIST?.cross) for (const q of CHECKLIST.cross) out.push({ ...q, kind: "cross", ticket: "x", code: wholeDiff, files: allFiles });
  return out;
}

async function qwen(messages, maxTokens = 1) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0, logprobs: true, top_logprobs: 10, chat_template_kwargs: { enable_thinking: false } }) });
  const j = await res.json();
  return { j, seconds: (performance.now() - t0) / 1000, top: j.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs || [], tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 };
}
const SYS = (what) => `You are a code judge. You will be shown a brief, some code and one ${what}. ${NONCE ? `(${NONCE})` : ""}`;

// Noul: P(YES) from the YES/NO mass in the top logprobs.
async function noul(q) {
  const r = await qwen([{ role: "system", content: SYS("statement about the code. Reply with exactly one word: YES if the statement is true, NO if it is false.") },
    { role: "user", content: `=== BRIEF ===\n${brief}\n\n=== CODE ===\n${q.code}\n\n=== STATEMENT ===\n${q.text}\n\nAnswer YES or NO.` }]);
  let yes = 0, no = 0;
  for (const c of r.top) { const w = c.token.trim().toLowerCase(); if (w === "yes") yes += Math.exp(c.logprob); else if (w === "no") no += Math.exp(c.logprob); }
  return { pYes: yes + no > 0 ? yes / (yes + no) : null, seconds: r.seconds, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}
// Score (piece 1, TypeSafe's Score): one digit out; the score is the probability-weighted level, so 1.9 means "between 1 and 2".
async function score(t, sc) {
  const levels = sc.levels.map((l, i) => `${i + 1} = ${l}`).join("\n");
  const r = await qwen([{ role: "system", content: SYS(`question with ${sc.levels.length} ordered answers. Reply with exactly one digit, the number of the answer that fits best.`) },
    { role: "user", content: `=== BRIEF ===\n${brief}\n\n=== CODE ===\n${ticketCode(t)}\n\n=== QUESTION ===\n${sc.text}\n${levels}\n\nAnswer with one digit.` }]);
  let sum = 0, mass = 0;
  for (const c of r.top) { const d = Number(c.token.trim()); if (Number.isInteger(d) && d >= 1 && d <= sc.levels.length) { sum += d * Math.exp(c.logprob); mass += Math.exp(c.logprob); } }
  return { value: mass > 0 ? sum / mass : null, confidence: mass, seconds: r.seconds, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}

async function pool(items, fn, n) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

const results = { option: CHECKLIST ? "E" : "D", threshold: THRESH, concurrency: CONC, started: new Date().toISOString(), items: [], scores: [], qwen: { calls: 0, tokensIn: 0, tokensOut: 0, seconds: 0, wallSeconds: 0, inr: 0 }, opus: { calls: 0, input: 0, output: 0, cost_usd: 0, seconds: 0 }, findings: [] };
const add = (r) => { results.qwen.calls++; results.qwen.tokensIn += r.tokensIn; results.qwen.tokensOut += r.tokensOut; results.qwen.seconds += r.seconds; results.qwen.inr += (r.tokensIn + r.tokensOut) * QWEN_INR_PER_TOKEN; };
const tStart = performance.now();

const qs = statements();
const tq = performance.now();
const answers = await pool(qs, noul, CONC);
if (CHECKLIST?.score) results.scores = (await pool(tickets, async (t) => { const s = await score(t, CHECKLIST.score); add(s); return { ticket: t.id, risk: s.value == null ? null : Number(s.value.toFixed(2)), confidence: Number(s.confidence.toFixed(3)) }; }, CONC));
results.qwen.wallSeconds = Number(((performance.now() - tq) / 1000).toFixed(1));
const riskOf = (ticket) => results.scores.find((s) => s.ticket === ticket)?.risk ?? null;
const open = [];
qs.forEach((q, i) => {
  const a = answers[i]; add(a);
  const risky = riskOf(q.ticket) != null && riskOf(q.ticket) >= 2.5; // Score rule: a ticket qwen rates "likely a bug" is opened whole
  const item = { id: q.id, kind: q.kind, ticket: q.ticket, statement: q.text, qwen_p_fine: a.pYes, escalated: a.pYes == null || a.pYes < THRESH || risky, by: risky && a.pYes >= THRESH ? "score" : "threshold", opus: null };
  console.log(`${String(q.ticket).padStart(2)} ${q.kind.padEnd(9)} ${q.id.padEnd(18)} P(fine)=${a.pYes == null ? " n/a " : a.pYes.toFixed(3)} ${item.escalated ? "→ Opus" : "closed"}`);
  results.items.push(item); if (item.escalated) open.push({ q, item });
});
for (const s of results.scores) console.log(`risk t${s.ticket}: ${s.risk} (mass ${s.confidence})`);
console.log(`qwen: ${results.qwen.calls} calls in ${results.qwen.wallSeconds}s wall (${results.qwen.seconds.toFixed(1)}s summed), ${results.qwen.tokensIn} tok, ₹${results.qwen.inr.toFixed(2)}; open ${open.length}/${qs.length}`);

if (open.length && !DRY) {
  const list = open.map(({ q }, i) => `${i + 1}. [${q.id}] (${q.files.join(", ")}) ${q.text}`).join("\n");
  const prompt = `You are a code reviewer. Below is the brief and every game file. Answer each numbered statement. Output only a JSON array, one object per statement in order: {"id":"<id>","answer":"YES"|"NO","file":"<path or null>","line":<number or null>,"why":"<one line, max 25 words>"}. YES means the statement is true. Judge across files where a statement needs it.\n\n=== BRIEF ===\n${brief}\n\n=== FILES ===\n${wholeDiff}\n\n=== STATEMENTS ===\n${list}`;
  const r = await opusCall([{ role: "user", content: prompt }], { maxTokens: 4000 });
  results.opus = { calls: 1, input: r.usage.input, output: r.usage.output, cost_usd: r.usage.cost_usd || 0, seconds: Number(r.seconds.toFixed(1)), raw: r.text };
  let arr = []; try { const p = JSON.parse(r.text.replace(/```json|```/g, "").trim()); arr = Array.isArray(p) ? p : p.answers || p.results || []; } catch {}
  open.forEach(({ q, item }, idx) => {
    const ans = arr.find((x) => String(x.id).replace(/[\[\]]/g, "") === q.id) || arr[idx] || { answer: "MISSING" };
    item.opus = ans;
    console.log(`   ${q.id.padEnd(18)} ${ans.answer} ${ans.file || ""}:${ans.line ?? "-"} — ${ans.why || ""}`);
    if (ans.answer === "NO") results.findings.push({ id: q.id, kind: q.kind, file: ans.file, line: ans.line, why: ans.why });
  });
  console.log(`opus: 1 call, in ${r.usage.input} out ${r.usage.output}, $${(r.usage.cost_usd || 0).toFixed(4)}, ${r.seconds.toFixed(1)}s`);
}
results.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(1));
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`findings: ${results.findings.length}; wall ${results.wallSeconds}s; written ${OUT}`);
