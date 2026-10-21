// The typed review's first half: the worker model (qwen, the same key as the run) judges every checklist statement with
// one token and its logprobs give P(fine). Statements it is not sure enough about are "open" and go to the frontier
// reviewer; the rest close here for about ₹0.10 each. One Score per ticket (how likely an uncaught bug is) can open a
// whole ticket. Writes <run>/typed-gate.json. Statements come from <project>/.is-worker/checklist.json (the planner
// writes it with the tickets); without one, three generic statements per ticket are used and the output says so.
//   node review/typed-gate.mjs --run runs/<id> [--tickets 3,5] [--dry]       (IS_WORKER_PROJECT set)
//   --no-gate [--troubled 3,5]: no worker-model calls (the default review since 0.8.3): every cross statement is open,
//   plus the per-ticket statements of the troubled tickets (retried, queued or failed). Per-ticket statements of clean
//   tickets are skipped: their tests already pinned them, and across every measured run they never produced a finding.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Normalised mass on YES vs NO among the top logprobs of the first token; null when neither appears.
export function pFine(topLogprobs) {
  let yes = 0, no = 0;
  for (const c of topLogprobs || []) { const w = String(c.token).trim().toLowerCase(); if (w === "yes") yes += Math.exp(c.logprob); else if (w === "no") no += Math.exp(c.logprob); }
  return yes + no > 0 ? yes / (yes + no) : null;
}
// Probability-weighted level (1..n) from the digit tokens in the top logprobs; mass is how much of the distribution was digits.
export function scoreValue(topLogprobs, nLevels) {
  let sum = 0, mass = 0;
  for (const c of topLogprobs || []) { const d = Number(String(c.token).trim()); if (Number.isInteger(d) && d >= 1 && d <= nLevels) { sum += d * Math.exp(c.logprob); mass += Math.exp(c.logprob); } }
  return { value: mass > 0 ? sum / mass : null, mass };
}
// The statements to judge. Checklist shape: { "score": {text, levels[]}, "<ticket id>": [{id, text}], "cross": [{id, text}] }.
// YES always means "fine". Without a checklist: the ticket's rules, one logic and one constants statement (generic; weak at cross-file bugs).
export function statementsFor(tickets, checklist, ruleText) {
  const out = [];
  for (const t of tickets) {
    const own = checklist?.[String(t.id)];
    const list = own ? own.map((q) => ({ ...q, kind: "planner" })) : [
      ...t.rules.map((r) => ({ id: `${t.id}.${r}`, kind: "rule", text: `The code meets rule ${r} of the brief: "${ruleText(r)}"` })),
      { id: `${t.id}.logic`, kind: "logic", text: "No function in the code mutates its argument, has an off-by-one error at an edge, leaks state between runs, draws or renders while ignoring state, or binds an input to the wrong target." },
      { id: `${t.id}.constants`, kind: "constants", text: "Every number used in the code comes from the brief's constants or config, except the literals 0, 1, 2 and 1000." },
    ];
    for (const q of list) out.push({ ...q, ticket: t.id, files: t.writes });
  }
  for (const q of checklist?.cross || []) out.push({ ...q, kind: "cross", ticket: "x", files: [...new Set(tickets.flatMap((t) => t.writes))].sort() });
  return out;
}

