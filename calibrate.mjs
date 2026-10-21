// Calibration pilot: ~N real ticket prompts, measures speed, chars/token, ttft, gaps, answer length per ticket.
//   node calibrate.mjs --arm A [--calls 48]
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadBrief } from "./lib/brief.mjs";
import { armConfig, calibrationPath, readProbe, DEFAULTS } from "./lib/settings.mjs";
import { loadTickets, buildMessages, buildBody, promptChars, ticketKey } from "./lib/prompt.mjs";
import { chatStream, tokensEstimate } from "./lib/client.mjs";
import { parseFiles } from "./lib/schema.mjs";
import { createLimiter } from "./lib/limiter.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta } from "./lib/runs.mjs";
import { appendJsonl } from "./lib/jsonl.mjs";
import { percentile } from "./lib/stats.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const arm = args.arm;
const cfg = armConfig(arm);
const apiKey = process.env.IS_WORKER_API_KEY || "";
if (!apiKey) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
const brief = loadBrief();
const probe = readProbe(arm);
if (!args.recompute && !probe?.context_window) { console.error("probe first: calibration sizes max_tokens from the served window"); process.exit(2); }
const tickets = loadTickets();
const n = Number(args.calls || cfg.calibrationCalls || 0);
if (!n && !args.recompute) { console.error("calibration calls is 0"); process.exit(2); }
const recompute = args.recompute ? resolve(process.cwd(), String(args.recompute)) : null;
const run = recompute ? { id: recompute.split("/").pop(), dir: recompute } : newRunDir(arm, "calibrate");
const p = runPaths(run.dir);
const say = (m) => console.log(`${new Date().toISOString()} ${m}`);
if (!recompute) writeMeta(run.dir, { id: run.id, arm, kind: "calibrate", model: cfg.model, baseUrl: cfg.baseUrl, briefHash: brief.hash, started: new Date().toISOString(), status: "running", calls: n, priceInPerM: cfg.priceInPerM, priceOutPerM: cfg.priceOutPerM, mode: cfg.mode });

