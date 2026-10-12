// One ticket per call. Runs every ticket for an arm through the outcome table, check.mjs, and the Claude queue.
//   node worker.mjs --arm A [--run runs/<id>]   (resumes when --run is given)
// Arm B never calls an API: every ticket goes to claude-queue.jsonl for the planner session.
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ROOT, loadBrief } from "./lib/brief.mjs";
import { loadTickets, buildMessages, buildBody, promptChars } from "./lib/prompt.mjs";
import { chatStream, totalTimeoutMs, tokensEstimate } from "./lib/client.mjs";
import { parseFiles } from "./lib/schema.mjs";
import { createLimiter } from "./lib/limiter.mjs";
import { DEFAULTS, armConfig, readCalibration, readProbe } from "./lib/settings.mjs";
import { newRunDir, runPaths, writeMeta, updateMeta, readMeta } from "./lib/runs.mjs";
import { appendJsonl, latestByKey } from "./lib/jsonl.mjs";
import { applyAndCheck, recordTicket, enqueueForClaude, finalTestCount } from "./check.mjs";
import { roundUpTo } from "./lib/stats.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.IS_WORKER_TEST_FAST ? Math.min(ms, 5) : ms));
const log = (p, msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); try { appendJsonl(p.log.replace(/\.log$/, ".events.jsonl"), { ts: new Date().toISOString(), msg }); } catch {} };

export function budgetFor(ticket, cfg, cal) {
  const perTicket = cal?.answer_tokens_p95_by_ticket?.[ticket.id];
  if (Number.isFinite(perTicket)) return roundUpTo(perTicket * DEFAULTS.answer_budget_margin, 256);
  if (Number.isFinite(cal?.answer_tokens_p95)) return roundUpTo(cal.answer_tokens_p95 * DEFAULTS.answer_budget_margin, 256);
  if (Number.isFinite(cfg.maxTokens)) return cfg.maxTokens;
  // no calibration yet: start from the brief-independent default and let the length/empty fixes double it if needed
  return DEFAULTS.first_run_answer_tokens;
}

export function timeoutsFor(maxTokens, cal) {
  const firstTokenS = DEFAULTS.first_token_timeout_s, stallS = DEFAULTS.stall_timeout_s;
  const speed = Number.isFinite(cal?.speed_tps_p10) ? cal.speed_tps_p10 : DEFAULTS.writing_speed_tps;
  return { firstTokenTimeoutMs: firstTokenS * 1000, stallTimeoutMs: stallS * 1000, totalTimeoutMs: totalTimeoutMs({ maxTokens, speedTps: speed, margin: DEFAULTS.total_timeout_margin, firstTokenS, extraS: DEFAULTS.total_timeout_extra_s }), speed };
}

const bodyHash = (b) => createHash("sha256").update(JSON.stringify(b)).digest("hex");

