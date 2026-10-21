// Token accounting for the `table` command: what each model actually read and wrote, in tokens, never rupees.
//
// Three columns, three sources:
//   1. Worker (IndicStack) — every worker call the harness made for this milestone (runs/*/calls.jsonl), summed.
//   2. Frontier with is-worker — the planner's own Claude Code session, read from its transcript (the API's usage
//      block on every assistant message, de-duplicated by message id, subagents included), plus the reviewer call.
//   3. Frontier alone — the same app built by the frontier model with no harness. Measured when a baseline exists for
//      this app; otherwise estimated from measured baselines as tokens per KB of finished code (alone-baselines.json).
//
// "Input" is split the way the API bills it: new input (input + cache writes) and cache reads (the same context
// re-read on every turn). Both are tokens the model processed; they are shown apart because they are not alike.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { homedir } from "node:os";

const readJsonl = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const zero = () => ({ calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 });
export const totalOf = (u) => u.input + u.cache_write + u.cache_read + u.output;

// Worker tokens over every run of the milestone (all runs built from the same frozen brief).
export function workerUsage(runDirs) {
  const u = zero();
  for (const d of runDirs) {
    const f = resolve(d, "calls.jsonl");
    if (!existsSync(f)) continue;
    for (const c of readJsonl(f)) { u.calls++; u.input += Number(c.prompt_tokens) || 0; u.output += Number(c.completion_tokens) || 0; }
  }
  return u;
}

// Claude Code keeps one JSONL per session under <config>/projects/<cwd-slug>/; subagents under <session>/subagents/.
function configDirs() {
  const h = homedir(), out = new Set();
  if (process.env.CLAUDE_CONFIG_DIR) out.add(resolve(process.env.CLAUDE_CONFIG_DIR));
  for (const n of existsSync(h) ? readdirSync(h) : []) if (n === ".claude" || n.startsWith(".claude-")) out.add(resolve(h, n));
  return [...out].filter((d) => existsSync(resolve(d, "projects")));
}
function walkJsonl(dir, sinceMs, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walkJsonl(p, sinceMs, acc);
    else if (n.endsWith(".jsonl") && s.mtimeMs >= sinceMs) acc.push(p);
  }
  return acc;
}

// Sums usage of assistant messages in [since, until] from transcripts that mention the project path (or explicit files).
export function transcriptUsage({ files, since, until }) {
  // Input side: the usage block is logged at the start of each reply, so input, cache-write and cache-read are exact.
  // Output side: that same block is written before the reply is generated, so its output_tokens is only the first few
  // tokens. The reply's visible text (text blocks + tool-call arguments) is kept instead and counted by countOutput().
  // Hidden thinking is not in the transcript and is not counted (same rule for every frontier column).
  const byId = new Map(), models = new Set(), used = new Set();
  for (const f of files) for (const r of readJsonl(f)) {
    if (r.type !== "assistant" || !r.message?.usage || !r.timestamp) continue;
    if ((since && r.timestamp < since) || (until && r.timestamp > until)) continue;
    const id = r.message.id || r.uuid;
    const e = byId.get(id) || { usage: r.message.usage, text: [] };
    for (const c of r.message.content || []) {
      if (c.type === "text" && c.text) e.text.push(c.text);
      else if (c.type === "tool_use") e.text.push(c.name + JSON.stringify(c.input));
    }
    byId.set(id, e); used.add(f);
    if (r.message.model && r.message.model !== "<synthetic>") models.add(r.message.model);
  }
  const u = zero(); let logged = 0; const text = [];
  for (const { usage: x, text: t } of byId.values()) { u.calls++; u.input += x.input_tokens || 0; u.cache_write += x.cache_creation_input_tokens || 0; u.cache_read += x.cache_read_input_tokens || 0; logged += x.output_tokens || 0; text.push(...t); }
  u.output = logged;
  return { usage: u, models: [...models], files: [...used], outputText: text.join("\n"), loggedOutput: logged };
}

// Output tokens of the visible reply text, counted by the model's own tokenizer: the text is sent once as the input of
// a 1-token OpenRouter call and the reported prompt_tokens (minus the empty-message overhead) is the count. Without an
// OpenRouter key it falls back to characters / CHARS_PER_TOKEN and says so.
export const CHARS_PER_TOKEN = 2.5; // fallback only; measured 2.28 on code, ~3.5 on prose for Opus 5.5 (21 Oct 2026)
export const openrouterId = (m) => String(m).replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, "anthropic/claude-$1-$2.$3");
export async function countOutput({ text, model, key }) {
  if (!text) return { tokens: 0, method: "no visible output" };
  if (key && model) {
    const call = async (content) => {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: openrouterId(model), max_tokens: 1, messages: [{ role: "user", content }] }) });
      const j = await r.json(); if (!j.usage) throw new Error(JSON.stringify(j).slice(0, 200)); return j.usage.prompt_tokens;
    };
    try { const [full, empty] = [await call(text), await call("x")]; return { tokens: full - empty + 1, method: `${openrouterId(model)} tokenizer via OpenRouter` }; } catch (e) { /* fall through */ }
  }
  return { tokens: Math.round(text.length / CHARS_PER_TOKEN), method: `≈ ${text.length.toLocaleString("en-IN")} chars / ${CHARS_PER_TOKEN}` };
}

