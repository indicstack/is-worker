// Option F: split the writing by the dependency graph. qwen (serial, one request at a time on IndicStack) writes every
// ticket except the critical-path tail — the ticket(s) with the most deps — which Opus writes, since that ticket is the
// long pole (ticket 6: 50 s on qwen over two attempts, 27 s on Opus). No qwen gate: Opus answers the whole planner
// checklist in one typed call over the full diff. Budget: Opus tokens under 3/5 of Opus-alone (37,553 → 22,532).
//   IS_WORKER_PROJECT=<dir> node option-f.mjs [--frontier 6] [--out F.json]
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { askOpus } from "./opus.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length));
const PROJECT = resolve(process.env.IS_WORKER_PROJECT);
const ISW = resolve(PROJECT, ".is-worker");
const { buildMessages, buildBody, loadTickets } = await import("../../lib/prompt.mjs");
const keys = Object.fromEntries(readFileSync(resolve(homedir(), ".is-worker", "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const QWEN = { key: keys.IS_WORKER_KEY_A, base: "https://api.indicstack.ai/v1", model: "qwen38-27b" };
const QWEN_INR_PER_TOKEN = 1.3697810000000001 / (28241 + 4088);

const tickets = loadTickets();
const maxDeps = Math.max(...tickets.map((t) => (t.deps || []).length));
const frontierIds = new Set(args.frontier ? String(args.frontier).split(",").map(Number) : tickets.filter((t) => (t.deps || []).length === maxDeps && maxDeps > 0).map((t) => t.id));
const work = resolve(tmpdir(), `option-f-${Date.now()}`);
mkdirSync(resolve(work, "game"), { recursive: true });
cpSync(resolve(PROJECT, "game/constants.mjs"), resolve(work, "game/constants.mjs"));
const brief = readFileSync(resolve(ISW, "BRIEF.md"), "utf8");
const checklist = JSON.parse(readFileSync(resolve(ISW, "checklist.json"), "utf8"));

const res = { frontier: [...frontierIds], work, tickets: [], qwen: { calls: 0, in: 0, out: 0, seconds: 0, inr: 0 }, opus: { write: { calls: 0, in: 0, out: 0, cost_usd: 0, seconds: 0 }, review: { in: 0, out: 0, cost_usd: 0, seconds: 0 } }, tests: { pass: 0, fail: 0 }, findings: [] };

async function qwenWrite(messages, temperature) {
  const body = { ...buildBody({ model: QWEN.model, messages, maxTokens: 2048, thinking: false, temperature }), stream: false };
  delete body.stream_options;
  const t0 = performance.now();
  const r = await fetch(`${QWEN.base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${QWEN.key}` }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(`IndicStack: ${JSON.stringify(j.error).slice(0, 200)}`);
  const u = j.usage || {};
  return { text: j.choices?.[0]?.message?.content || "", seconds: (performance.now() - t0) / 1000, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cost: Number.isFinite(u.cost) ? u.cost : null } };
}
function runTests(t) {
  const tr = spawnSync("node", ["--test", resolve(ISW, t.test)], { cwd: PROJECT, encoding: "utf8", env: { ...process.env, IS_WORKER_WORK: work } });
  const out = tr.stdout + tr.stderr;
  return { pass: Number((out.match(/^(?:ℹ|#) pass (\d+)/m) || [0, 0])[1]), fail: Number((out.match(/^(?:ℹ|#) fail (\d+)/m) || [0, 0])[1]), out };
}
const writeFiles = (t, text) => { let files = null; try { files = JSON.parse(text.replace(/^```json\s*|```\s*$/g, "").trim()).files; } catch {} if (!files) return false; for (const f of files) { if (!t.writes.includes(f.path)) continue; mkdirSync(dirname(resolve(work, f.path)), { recursive: true }); writeFileSync(resolve(work, f.path), f.content); } return true; };

// Topological order (deps first), as the harness runs them.
const order = []; const done = new Set();
while (order.length < tickets.length) for (const t of tickets) if (!done.has(t.id) && (t.deps || []).every((d) => done.has(d))) { order.push(t); done.add(t.id); }

const tStart = performance.now();
for (const t of order) {
  const who = frontierIds.has(t.id) ? "opus" : "qwen";
  const row = { id: t.id, who, attempts: [] };
  let fixes = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = buildMessages(t, work, fixes, "option-F");
    let r;
    if (who === "qwen") { r = await qwenWrite(messages, attempt === 1 ? 0 : 0.5); res.qwen.calls++; res.qwen.in += r.usage.input; res.qwen.out += r.usage.output; res.qwen.seconds += r.seconds; res.qwen.inr += r.usage.cost ?? (r.usage.input + r.usage.output) * QWEN_INR_PER_TOKEN; }
    else { r = await askOpus(messages, { maxTokens: 6000 }); const w = res.opus.write; w.calls++; w.in += r.usage.input; w.out += r.usage.output; w.cost_usd += r.usage.cost_usd || 0; w.seconds += r.seconds; }
    const parsed = writeFiles(t, r.text);
    const tr = parsed ? runTests(t) : { pass: 0, fail: 1, out: "unparsed" };
    row.attempts.push({ attempt, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, parsed, tests: { pass: tr.pass, fail: tr.fail } });
    console.log(`t${t.id} ${who} attempt ${attempt}: ${tr.pass} pass ${tr.fail} fail, ${r.usage.input} in ${r.usage.output} out, ${r.seconds.toFixed(1)}s`);
    if (tr.fail === 0 && tr.pass > 0) { res.tests.pass += tr.pass; break; }
    if (attempt === 2) { res.tests.pass += tr.pass; res.tests.fail += tr.fail; }
    fixes = [{ name: "test-output", text: `The tests failed. Output:\n${tr.out.slice(0, 3000)}\nFix the files and return them in full.` }];
  }
  res.tickets.push(row);
}
res.writeSeconds = Number(((performance.now() - tStart) / 1000).toFixed(1));

// Typed review, no gate: every checklist statement, one Opus call over the whole diff.
const allFiles = [...new Set(tickets.flatMap((t) => t.writes))].sort();
const diff = allFiles.map((f) => `=== ${f} ===\n` + readFileSync(resolve(work, f), "utf8").split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n")).join("\n\n");
const statements = [...tickets.flatMap((t) => (checklist[String(t.id)] || []).map((q) => ({ ...q, files: t.writes }))), ...(checklist.cross || []).map((q) => ({ ...q, files: allFiles }))];
const list = statements.map((q, i) => `${i + 1}. id ${q.id} (${q.files.join(", ")}): ${q.text}`).join("\n");
const prompt = `You are the lead reviewer. Answer each numbered statement about the code below. YES means the statement is true of the code. Judge across files where a statement needs it. Output only a JSON array, one object per statement in order: {"id":"<id>","answer":"YES"|"NO","file":"<path or null>","line":<number or null>,"why":"<one line, max 25 words>"}.\n\n=== BRIEF ===\n${brief}\n\n=== FILES ===\n${diff}\n\n=== STATEMENTS ===\n${list}`;
const rv = await askOpus([{ role: "user", content: prompt }], { maxTokens: 4000 });
res.opus.review = { in: rv.usage.input, out: rv.usage.output, cost_usd: rv.usage.cost_usd || 0, seconds: Number(rv.seconds.toFixed(1)) };
let arr = []; try { arr = JSON.parse(rv.text.replace(/```json|```/g, "").trim()); } catch {}
statements.forEach((q, i) => { const a = arr.find((x) => String(x.id) === q.id) || arr[i]; if (a && /^NO$/i.test(String(a.answer))) res.findings.push({ id: q.id, file: a.file, line: a.line, why: a.why }); });
res.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(1));
writeFileSync(resolve(args.out || resolve(work, "result.json")), JSON.stringify(res, null, 2));
for (const f of res.findings) console.log(`  finding ${f.id}: ${f.file}:${f.line} — ${f.why}`);
const ot = res.opus.write.in + res.opus.write.out + res.opus.review.in + res.opus.review.out;
console.log(`\nqwen: ${res.qwen.calls} calls, ${res.qwen.in} in ${res.qwen.out} out, ₹${res.qwen.inr.toFixed(2)}, ${res.qwen.seconds.toFixed(1)}s`);
console.log(`opus write: ${res.opus.write.calls} calls, ${res.opus.write.in} in ${res.opus.write.out} out, $${res.opus.write.cost_usd.toFixed(4)}, ${res.opus.write.seconds.toFixed(1)}s`);
console.log(`opus review: ${res.opus.review.in} in ${res.opus.review.out} out, $${res.opus.review.cost_usd.toFixed(4)}, ${res.opus.review.seconds}s`);
console.log(`opus tokens total ${ot} (${(100 * ot / 37553).toFixed(0)}% of Opus-alone); tests ${res.tests.pass}/${res.tests.pass + res.tests.fail}; findings ${res.findings.length}; write ${res.writeSeconds}s, wall ${res.wallSeconds}s`);
