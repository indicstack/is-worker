// Opus 5.5 through OpenRouter (the harness's arm C key). Returns text, exact usage and cost in USD.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
const keys = Object.fromEntries(readFileSync(resolve(homedir(), ".is-worker", "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
export const OPUS_MODEL = "anthropic/claude-opus-5.5";
export async function askOpus(messages, { maxTokens = 4000 } = {}) {
  const t0 = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${keys.IS_WORKER_KEY_C}` },
    body: JSON.stringify({ model: OPUS_MODEL, messages, max_tokens: maxTokens, temperature: 0, usage: { include: true } }) });
  const j = await res.json();
  if (j.error) throw new Error(`openrouter: ${JSON.stringify(j.error).slice(0, 300)}`);
  const u = j.usage || {};
  return { text: j.choices?.[0]?.message?.content || "", seconds: (performance.now() - t0) / 1000, usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cost_usd: u.cost ?? null } };
}