// The planner's session: the ONE Claude Code transcript that is running `table` right now — the file, modified in the
// last few minutes, whose latest tool call is this is-worker command — plus that session's subagents. Nothing else:
// sweeping every transcript that mentions the project folder (0.8.5) counted other chats about the project as planning
// (Flappy Bird: 678 calls over nine days). The window runs from the last /is-worker command in that session (or, if
// there is none, from 15 minutes before the first run) to now.
export function currentSessionTranscript({ nowMs = Date.now(), windowMs = 10 * 60 * 1000 } = {}) {
  const recent = configDirs().flatMap((d) => walkJsonl(resolve(d, "projects"), nowMs - windowMs)).filter((f) => !/[\\/]subagents[\\/]/.test(f));
  let best = null;
  for (const f of recent) {
    const rows = readJsonl(f);
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 40); i--) {
      const r = rows[i];
      if (r.type !== "assistant") continue;
      const hit = (r.message?.content || []).some((c) => c.type === "tool_use" && /is-worker\.mjs/.test(JSON.stringify(c.input)) && /\btable\b/.test(JSON.stringify(c.input)));
      if (hit && (!best || r.timestamp > best.ts)) best = { file: f, ts: r.timestamp };
      if (hit) break;
    }
  }
  return best?.file || null;
}

export function plannerUsage({ project, firstRunStart, until }) {
  const session = currentSessionTranscript();
  if (!session) return null;
  let since = null;
  for (const r of readJsonl(session)) {
    if (r.type !== "user" || !r.timestamp) continue;
    const c = r.message?.content;
    if (typeof c !== "string") continue; // tool results are logged as user records; only typed messages count
    if (/<command-name>\/is-worker(:is-worker)?<\/command-name>|^\s*\/is-worker(:is-worker)?(\s|$)/m.test(c) && (!since || r.timestamp > since)) since = r.timestamp;
  }
  // No /is-worker command in this session: it is not the planner's session (someone ran `table` from another chat), so
  // the honest answer is "?", not a guessed window over an unrelated conversation.
  if (!since) return { none: `the running session (${session.split(/[\\/]/).pop().slice(0, 8)}…) has no /is-worker command, so it is not the planner's session` };
  const d = session.replace(/\.jsonl$/, "");
  const subs = existsSync(resolve(d, "subagents")) ? walkJsonl(resolve(d, "subagents"), 0) : [];
  return { since, until, session, ...transcriptUsage({ files: [session, ...subs], since, until }) };
}

// List prices per million tokens for a frontier model, from OpenRouter (prompt, completion, cache read); null if unknown.
export async function listPrices(model) {
  try {
    const j = await (await fetch("https://openrouter.ai/api/v1/models")).json();
    const o = j.data.find((x) => x.id === openrouterId(model));
    if (!o) return null;
    const pm = (v) => Math.round(Number(v) * 1e8) / 100;
    return { id: o.id, in: pm(o.pricing.prompt), out: pm(o.pricing.completion), cr: pm(o.pricing.input_cache_read ?? o.pricing.prompt), cw: pm(o.pricing.input_cache_write ?? o.pricing.prompt) };
  } catch { return null; }
}
export const usdAt = (u, px) => ((u.input || 0) * px.in + (u.cache_write || 0) * px.cw + (u.cache_read || 0) * px.cr + (u.output || 0) * px.out) / 1e6;

// Bytes of finished code: every file in the app folder except harness, VCS, dependency and hidden folders.
export function codeBytes(dir) {
  let b = 0, n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|ts|tsx|jsx|html|css|json|py|svg|md)$/.test(e.name)) { const s = statSync(p).size; if (s < 1e6) { b += s; n++; } }
    }
  };
  walk(dir);
  return { bytes: b, files: n };
}

// Frontier-alone tokens. A baseline measured for this app wins; else tokens per KB of finished code from all baselines
// of that model (pooled: sum of tokens / sum of KB), with the min–max of the per-baseline rates as the range.
export function aloneEstimate({ baselinesFile, app, model, bytes }) {
  const all = existsSync(baselinesFile) ? JSON.parse(readFileSync(baselinesFile, "utf8")).baselines || [] : [];
  if (!model) return null;
  const norm = (x) => String(x).replace(/^[a-z-]+\//, "").replace(/\./g, "-"); // anthropic/claude-opus-5.5 == claude-opus-5-5
  const mine = all.filter((b) => norm(b.model) === norm(model));
  const exact = app ? mine.find((b) => b.app === app) : null;
  if (exact) return { kind: "measured", usage: exact.usage, basis: [exact] };
  if (!mine.length) return null;
  const kb = mine.reduce((a, b) => a + b.code_bytes / 1024, 0);
  const scale = (k) => Math.round((mine.reduce((a, b) => a + b.usage[k], 0) / kb) * (bytes / 1024));
  const usage = { calls: scale("calls"), input: scale("input"), cache_write: scale("cache_write"), cache_read: scale("cache_read"), output: scale("output") };
  const rates = mine.map((b) => totalOf(b.usage) / (b.code_bytes / 1024));
  return { kind: "estimated", usage, basis: mine, range: [Math.min(...rates), Math.max(...rates)].map((r) => Math.round(r * bytes / 1024)) };
}

export const add = (a, b) => ({ calls: a.calls + b.calls, input: a.input + b.input, cache_write: a.cache_write + b.cache_write, cache_read: a.cache_read + b.cache_read, output: a.output + b.output });
export const rel = (from, p) => relative(from, p) || ".";
