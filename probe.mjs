// One real call per model, then a max_tokens ladder to measure the served context window.
//   node probe.mjs --arm A [--parallel 8] [--find-model "qwen 3.8 27b"]
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { armConfig, probePath, DEFAULTS, writeSettings } from "./lib/settings.mjs";
import { chatStream } from "./lib/client.mjs";
import { FILES_SCHEMA, parseFiles } from "./lib/schema.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const arm = args.arm;
const cfg = armConfig(arm);
const apiKey = process.env.IS_WORKER_API_KEY || "";
if (!apiKey) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
const out = { arm, at: new Date().toISOString(), baseUrl: cfg.baseUrl, model: cfg.model, steps: [] };
const say = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function listModels() {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 2000) };
}

const tiny = (maxTokens, thinking = cfg.thinking) => ({
  model: cfg.model, temperature: 0, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
  chat_template_kwargs: { enable_thinking: Boolean(thinking) },
  response_format: { type: "json_schema", json_schema: FILES_SCHEMA },
  messages: [{ role: "system", content: "Reply with a JSON object {\"files\":[{\"path\":\"hello.txt\",\"content\":\"hi\"}]} and nothing else." }, { role: "user", content: "Reply now." }],
  ...(cfg.extraBody && typeof cfg.extraBody === "object" ? cfg.extraBody : {}),
});
const clocks = { firstTokenTimeoutMs: DEFAULTS.first_token_timeout_s * 1000, stallTimeoutMs: DEFAULTS.stall_timeout_s * 1000, totalTimeoutMs: 120000, runawayTail: DEFAULTS.runaway_tail_chars, runawayRepeats: DEFAULTS.runaway_repeats };

async function main() {
  if (args["find-model"] || !cfg.model) {
    const want = String(args["find-model"] || cfg.modelHint || "").toLowerCase().split(/\s+/).filter(Boolean);
    const m = await listModels();
    const ids = (m.json?.data || []).map((x) => ({ id: x.id, name: x.name, context_length: x.context_length ?? x.top_provider?.context_length ?? null, pricing: x.pricing || null }));
    const score = (x) => want.filter((w) => (x.id + " " + (x.name || "")).toLowerCase().includes(w)).length;
    const matches = ids.map((x) => ({ ...x, score: score(x) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);
    out.steps.push({ step: "find_model", status: m.status, listed: ids.length, matches });
    say(`/models: ${m.status}, ${ids.length} listed, ${matches.length} match [${want.join(" ")}]`);
    for (const x of matches) say(`  ${x.id}  ctx=${x.context_length}  prompt=${x.pricing?.prompt ?? "?"} completion=${x.pricing?.completion ?? "?"}  (${x.name || ""})`);
    if (!cfg.model && matches.length === 1) { writeSettings({ [arm]: { model: matches[0].id } }); say(`model set to ${matches[0].id}`); cfg.model = matches[0].id; }
    if (!cfg.model) { save(); say("pick a model id from the list above in the UI, then probe again"); return; }
    const chosen = ids.find((x) => x.id === cfg.model);
    if (chosen?.pricing) {
      const perM = (v) => (v == null ? null : Number(v) * 1e6);
      writeSettings({ [arm]: { priceInPerM: perM(chosen.pricing.prompt), priceOutPerM: perM(chosen.pricing.completion) } });
      out.listed_pricing_per_m = { in: perM(chosen.pricing.prompt), out: perM(chosen.pricing.completion) };
      say(`prices from listing: in ${out.listed_pricing_per_m.in}/M out ${out.listed_pricing_per_m.out}/M`);
    }
    if (chosen?.context_length) out.listed_context_length = chosen.context_length;
  }

  // 1. one real call
  const r1 = await chatStream({ baseUrl: cfg.baseUrl, apiKey, body: tiny(200), ...clocks });
  const parsed = r1.kind === "ok" ? parseFiles(r1.text) : { ok: false };
  out.steps.push({ step: "one_call", provider: r1.provider, served_model: r1.servedModel, kind: r1.kind, status: r1.status, seconds: r1.seconds, ttft: r1.ttft, usage: r1.usage, reasoning_chars: r1.reasoningChars, schema_honoured: parsed.ok, text: r1.text.slice(0, 300), error: r1.error });
  say(`one call: ${r1.kind} provider=${r1.provider} model=${r1.servedModel} http=${r1.status} ${r1.seconds.toFixed(2)}s ttft=${r1.ttft?.toFixed?.(2)} reasoning_chars=${r1.reasoningChars} schema=${parsed.ok} usage=${JSON.stringify(r1.usage)}`);
  if (r1.kind !== "ok") { say(`error: ${r1.error}`); save(); process.exit(1); }
  out.thinking_off_works = cfg.thinking ? null : r1.reasoningChars === 0 && !(r1.usage?.completion_tokens_details?.reasoning_tokens > 0);

  // 2. max_tokens ladder: doubling until the server refuses; the window is read from the error text.
  let accepted = null, refusedAt = null, refusedText = null, parsedWindow = null;
  for (let mt = 1024; mt <= 1 << 21; mt *= 2) {
    const r = await chatStream({ baseUrl: cfg.baseUrl, apiKey, body: tiny(mt), ...clocks });
    const nums = (r.error || "").match(/\d{4,}/g)?.map(Number) || [];
    out.steps.push({ step: "ladder", max_tokens: mt, kind: r.kind, status: r.status, error: r.error?.slice(0, 300) || null, numbers_in_error: nums });
    say(`ladder max_tokens=${mt}: ${r.kind} http=${r.status}${r.error ? " " + r.error.slice(0, 160).replace(/\s+/g, " ") : ""}`);
    if (r.kind === "ok" || r.kind === "length" || r.kind === "empty_content") { accepted = mt; continue; }
    refusedAt = mt; refusedText = r.error;
    const stated = (r.error || "").match(/context length (?:is|of) (\d[\d,]*)/i);
    if (stated) parsedWindow = Number(stated[1].replace(/,/g, ""));
    else if (nums.length) parsedWindow = Math.min(...nums);
    break;
  }
  out.ladder = { largest_accepted: accepted, refused_at: refusedAt, refused_text: refusedText?.slice(0, 500) || null, window_from_error: parsedWindow };
  out.context_window = parsedWindow || accepted;
  say(`served window: ${out.context_window} (${parsedWindow ? "from error text" : "largest accepted max_tokens"})`);

  // 3. optional: parallel calls
  if (args.parallel) {
    const n = Number(args.parallel);
    const rs = await Promise.all(Array.from({ length: n }, () => chatStream({ baseUrl: cfg.baseUrl, apiKey, body: tiny(200), ...clocks })));
    out.steps.push({ step: "parallel", n, kinds: rs.map((r) => r.kind), seconds: rs.map((r) => +r.seconds.toFixed(2)) });
    say(`parallel ${n}: ${rs.map((r) => r.kind).join(",")}`);
  }
  save();
  say(`probe written to ${probePath(arm)}`);
}
function save() { mkdirSync(dirname(probePath(arm)), { recursive: true }); writeFileSync(probePath(arm), JSON.stringify(out, null, 2) + "\n"); }
main().catch((e) => { console.error(e); save(); process.exit(1); });
