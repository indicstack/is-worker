// Arm B as a headless Opus worker: the exact worker prompts, one `claude -p` call per ticket, exact usage from its JSON output.
//   node scripts/claude-worker.mjs [--run runs/<id>]
import { runClaude } from "../lib/claude-bin.mjs";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { ROOT, loadBrief } from "../lib/brief.mjs";
import { loadTickets, buildMessages } from "../lib/prompt.mjs";
import { parseFiles } from "../lib/schema.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta } from "../lib/runs.mjs";
import { appendJsonl } from "../lib/jsonl.mjs";
import { applyAndCheck, recordTicket, enqueueForClaude, finalTestCount } from "../check.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const MODEL = String(args.model || "opus");
const brief = loadBrief();
const tickets = loadTickets();
const run = args.run ? { id: String(args.run).split("/").pop(), dir: resolve(ROOT, args.run) } : newRunDir("B");
const p = runPaths(run.dir);
const say = (m) => { console.log(`${new Date().toISOString()} ${m}`); appendJsonl(p.log.replace(/\.log$/, ".events.jsonl"), { ts: new Date().toISOString(), msg: m }); };
writeMeta(run.dir, { id: run.id, arm: "B", mode: "claude", model: `Opus 5.5 headless (claude -p --model ${MODEL})`, baseUrl: "", briefHash: brief.hash, started: new Date().toISOString(), status: "running", ticketsTotal: tickets.length, note: "Same system/user prompts as the API workers; --system-prompt replaces Claude Code's default; no tools. Usage is exact, from claude's JSON output." });

const stripFences = (t) => { const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); return (m ? m[1] : t).trim(); };
const status = new Map();
let runId = run.id;
for (const t of tickets.filter((t) => true).sort((a, b) => a.id - b.id)) {
  if (!t.deps.every((d) => status.get(d) === "ok")) { enqueueForClaude(run.dir, t, "dependency not done"); recordTicket(run.dir, { ticket: t.id, status: "queued", attempts: 0, error: "dependency" }); status.set(t.id, "queued"); continue; }
  const fixes = [];
  let done = false;
  for (let attempt = 1; attempt <= 2 && !done; attempt++) {
    const [sys, user] = buildMessages(t, p.work, fixes, runId);
    const t0 = Date.now();
    const tmp = mkdtempSync(resolve(tmpdir(), "is-worker-sys-")); const sysFile = resolve(tmp, "system.txt"); writeFileSync(sysFile, sys.content);
    const r = runClaude(["-p", "--system-prompt-file", sysFile, "--model", MODEL, "--output-format", "json", "--no-session-persistence", "--allowedTools", ""], { cwd: p.work, input: user.content, env: { ...process.env, IS_WORKER_API_KEY: "" } });
    const seconds = (Date.now() - t0) / 1000;
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    const text = j?.result ?? "";
    const u = j?.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    writeFileSync(resolve(p.outputs, `t${t.id}-attempt${attempt}.raw.txt`), text || r.stdout + r.stderr);
    const parsed = text ? parseFiles(stripFences(text)) : { ok: false, error: `no result (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 300)}` };
    const row = { ts: new Date().toISOString(), stage: "worker", arm: "B", ticket: t.id, attempt, kind: parsed.ok ? "ok" : "bad_json", source: "claude_headless", seconds: +seconds.toFixed(1), prompt_tokens: inTok, prompt_tokens_detail: { input: u.input_tokens, cache_write: u.cache_creation_input_tokens, cache_read: u.cache_read_input_tokens }, completion_tokens: u.output_tokens || 0, reasoning_tokens: u.output_tokens_details?.thinking_tokens || 0, cost: j?.total_cost_usd ?? null, cost_unit: "USD list price", model: Object.keys(j?.modelUsage || {})[0] || null, fixes: fixes.map((f) => f.name), error: parsed.ok ? null : parsed.error };
    appendJsonl(p.calls, row);
    say(`t${t.id} attempt ${attempt} -> ${row.kind} (${row.seconds}s, in ${inTok}, out ${row.completion_tokens}, $${row.cost})`);
    if (!parsed.ok) { if (attempt === 1) { fixes.push({ name: "bad_json_notice", text: `The previous answer was not valid JSON for the schema (${parsed.error}). Return exactly one JSON object {"files":[{"path","content"}]} and nothing else.` }); continue; } enqueueForClaude(run.dir, t, parsed.error); recordTicket(run.dir, { ticket: t.id, status: "queued", attempts: attempt, error: "bad_json" }); status.set(t.id, "queued"); break; }
    const c = applyAndCheck({ runDir: run.dir, ticket: t, files: parsed.files, attempt, alsoTests: tickets.filter((x) => status.get(x.id) === "ok").map((x) => x.test) });
    if (c.ok) { recordTicket(run.dir, { ticket: t.id, status: "ok", attempts: attempt, tests_pass: c.test.pass, tests_fail: 0 }); status.set(t.id, "ok"); say(`t${t.id} OK (${c.test.pass} tests)`); done = true; }
    else if (attempt === 1) { say(`t${t.id} check failed: ${c.error.split("\n")[0]}`); fixes.push({ name: "check_failure", text: `Your previous files failed the check. Fix them. Error:\n${c.error.slice(0, 3000)}` }); }
    else { enqueueForClaude(run.dir, t, c.error); recordTicket(run.dir, { ticket: t.id, status: "queued", attempts: attempt, error: "check_failed" }); status.set(t.id, "queued"); }
  }
}
const queued = [...status.values()].filter((s) => s === "queued").length;
updateMeta(run.dir, { status: queued ? "needs_claude" : "done", finished: new Date().toISOString(), testsFinal: finalTestCount(run.dir) });
say(`finished: ${[...status.values()].filter((s) => s === "ok").length} ok, ${queued} queued`);