// Runs one ticket through the outcome table. Returns {status: ok|queued|breaker}.
async function runTicket({ ticket, arm, cfg, cal, probe, p, apiKey, limiter, state }) {
  const fixes = [];
  const used = new Set();
  let maxTokens = budgetFor(ticket, cfg, cal);
  const window = probe?.context_window || null;
  let attempt = 0, lastHash = null, lastKind = null, tries5xx = 0, timeoutRetries = 0, checkRetries = 0;
  const charsPerToken = Number.isFinite(cal?.chars_per_token_p10) ? cal.chars_per_token_p10 : DEFAULTS.chars_per_token;
  const addFix = (name, text) => { if (used.has(name)) return false; used.add(name); fixes.push({ name, text }); return true; };

  while (attempt < DEFAULTS.max_attempts_per_ticket) {
    attempt++;
    const messages = buildMessages(ticket, p.work, fixes, state.runId);
    const body = buildBody({ model: cfg.model, messages, maxTokens, thinking: cfg.thinking, extraBody: cfg.extraBody });
    const est = tokensEstimate(promptChars(messages), charsPerToken);
    if (window && est + maxTokens + DEFAULTS.spare_tokens > window) {
      const room = window - est - DEFAULTS.spare_tokens;
      if (room < 256) { enqueueForClaude(p.dir, ticket, `prompt (${est} est tokens) does not fit the served window ${window}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt - 1, error: "window" }); return { status: "queued" }; }
      maxTokens = room; body.max_tokens = room;
      log(p, `t${ticket.id} max_tokens cut to ${room} to fit window ${window}`);
    }
    const h = bodyHash(body);
    if (h === lastHash && !["first_token_timeout", "stall", "total_timeout", "http_5xx", "network", "429"].includes(lastKind)) {
      enqueueForClaude(p.dir, ticket, `would resend an unchanged request after ${lastKind}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt - 1, error: "unchanged" }); return { status: "queued" };
    }
    lastHash = h;
    const t = timeoutsFor(maxTokens, cal);
    await limiter.acquire();
    log(p, `t${ticket.id} attempt ${attempt} max_tokens=${maxTokens} est_prompt=${est} limit=${limiter.limit} fixes=[${fixes.map((f) => f.name).join(",")}]`);
    const r = await chatStream({ baseUrl: cfg.baseUrl, apiKey, body, firstTokenTimeoutMs: t.firstTokenTimeoutMs, stallTimeoutMs: t.stallTimeoutMs, totalTimeoutMs: t.totalTimeoutMs, runawayTail: DEFAULTS.runaway_tail_chars, runawayRepeats: DEFAULTS.runaway_repeats });
    const parsed = r.kind === "ok" ? parseFiles(r.text) : null;
    if (parsed && !parsed.ok) { r.kind = "bad_json"; r.error = parsed.error; }
    const u = r.usage || {};
    const row = { ts: new Date().toISOString(), stage: "worker", arm, ticket: ticket.id, attempt, kind: r.kind, http_status: r.status, seconds: +r.seconds.toFixed(3), ttft: r.ttft, max_gap: +r.maxGap.toFixed(3),
      prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? (r.reasoningChars ? Math.round(r.reasoningChars / charsPerToken) : 0),
      max_tokens: maxTokens, prompt_chars: promptChars(messages), cost: Number.isFinite(u.cost) ? u.cost : null, provider: r.provider, served_model: r.servedModel, finish_reason: r.finishReason, fixes: fixes.map((f) => f.name), error: r.error ? r.error.slice(0, 500) : null, limit: limiter.limit };
    appendJsonl(p.calls, row);
    lastKind = r.kind;
    if (r.text) writeFileSync(resolve(p.outputs, `t${ticket.id}-attempt${attempt}.raw.txt`), r.text);
    const overload = r.kind === "429" || (r.kind === "http_5xx" && r.status === 503);
    limiter.release(overload ? "overload" : r.kind === "ok" ? "clean" : "other");
    log(p, `t${ticket.id} attempt ${attempt} -> ${r.kind} (${row.seconds}s, ttft ${r.ttft?.toFixed?.(2)}, out ${row.completion_tokens})`);

    if (r.kind === "429") {
      state.consecutive429++;
      if (state.consecutive429 >= DEFAULTS.breaker_429_consecutive) { log(p, `credit breaker: ${state.consecutive429} consecutive 429s; saving state, exit ${DEFAULTS.breaker_exit_code}`); return { status: "breaker" }; }
      const wait = Number.isFinite(r.retryAfter) ? r.retryAfter : DEFAULTS.retry_429_waits_s[Math.min(state.consecutive429 - 1, DEFAULTS.retry_429_waits_s.length - 1)];
      await sleep(wait * 1000); attempt--; continue;
    }
    state.consecutive429 = 0;
    if (r.kind === "http_5xx" || r.kind === "network") {
      tries5xx++;
      if (tries5xx >= DEFAULTS.retry_5xx_total_tries) { enqueueForClaude(p.dir, ticket, `${r.kind} ${r.status || ""} ${tries5xx} times: ${r.error}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: r.kind }); return { status: "queued" }; }
      await sleep(DEFAULTS.retry_5xx_waits_s[Math.min(tries5xx - 1, DEFAULTS.retry_5xx_waits_s.length - 1)] * 1000); continue;
    }
    if (r.kind === "first_token_timeout" || r.kind === "stall" || r.kind === "total_timeout") {
      if (timeoutRetries++ >= 1) { enqueueForClaude(p.dir, ticket, `${r.kind} twice`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: r.kind }); return { status: "queued" }; }
      await sleep(DEFAULTS.timeout_retry_wait_s * 1000); continue;
    }
    if (r.kind === "http_error") { enqueueForClaude(p.dir, ticket, `HTTP ${r.status}: ${r.error}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: `http_${r.status}` }); return { status: "queued" }; }
    if (r.kind === "length" || r.kind === "empty_content") {
      const doubled = window ? Math.min(maxTokens * 2, window - est - DEFAULTS.spare_tokens) : maxTokens * 2;
      const note = r.kind === "empty_content" ? "The previous answer was empty: the whole budget went to hidden reasoning. Answer with the JSON object only, no reasoning." : "The previous answer was cut off at the token limit. Keep the code compact; no comments or blank lines.";
      if (doubled > maxTokens && addFix(`${r.kind}_double_budget`, note)) { maxTokens = doubled; continue; }
      enqueueForClaude(p.dir, ticket, `${r.kind} after budget ${maxTokens}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: r.kind }); return { status: "queued" };
    }
    if (r.kind === "runaway") {
      if (addFix("runaway_notice", "The previous answer repeated the same text over and over. Write each file once, in full, and stop.")) continue;
      enqueueForClaude(p.dir, ticket, "runaway twice"); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: "runaway" }); return { status: "queued" };
    }
    if (r.kind === "bad_json") {
      if (addFix("bad_json_notice", `The previous answer was not valid JSON for the schema (${parsed.error}). Return exactly one JSON object {"files":[{"path","content"}]} and nothing else.`)) continue;
      enqueueForClaude(p.dir, ticket, `bad_json twice: ${parsed.error}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: "bad_json" }); return { status: "queued" };
    }
    const c = applyAndCheck({ runDir: p.dir, ticket, files: parsed.files, attempt, alsoTests: state.doneTests() });
    if (c.ok) { recordTicket(p.dir, { ticket: ticket.id, status: "ok", attempts: attempt, tests_pass: c.test.pass, tests_fail: 0 }); log(p, `t${ticket.id} OK (${c.test.pass} tests)`); return { status: "ok" }; }
    log(p, `t${ticket.id} check failed: ${c.error.split("\n")[0]}`);
    if (checkRetries++ < 1 && addFix("check_failure", `Your previous files failed the check. Fix them. Error:\n${c.error.slice(0, 3000)}`)) continue;
    enqueueForClaude(p.dir, ticket, c.error); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: "check_failed" }); return { status: "queued" };
  }
  enqueueForClaude(p.dir, ticket, `attempt cap ${DEFAULTS.max_attempts_per_ticket}`); recordTicket(p.dir, { ticket: ticket.id, status: "queued", attempts: attempt, error: "attempt_cap" }); return { status: "queued" };
}

