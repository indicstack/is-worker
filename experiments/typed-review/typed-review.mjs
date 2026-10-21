// Option A: TypeSafe-style typed review. qwen answers YES/NO statements with a real probability
// (from logprobs, 1 output token). Only statements qwen is not confidently "fine" on go to Opus,
// with just that ticket's file(s) and that one question. Opus answers typed JSON, not prose.
//   IS_WORKER_PROJECT=<dir> node typed-review.mjs [--threshold 0.85] [--dry] [--out results.json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { askOpus as opusCall } from "./opus.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
const PROJECT = resolve(process.env.IS_WORKER_PROJECT || ".");
const ISW = resolve(PROJECT, ".is-worker");
const THRESH = Number(args.threshold || 0.85); // qwen must be at least this sure "fine" to close an item without Opus
const DRY = Boolean(args.dry);
const OUT = resolve(String(args.out || resolve(PROJECT, ".is-worker", "typed-review.json")));

const keys = Object.fromEntries(readFileSync(resolve(homedir(), ".is-worker", "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const KEY = keys.IS_WORKER_KEY_A; if (!KEY) throw new Error("no IS_WORKER_KEY_A in ~/.is-worker/keys.env");
const BASE = "https://api.indicstack.ai/v1", MODEL = "qwen38-27b";
// IndicStack's run on 12 Oct billed ₹1.37 for 32,329 worker tokens; typed calls are priced at that blended rate.
const QWEN_INR_PER_TOKEN = 1.3697810000000001 / (28241 + 4088);

const brief = readFileSync(resolve(ISW, "BRIEF.md"), "utf8");
const tickets = readFileSync(resolve(ISW, "tickets.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fileText = (rel) => existsSync(resolve(PROJECT, rel)) ? readFileSync(resolve(PROJECT, rel), "utf8") : "(missing)";
const ruleText = (r) => { const m = brief.match(new RegExp(`^.*\\b${r}\\b.*$`, "m")); return m ? m[0].trim() : r; };

// The checklist. Each statement is phrased so YES = "this is fine". Three kinds, mirroring PROMPT-REVIEW.md checks 1-3.
function questionsFor(t) {
  const qs = t.rules.map((r) => ({ id: `${t.id}.${r}`, kind: "rule", text: `The code meets rule ${r} of the brief: "${ruleText(r)}"` }));
  qs.push({ id: `${t.id}.logic`, kind: "logic", text: "No function in the code mutates its argument, has an off-by-one error at an edge, leaks state between games, draws while ignoring state, or binds an input to the wrong target." });
  qs.push({ id: `${t.id}.constants`, kind: "constants", text: "Every number used in the code is imported from constants.mjs, except the literals 0, 1, 2 and 1000." });
  return qs;
}

// One token out. P(YES) from the top logprobs, normalised over the YES/NO variants that appear.
async function askQwen(statement, code) {
  const messages = [
    { role: "system", content: "You are a code judge. You will be shown a brief, some code and one statement about the code. Reply with exactly one word: YES if the statement is true, NO if it is false." },
    { role: "user", content: `=== BRIEF ===\n${brief}\n\n=== CODE ===\n${code}\n\n=== STATEMENT ===\n${statement}\n\nAnswer YES or NO.` },
  ];
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 10, chat_template_kwargs: { enable_thinking: false } }) });
  const j = await res.json();
  const seconds = (performance.now() - t0) / 1000;
  const top = j.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs || [];
  let yes = 0, no = 0;
  for (const c of top) { const w = c.token.trim().toLowerCase(); if (w === "yes") yes += Math.exp(c.logprob); else if (w === "no") no += Math.exp(c.logprob); }
  const pYes = yes + no > 0 ? yes / (yes + no) : null;
  return { pYes, seconds, tokensIn: j.usage?.prompt_tokens ?? null, tokensOut: j.usage?.completion_tokens ?? null, raw: j.choices?.[0]?.message?.content };
}

// Opus gets one file set and every open question for that ticket in ONE call (one state, many questions); typed JSON back.
async function askOpus(qs, t, code) {
  const list = qs.map((q, i) => `${i + 1}. [${q.id}] ${q.text}`).join("\n");
  const prompt = `You are a code reviewer. Answer each numbered statement about the code below. Output only a JSON array, one object per statement in order: {"id":"<id>","answer":"YES"|"NO","line":<number or null>,"why":"<one line, max 25 words>"}. YES means the statement is true.\n\n=== RELEVANT BRIEF LINES ===\n${t.rules.map(ruleText).join("\n")}\n\n=== CODE (${t.writes.join(", ")}) ===\n${code}\n\n=== STATEMENTS ===\n${list}`;
  const r = await opusCall([{ role: "user", content: prompt }], { maxTokens: 1500 });
  let ans = []; try { ans = JSON.parse(r.text.replace(/```json|```/g, "").trim()); } catch { ans = qs.map((q) => ({ id: q.id, answer: "UNPARSED", why: r.text.slice(0, 200) })); }
  return { ans, raw: r.text, seconds: r.seconds, usage: r.usage };
}

const results = { threshold: THRESH, started: new Date().toISOString(), items: [], qwen: { calls: 0, tokensIn: 0, tokensOut: 0, seconds: 0, inr: 0 }, opus: { calls: 0, input: 0, output: 0, cost_usd: 0, seconds: 0 }, findings: [] };
const tStart = performance.now();
for (const t of tickets) {
  const code = t.writes.map((w) => `--- ${w} ---\n${fileText(w)}`).join("\n\n");
  const open = [];
  for (const q of questionsFor(t)) {
    const a = await askQwen(q.text, code);
    results.qwen.calls++; results.qwen.tokensIn += a.tokensIn || 0; results.qwen.tokensOut += a.tokensOut || 0; results.qwen.seconds += a.seconds;
    results.qwen.inr += ((a.tokensIn || 0) + (a.tokensOut || 0)) * QWEN_INR_PER_TOKEN;
    const item = { id: q.id, kind: q.kind, ticket: t.id, statement: q.text, qwen_p_fine: a.pYes, qwen_seconds: Number(a.seconds.toFixed(2)), escalated: a.pYes == null || a.pYes < THRESH, opus: null };
    console.log(`t${t.id} ${q.kind.padEnd(9)} qwen P(fine)=${a.pYes == null ? "n/a" : a.pYes.toFixed(3)} ${item.escalated ? "→ Opus" : "closed"} (${a.seconds.toFixed(1)}s, ${a.tokensIn} tok)`);
    results.items.push(item);
    if (item.escalated) open.push({ q, item });
  }
  if (open.length && !DRY) {
    const o = await askOpus(open.map((x) => x.q), t, code);
    results.opus.calls++; results.opus.input += o.usage.input; results.opus.output += o.usage.output; results.opus.cost_usd += o.usage.cost_usd || 0; results.opus.seconds += o.seconds;
    console.log(`   Opus t${t.id}: ${open.length} questions, ${o.seconds.toFixed(1)}s, $${(o.usage.cost_usd || 0).toFixed(4)}`);
    results.opusRaw = results.opusRaw || {}; results.opusRaw[t.id] = o.raw;
    for (const { q, item } of open) {
      const arr = Array.isArray(o.ans) ? o.ans : Array.isArray(o.ans?.answers) ? o.ans.answers : Array.isArray(o.ans?.results) ? o.ans.results : [];
      const idx = open.findIndex((x) => x.q.id === q.id);
      const ans = arr.find((x) => String(x.id).replace(/[\[\]]/g, "") === q.id) || arr[idx] || { answer: "MISSING", why: String(o.raw).slice(0, 200) };
      item.opus = { ...ans, usage_share: open.length };
      console.log(`     ${q.id}: ${ans.answer} line ${ans.line ?? "-"} — ${ans.why || ""}`);
      if (ans.answer === "NO") results.findings.push({ ticket: t.id, kind: q.kind, file: t.writes.join(", "), line: ans.line, why: ans.why });
    }
  }
}
results.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(1));
results.finished = new Date().toISOString();
mkdirSync(resolve(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\nqwen: ${results.qwen.calls} calls, ${results.qwen.tokensIn} tok in, ${results.qwen.seconds.toFixed(1)}s, ₹${results.qwen.inr.toFixed(3)}`);
console.log(`opus: ${results.opus.calls} calls, in ${results.opus.input} out ${results.opus.output}, $${results.opus.cost_usd.toFixed(4)}, ${results.opus.seconds.toFixed(1)}s`);
console.log(`findings: ${results.findings.length}; wall ${results.wallSeconds}s; written ${OUT}`);
