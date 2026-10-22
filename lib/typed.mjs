// N4: typed judgments from any OpenAI-compatible model, after typesafe-ai/system-one-adapter-python (Choice / Score / Noul
// → strict JSON schema, probability normalisation, corrective retry). The caller passes a state and named questions and
// gets numbers back, not prose:
//   const r = await systemOne({ state, questions: { ok: Noul("The file exports render."), kind: Choice("Which view?", ["list", "form"]),
//                                risk: Score("How likely is an uncaught bug?") }, baseUrl, key, model });
//   r.answers.ok → 0.93 (P true), r.answers.kind → { choice: "list", probs: { list: 0.8, form: 0.2 } }, r.answers.risk → 0.2 (0..1)
// mode "discrete" asks for true/false, one option and a 1–5 level instead of probabilities.
// askJson() is the same request/validate/retry loop for any JSON schema (used by scripts/digest.mjs).

export const Noul = (instructions) => ({ type: "noul", instructions });
export const Choice = (instructions, options) => ({ type: "choice", instructions, options: [...options] });
export const Score = (instructions, levels = 5) => ({ type: "score", instructions, levels });

const prob = { type: "number", minimum: 0, maximum: 1 };

export function schemaFor(questions, mode = "probabilities") {
  const properties = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === "noul") properties[k] = mode === "discrete" ? { type: "boolean" } : prob;
    else if (q.type === "choice") properties[k] = mode === "discrete" ? { type: "string", enum: q.options }
      : { type: "object", properties: Object.fromEntries(q.options.map((o) => [o, prob])), required: q.options, additionalProperties: false };
    else if (q.type === "score") properties[k] = mode === "discrete" ? { type: "integer", minimum: 1, maximum: q.levels } : prob;
    else throw new Error(`question ${k}: unknown type ${q.type}`);
  }
  return { name: "answers", strict: true, schema: { type: "object", properties, required: Object.keys(questions), additionalProperties: false } };
}

// Minimal validator for the schemas above and for digest schemas: returns a list of problems (empty = valid).
export function validate(value, schema, path = "$") {
  const errs = [];
  const t = schema.type;
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}.${r} is missing`);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!schema.properties?.[k]) errs.push(`${path}.${k} is not allowed`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) errs.push(...validate(value[k], s, `${path}.${k}`));
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    value.forEach((v, i) => errs.push(...validate(v, schema.items || {}, `${path}[${i}]`)));
  } else if (t === "number" || t === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (t === "integer" && !Number.isInteger(value))) return [`${path} must be ${t === "integer" ? "an integer" : "a number"}`];
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path} must be ≥ ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${path} must be ≤ ${schema.maximum}`);
  } else if (t === "boolean") { if (typeof value !== "boolean") errs.push(`${path} must be true or false`); }
  else if (t === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }
  return errs;
}

// Choice probabilities sum to 1 (uniform when all zero); scores map 1..levels onto 0..1 in discrete mode.
export function normalize(questions, raw, mode = "probabilities") {
  const out = {};
  for (const [k, q] of Object.entries(questions)) {
    const v = raw[k];
    if (q.type === "noul") out[k] = mode === "discrete" ? (v ? 1 : 0) : Math.min(1, Math.max(0, v));
    else if (q.type === "score") out[k] = mode === "discrete" ? (v - 1) / Math.max(1, q.levels - 1) : Math.min(1, Math.max(0, v));
    else {
      const probs = mode === "discrete" ? Object.fromEntries(q.options.map((o) => [o, o === v ? 1 : 0])) : { ...v };
      const total = q.options.reduce((a, o) => a + Math.max(0, probs[o] || 0), 0);
      for (const o of q.options) probs[o] = total > 0 ? Math.max(0, probs[o] || 0) / total : 1 / q.options.length;
      out[k] = { choice: q.options.reduce((a, b) => (probs[b] > probs[a] ? b : a)), probs };
    }
  }
  return out;
}

function stripFences(s) { const m = String(s).match(/```(?:json)?\s*([\s\S]*?)```/); return (m ? m[1] : String(s)).trim(); }

// One request/validate/retry loop. On invalid JSON or a schema violation the conversation continues with the errors,
// up to `retries` times (the adapter's corrective retry). Returns { value, usage, attempts } or throws.
export async function askJson({ system, user, schema, baseUrl, key, model, retries = 2, temperature = 0, maxTokens = 2048, fetchImpl = fetch, extra = {} }) {
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0, seconds: 0 };
  let lastErr = "";
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const t0 = performance.now();
    const res = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, response_format: { type: "json_schema", json_schema: schema }, chat_template_kwargs: { enable_thinking: false }, ...extra }),
    });
    const j = await res.json();
    const u = j.usage || {};
    usage.calls++; usage.prompt_tokens += u.prompt_tokens || 0; usage.completion_tokens += u.completion_tokens || 0; usage.cost += Number.isFinite(u.cost) ? u.cost : 0; usage.seconds += (performance.now() - t0) / 1000;
    if (!res.ok || j.error) { lastErr = `HTTP ${res.status}: ${JSON.stringify(j.error || j).slice(0, 300)}`; continue; }
    const text = j.choices?.[0]?.message?.content || "";
    let value;
    try { value = JSON.parse(stripFences(text)); } catch (e) { lastErr = `not valid JSON: ${e.message}`; messages.push({ role: "assistant", content: text }, { role: "user", content: `That was not valid JSON (${e.message}). Answer again with only the JSON object.` }); continue; }
    const errs = validate(value, schema.schema);
    if (!errs.length) return { value, usage, attempts: attempt };
    lastErr = errs.join("; ");
    messages.push({ role: "assistant", content: text }, { role: "user", content: `The answer does not match the schema: ${lastErr}. Answer again with only a corrected JSON object.` });
  }
  const e = new Error(`no valid answer after ${retries + 1} attempt(s): ${lastErr}`); e.usage = usage; throw e;
}

export async function systemOne({ state, questions, mode = "probabilities", ...conn }) {
  const lines = Object.entries(questions).map(([k, q]) => q.type === "noul" ? `- ${k}: ${mode === "discrete" ? "true or false" : "probability (0 to 1) that this is true"}: ${q.instructions}`
    : q.type === "choice" ? `- ${k}: ${mode === "discrete" ? "pick one of" : "probability of each of"} ${q.options.join(" / ")}: ${q.instructions}`
    : `- ${k}: ${mode === "discrete" ? `level 1 to ${q.levels}` : "score from 0 (low) to 1 (high)"}: ${q.instructions}`);
  const system = "You judge a state and answer each question with numbers only, as a JSON object with exactly the given keys. No prose. Use calibrated probabilities: 0.5 means unsure.";
  const user = `STATE:\n${typeof state === "string" ? state : JSON.stringify(state, null, 1)}\n\nQUESTIONS:\n${lines.join("\n")}`;
  const r = await askJson({ system, user, schema: schemaFor(questions, mode), ...conn });
  return { answers: normalize(questions, r.value, mode), raw: r.value, usage: r.usage, attempts: r.attempts };
}