async function main() {
  const arm = args.arm;
  if (!["A", "B", "C"].includes(arm)) { console.error("usage: node worker.mjs --arm A|B|C [--run runs/<id>]"); process.exit(2); }
  const brief = loadBrief();
  const cfg = armConfig(arm);
  const tickets = loadTickets();
  const run = args.run ? { id: String(args.run).split("/").pop(), dir: resolve(ROOT, args.run) } : newRunDir(arm);
  const p = runPaths(run.dir);
  const existing = readMeta(run.dir);
  if (!existing) writeMeta(run.dir, { id: run.id, arm, mode: cfg.mode, model: cfg.model, baseUrl: cfg.baseUrl, thinking: cfg.thinking, concurrency: cfg.concurrency, priceInPerM: cfg.priceInPerM, priceOutPerM: cfg.priceOutPerM, briefHash: brief.hash, started: new Date().toISOString(), status: "running", ticketsTotal: tickets.length, defaults: DEFAULTS });
  else updateMeta(run.dir, { status: "running", resumedAt: new Date().toISOString() });
  log(p, `run ${run.id} arm ${arm} model ${cfg.model} mode ${cfg.mode}`);

  if (cfg.mode === "claude") {
    const done = latestByKey(p.tickets, (r) => r.ticket);
    for (const t of tickets) if (done.get(t.id)?.status !== "ok") { enqueueForClaude(run.dir, t, "arm B: planner session writes this ticket; submit with check.mjs --usage-in/--usage-out"); recordTicket(run.dir, { ticket: t.id, status: "queued", attempts: done.get(t.id)?.attempts || 0, error: null }); }
    updateMeta(run.dir, { status: "waiting_for_claude" });
    log(p, `arm B: ${tickets.length} tickets queued in ${p.queue}; no API calls made`);
    return;
  }

  const apiKey = process.env.IS_WORKER_API_KEY || "";
  if (!apiKey) { console.error("IS_WORKER_API_KEY missing in env (the UI passes it from ~/.is-worker/keys.env)"); process.exit(2); }
  const cal = readCalibration(arm, cfg.model);
  const probe = readProbe(arm);
  if (cal) updateMeta(run.dir, { calibration: { at: cal.at, n: cal.n, speed_tps_p10: cal.speed_tps_p10, answer_tokens_p95: cal.answer_tokens_p95 } });
  if (probe) updateMeta(run.dir, { probe: { at: probe.at, context_window: probe.context_window } });
  const limiter = createLimiter({ start: cfg.concurrency || 1, max: cfg.concurrency || 1, cleanMultiplier: DEFAULTS.aimd_clean_multiplier });
  const state = { consecutive429: 0, runId: run.id, doneTests: () => tickets.filter((t) => status.get(t.id) === "ok").map((t) => t.test) };
  const status = new Map([...latestByKey(p.tickets, (r) => r.ticket)].map(([k, v]) => [k, v.status]));
  let breaker = false;
  const running = new Map();
  const ready = () => tickets.filter((t) => !status.has(t.id) || status.get(t.id) === "failed").filter((t) => !running.has(t.id)).filter((t) => t.deps.every((d) => status.get(d) === "ok"));
  const blocked = () => tickets.filter((t) => !status.has(t.id)).filter((t) => t.deps.some((d) => status.get(d) === "queued" || status.get(d) === "breaker"));
  while (!breaker) {
    for (const t of blocked()) { status.set(t.id, "queued"); enqueueForClaude(run.dir, t, `dependency ${t.deps.filter((d) => status.get(d) !== "ok").join(",")} not done by the worker`); recordTicket(run.dir, { ticket: t.id, status: "queued", attempts: 0, error: "dependency" }); }
    const next = ready();
    if (!next.length && !running.size) break;
    for (const t of next) {
      running.set(t.id, runTicket({ ticket: t, arm, cfg, cal, probe, p, apiKey, limiter, state }).then((r) => { status.set(t.id, r.status); running.delete(t.id); if (r.status === "breaker") breaker = true; return r; }));
    }
    if (running.size) await Promise.race(running.values());
  }
  await Promise.allSettled(running.values());
  if (breaker) { updateMeta(run.dir, { status: "breaker", breakerAt: new Date().toISOString() }); process.exit(DEFAULTS.breaker_exit_code); }
  const queued = [...status.values()].filter((s) => s === "queued").length;
  updateMeta(run.dir, { status: queued ? "needs_claude" : "done", finished: new Date().toISOString(), testsFinal: finalTestCount(run.dir), limiterHistory: limiter.history });
  log(p, `finished: ${[...status.values()].filter((s) => s === "ok").length} ok, ${queued} queued for Claude`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "worker.mjs")) main().catch((e) => { console.error(e); process.exit(1); });
