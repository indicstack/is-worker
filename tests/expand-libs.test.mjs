// Unit tests for the expand v2 libraries: typed adapter (N4), built-in test kinds (N2), interface digests (N1).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Noul, Choice, Score, schemaFor, validate, normalize, askJson, systemOne } from "../lib/typed.mjs";
import { buildTest } from "../lib/testkinds.mjs";
import { exportsDigest, shapeOf } from "../lib/digest.mjs";

const Q = { ok: Noul("It works."), kind: Choice("Which?", ["a", "b"]), risk: Score("Risk?") };

test("schemaFor builds strict schemas in both modes", () => {
  const p = schemaFor(Q).schema, d = schemaFor(Q, "discrete").schema;
  assert.deepEqual(p.required, ["ok", "kind", "risk"]);
  assert.equal(p.properties.kind.type, "object");
  assert.deepEqual(d.properties.kind.enum, ["a", "b"]);
  assert.equal(d.properties.risk.maximum, 5);
});

test("validate reports missing, extra and out-of-range values", () => {
  const s = schemaFor(Q).schema;
  assert.deepEqual(validate({ ok: 0.5, kind: { a: 1, b: 0 }, risk: 0.2 }, s), []);
  const errs = validate({ ok: 2, kind: { a: 1 }, extra: 1 }, s);
  assert.ok(errs.some((e) => e.includes("$.risk is missing")));
  assert.ok(errs.some((e) => e.includes("extra is not allowed")));
  assert.ok(errs.some((e) => e.includes("$.ok must be ≤ 1")));
});

test("normalize sums choices to 1 and maps discrete scores to 0..1", () => {
  const n = normalize(Q, { ok: 0.9, kind: { a: 3, b: 1 }, risk: 0.4 });
  assert.equal(n.kind.choice, "a"); assert.equal(n.kind.probs.a, 0.75);
  const d = normalize(Q, { ok: true, kind: "b", risk: 5 }, "discrete");
  assert.deepEqual([d.ok, d.kind.choice, d.risk], [1, "b", 1]);
  assert.equal(normalize(Q, { ok: 0, kind: { a: 0, b: 0 }, risk: 0 }).kind.probs.a, 0.5);
});

test("askJson retries with the schema errors until the answer is valid", async () => {
  const replies = ['not json', '{"ok": 7, "kind": {"a": 1, "b": 0}, "risk": 0.1}', '{"ok": 0.8, "kind": {"a": 0.2, "b": 0.8}, "risk": 0.1}'];
  const seen = [];
  const fetchImpl = async (_, init) => { seen.push(JSON.parse(init.body).messages.length); const content = replies.shift(); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }; };
  const r = await systemOne({ state: { x: 1 }, questions: Q, baseUrl: "http://x", key: "k", model: "m", fetchImpl });
  assert.equal(r.attempts, 3); assert.equal(r.answers.kind.choice, "b"); assert.equal(r.usage.calls, 3);
  assert.deepEqual(seen, [2, 4, 6]); // each retry carries the bad answer and the correction
  await assert.rejects(askJson({ system: "s", user: "u", schema: schemaFor(Q), baseUrl: "http://x", key: "k", model: "m", retries: 0, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }) }), /no valid answer/);
});

test("every built-in test kind renders valid JavaScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "kinds-"));
  const srcs = [
    buildTest({ kind: "pure-fn" }, { path: "src/a.mjs", exports: ["f"], cases: [{ fn: "f", args: [1], equals: 2 }, { fn: "f", args: ["x"], throws: true }] }),
    buildTest({ kind: "html-view", fixture: "fx.mjs", variants: [{}], unsafe: ["<b>"] }, { path: "src/v.mjs", exports: { id: "v" }, hooks: ['data-act="go"'] }),
    buildTest({ kind: "svg-chart", emptyText: "No data" }, { path: "src/c.mjs", data: [{ v: 1 }], label: "L", mark: "rect", min: 1 }),
  ];
  srcs.forEach((s, i) => { const f = join(dir, `k${i}.mjs`); writeFileSync(f, s); assert.equal(spawnSync(process.execPath, ["--check", f]).status, 0, s); });
  assert.throws(() => buildTest({ kind: "nope" }, { path: "x" }), /unknown test kind/);
});

test("exportsDigest and shapeOf describe code without prose", async () => {
  const d = exportsDigest("m.mjs", "export function add(a, b) {}\nexport const sub = (a, b) => a - b;\nexport const K = 3;\nconst hidden = 1;");
  assert.match(d, /add\(a, b\)/); assert.match(d, /sub\(a, b\)/); assert.match(d, /K = 3/); assert.ok(!d.includes("hidden"));
  const s = await shapeOf({ n: 1, list: [{ id: "x" }], f: () => [{ m: "2026-01" }], g: (y) => y }, { probe: { g: [5] } });
  assert.match(s, /list: \[\{ id: string e\.g\. "x" \}\] \(1\)/);
  assert.match(s, /f: fn\(\) → \[\{ m: string/);
  assert.match(s, /g: fn\(y\) → number/);
});