async function main() {
  const { ROOT, loadBrief } = await import("../lib/brief.mjs");
  const { IS_WORKER_DIR, WORK_ROOT } = await import("../lib/paths.mjs");
  const { loadTickets } = await import("../lib/prompt.mjs");
  const { DEFAULTS, armConfig } = await import("../lib/settings.mjs");
  const { updateMeta } = await import("../lib/runs.mjs");
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] == null ? true : arr[i + 1]] : []).filter((x) => x.length));
  if (!args.run) { console.error("usage: node review/typed-gate.mjs --run runs/<id> [--tickets 3,5] [--dry]"); process.exit(2); }
  const runDir = resolve(ROOT, String(args.run));
  if (!existsSync(resolve(runDir, "meta.json"))) { console.error(`no run at ${runDir} (no meta.json)`); process.exit(2); }
  const key = process.env.IS_WORKER_API_KEY || process.env.INDICSTACK_API_KEY;
  if (!key && !args["no-gate"]) { console.error("IS_WORKER_API_KEY is not set (the orchestrator passes it)"); process.exit(2); }
  const cfg = armConfig("A");
  const brief = loadBrief();
  const work = WORK_ROOT || resolve(runDir, "work");
  const pick = args.tickets ? new Set(String(args.tickets).split(",").map(Number)) : null;
  const tickets = loadTickets().filter((t) => !pick || pick.has(Number(t.id)));
  const checklistPath = resolve(IS_WORKER_DIR, "checklist.json");
  const checklist = existsSync(checklistPath) ? JSON.parse(readFileSync(checklistPath, "utf8")) : null;
  const ruleText = (r) => { const m = brief.body.match(new RegExp(`^.*\\b${r}\\b.*$`, "m")); return m ? m[0].trim() : r; };
  const fileText = (rel) => (existsSync(resolve(work, rel)) ? readFileSync(resolve(work, rel), "utf8") : "(missing)");
  const codeFor = (files) => files.map((f) => `--- ${f} ---\n${fileText(f)}`).join("\n\n");
  const nonce = `run ${runDir.split("/").pop()} ${Date.now()}`; // IndicStack caches identical prompts; a fresh id keeps every call real

  async function ask(system, user, maxTokens = 1) {
    const t0 = performance.now();
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: `${system} (${nonce})` }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0, logprobs: true, top_logprobs: 10, chat_template_kwargs: { enable_thinking: false } }) });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(`IndicStack ${res.status}: ${JSON.stringify(j.error || j).slice(0, 300)}`);
    const u = j.usage || {};
    return { top: j.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs || [], seconds: (performance.now() - t0) / 1000, prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, cost: Number.isFinite(u.cost) ? u.cost : null };
  }

  const out = { run: runDir, checklist: checklist ? checklistPath : null, gate: !args["no-gate"], threshold: DEFAULTS.review_gate_threshold, risk_open: DEFAULTS.review_gate_risk_open, started: new Date().toISOString(), items: [], scores: [], usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0, seconds: 0, cost: 0, cost_reported: 0 } };
  if (args["no-gate"]) {
    const troubled = new Set(args.troubled ? String(args.troubled).split(",").map(Number) : []);
    out.items = statementsFor(tickets, checklist, ruleText).filter((q) => q.kind === "cross" || troubled.has(Number(q.ticket))).map((q) => ({ id: q.id, kind: q.kind, ticket: q.ticket, files: q.files, text: q.text, p_fine: null, open: true, opened_by: q.kind === "cross" ? "cross" : "troubled" }));
    out.usage.wall_seconds = 0; out.open = out.items.length; out.closed = 0;
    writeFileSync(resolve(runDir, "typed-gate.json"), JSON.stringify(out, null, 2));
    updateMeta(runDir, { typedGate: { gate: false, checklist: Boolean(checklist), statements: out.items.length, open: out.open, closed: 0, usage: out.usage } });
    console.log(`statements: ${out.items.length} (${out.items.filter((i) => i.kind === "cross").length} cross-file${troubled.size ? `, per-ticket for troubled ${[...troubled].join(", ")}` : ""}), no worker-model gate${checklist ? "" : " (no checklist.json: generic statements, weak at cross-file bugs)"}`);
    return;
  }
  const add = (r) => { out.usage.calls++; out.usage.prompt_tokens += r.prompt_tokens; out.usage.completion_tokens += r.completion_tokens; out.usage.seconds += r.seconds; if (r.cost != null) { out.usage.cost += r.cost; out.usage.cost_reported++; } };
  const t0 = performance.now();
  if (!args.dry) {
    if (checklist?.score) for (const t of tickets) {
      const sc = checklist.score;
      const r = await ask(`You are a code judge. You will be shown a brief, some code and one question with ${sc.levels.length} ordered answers. Reply with exactly one digit, the number of the answer that fits best.`,
        `=== BRIEF ===\n${brief.body}\n\n=== CODE ===\n${codeFor(t.writes)}\n\n=== QUESTION ===\n${sc.text}\n${sc.levels.map((l, i) => `${i + 1} = ${l}`).join("\n")}\n\nAnswer with one digit.`);
      add(r); const s = scoreValue(r.top, sc.levels.length);
      out.scores.push({ ticket: t.id, risk: s.value == null ? null : Number(s.value.toFixed(2)), mass: Number(s.mass.toFixed(3)) });
    }
    const riskOf = (id) => out.scores.find((s) => s.ticket === id)?.risk ?? null;
    for (const q of statementsFor(tickets, checklist, ruleText)) {
      const r = await ask("You are a code judge. You will be shown a brief, some code and one statement about the code. Reply with exactly one word: YES if the statement is true, NO if it is false.",
        `=== BRIEF ===\n${brief.body}\n\n=== CODE ===\n${codeFor(q.files)}\n\n=== STATEMENT ===\n${q.text}\n\nAnswer YES or NO.`);
      add(r); const p = pFine(r.top);
      const risky = riskOf(q.ticket) != null && riskOf(q.ticket) >= DEFAULTS.review_gate_risk_open;
      const open = p == null || p < DEFAULTS.review_gate_threshold || risky;
      out.items.push({ id: q.id, kind: q.kind, ticket: q.ticket, files: q.files, text: q.text, p_fine: p == null ? null : Number(p.toFixed(3)), open, opened_by: !open ? null : p != null && p >= DEFAULTS.review_gate_threshold ? "score" : "threshold" });
    }
  } else out.items = statementsFor(tickets, checklist, ruleText).map((q) => ({ id: q.id, kind: q.kind, ticket: q.ticket, files: q.files, text: q.text, p_fine: null, open: true, opened_by: "dry" }));
  out.usage.wall_seconds = Number(((performance.now() - t0) / 1000).toFixed(1));
  out.open = out.items.filter((i) => i.open).length;
  out.closed = out.items.length - out.open;
  writeFileSync(resolve(runDir, "typed-gate.json"), JSON.stringify(out, null, 2));
  updateMeta(runDir, { typedGate: { gate: true, checklist: Boolean(checklist), statements: out.items.length, open: out.open, closed: out.closed, usage: out.usage } });
  for (const s of out.scores) console.log(`risk t${s.ticket}: ${s.risk}`);
  for (const i of out.items) console.log(`${String(i.ticket).padStart(2)} ${i.id.padEnd(20)} P(fine)=${i.p_fine == null ? " n/a " : i.p_fine.toFixed(3)} ${i.open ? "open" : "closed"}`);
  console.log(`gate: ${out.items.length} statements${checklist ? "" : " (no checklist.json: generic statements, weak at cross-file bugs)"}, ${out.closed} closed by ${cfg.model}, ${out.open} open; ${out.usage.calls} calls, ${out.usage.prompt_tokens} tokens, ${out.usage.wall_seconds}s`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