const limiter = createLimiter({ start: cfg.concurrency || 1, max: cfg.concurrency || 1, cleanMultiplier: DEFAULTS.aimd_clean_multiplier });
const rows = [];
let consecutive429 = 0;
async function one(i) {
  const ticket = tickets[i % tickets.length];
  const messages = buildMessages(ticket, resolve(run.dir, "work"), [], `${run.id}/call${i}`);
  const chars = promptChars(messages);
  const est = tokensEstimate(chars, DEFAULTS.chars_per_token);
  const maxTokens = Math.max(256, probe.context_window - est - DEFAULTS.spare_tokens);
  const body = buildBody({ model: cfg.model, messages, maxTokens, thinking: cfg.thinking, extraBody: cfg.extraBody });
  await limiter.acquire();
  const r = await chatStream({ baseUrl: cfg.baseUrl, apiKey, body, firstTokenTimeoutMs: DEFAULTS.first_token_timeout_s * 1000, stallTimeoutMs: DEFAULTS.stall_timeout_s * 1000, totalTimeoutMs: 20 * 60 * 1000, runawayTail: DEFAULTS.runaway_tail_chars, runawayRepeats: DEFAULTS.runaway_repeats });
  limiter.release(r.kind === "429" || r.status === 503 ? "overload" : r.kind === "ok" ? "clean" : "other");
  const u = r.usage || {};
  const writeS = r.ttft != null ? r.seconds - r.ttft : null;
  const row = { ts: new Date().toISOString(), stage: "calibrate", arm, i, ticket: ticket.id, kind: r.kind, http_status: r.status, seconds: +r.seconds.toFixed(3), ttft: r.ttft, max_gap: +r.maxGap.toFixed(3), prompt_chars: chars, prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0, cost: Number.isFinite(u.cost) ? u.cost : null, provider: r.provider, served_model: r.servedModel, answer_chars: r.text.length, max_tokens: maxTokens, schema_ok: r.kind === "ok" ? parseFiles(r.text).ok : null, write_s: writeS, error: r.error?.slice(0, 300) || null, limit: limiter.limit };
  appendJsonl(p.calls, row);
  rows.push(row);
  if (r.text) writeFileSync(resolve(p.outputs, `call${i}-t${ticket.id}.raw.txt`), r.text);
  say(`call ${i} t${ticket.id}: ${r.kind} ${row.seconds}s ttft=${r.ttft?.toFixed?.(2)} out=${row.completion_tokens} schema=${row.schema_ok}`);
  if (r.kind === "429") { if (++consecutive429 >= DEFAULTS.breaker_429_consecutive) { say("credit breaker"); finish("breaker"); process.exit(DEFAULTS.breaker_exit_code); } }
  else consecutive429 = 0;
}
function finish(status) {
  const okAll = rows.filter((r) => r.kind === "ok" && r.prompt_tokens && r.completion_tokens);
  const isCacheHit = (r) => r.write_s > 0 && r.completion_tokens / r.write_s > DEFAULTS.cache_hit_tps_threshold;
  const cacheHits = okAll.filter(isCacheHit);
  const ok = okAll.filter((r) => !isCacheHit(r));
  const speeds = ok.filter((r) => r.write_s > 0).map((r) => r.completion_tokens / r.write_s);
  const cpt = ok.filter((r) => r.prompt_chars).map((r) => r.prompt_chars / r.prompt_tokens);
  const byTicket = {};
  for (const t of tickets) { const v = ok.filter((r) => r.ticket === t.id).map((r) => r.completion_tokens); if (v.length) byTicket[ticketKey(t)] = percentile(v, 95); }
  const cal = {
    model: cfg.model, arm, baseUrl: cfg.baseUrl, at: new Date().toISOString(), run: run.id, source: args.source ? String(args.source) : "calibration run", n: rows.length, n_ok: ok.length, status,
    outcomes: rows.reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {}),
    speed_tps_p10: percentile(speeds, 10), speed_tps_p50: percentile(speeds, 50),
    chars_per_token_p10: percentile(cpt, 10), chars_per_token_p50: percentile(cpt, 50),
    ttft_p95: percentile(ok.map((r) => r.ttft), 95), gap_p99: percentile(ok.map((r) => r.max_gap), 99),
    answer_tokens_p95: percentile(ok.map((r) => r.completion_tokens), 95), answer_tokens_p95_by_ticket: byTicket,
    schema_ok_rate: okAll.length ? okAll.filter((r) => r.schema_ok).length / okAll.length : null,
    cache_hits_excluded: cacheHits.length, n_measured: ok.length,
    reasoning_tokens_total: rows.reduce((a, r) => a + (r.reasoning_tokens || 0), 0),
    planner_notes: [],
  };
  mkdirSync(dirname(calibrationPath(arm)), { recursive: true });
  writeFileSync(calibrationPath(arm), JSON.stringify(cal, null, 2) + "\n");
  updateMeta(run.dir, { status, finished: new Date().toISOString(), calibration: cal, cost: rows.reduce((a, r) => a + (r.cost || 0), 0) });
  say(`calibration written to ${calibrationPath(arm)}: speed p10 ${cal.speed_tps_p10?.toFixed?.(1)} tps, chars/token p10 ${cal.chars_per_token_p10?.toFixed?.(2)}, answer p95 ${cal.answer_tokens_p95}`);
}
if (recompute) { rows.push(...(await import("./lib/jsonl.mjs")).readJsonl(p.calls).filter((r) => r.stage === "worker" || r.stage === "calibrate").map((r) => ({ ...r, write_s: r.write_s ?? (r.ttft != null ? r.seconds - r.ttft : null), prompt_chars: r.prompt_chars ?? null, schema_ok: r.schema_ok ?? (r.kind === "ok") }))); finish("done"); }
else { const jobs = []; for (let i = 0; i < n; i++) jobs.push(one(i)); await Promise.all(jobs); finish("done"); }
