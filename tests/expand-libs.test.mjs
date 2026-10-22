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

test("adoption counts frontier writes, reads and harness commands from a transcript", async () => {
  const { adoption } = await import("../lib/tokens.mjs");
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  writeFileSync(join(dir, "a.mjs"), "x".repeat(100));
  const rec = (content) => JSON.stringify({ type: "assistant", timestamp: "2026-10-22T00:00:01Z", message: { content } });
  const t = join(dir, "t.jsonl");
  writeFileSync(t, [
    rec([{ type: "tool_use", name: "Write", input: { file_path: join(dir, "src/x.mjs"), content: "abcd" } }]),
    rec([{ type: "tool_use", name: "Write", input: { file_path: join(dir, ".is-worker/expand.json"), content: "{}" } }]),
    rec([{ type: "tool_use", name: "Read", input: { file_path: join(dir, "a.mjs") } }]),
    rec([{ type: "tool_use", name: "Edit", input: { file_path: join(dir, "a.mjs"), old_string: "x", new_string: "yy" } }]),
    rec([{ type: "tool_use", name: "Bash", input: { command: `cat > src/y.mjs <<'EOF'\nhello\nEOF\nnode is-worker.mjs expand --project . --self-test && node is-worker.mjs expand --project . ; node is-worker.mjs digest --query "csv"` } }]),
    rec([{ type: "tool_use", name: "Write", input: { file_path: "/elsewhere/z.mjs", content: "zzz" } }]),
  ].join("\n"));
  const a = adoption({ files: [t], project: dir });
  assert.deepEqual([a.codeFiles, a.codeBytes, a.specFiles, a.edits, a.editBytes, a.readFiles, a.readBytes], [2, 9, 1, 1, 2, 1, 100]);
  assert.deepEqual([a.selfTests, a.expandRuns, a.digestQueries, a.digestRuns], [1, 1, 1, 0]);
});

test("aloneEstimate pools every run of an app and flags another model", async () => {
  const { aloneEstimate } = await import("../lib/tokens.mjs");
  const dir = mkdtempSync(join(tmpdir(), "base-"));
  const u = (o) => ({ calls: 10, input: 0, cache_write: 0, cache_read: 0, output: o });
  writeFileSync(join(dir, "b.json"), JSON.stringify({ baselines: [
    { app: "x", model: "claude-fable-5-1", code_bytes: 1000, usage: u(100) },
    { app: "x", model: "claude-opus-5-5", code_bytes: 2000, usage: u(200) },
    { app: "x", model: "claude-opus-5-5", code_bytes: 4000, usage: u(400) } ] }));
  const same = aloneEstimate({ baselinesFile: join(dir, "b.json"), baselineApp: "x", model: "claude-opus-5-5" });
  assert.deepEqual([same.n, same.usage.output, same.code_bytes, same.modelMismatch], [2, 300, 3000, null]);
  const other = aloneEstimate({ baselinesFile: join(dir, "b.json"), baselineApp: "x", model: "claude-sonnet-5-5" });
  assert.deepEqual([other.n, other.modelMismatch], [3, "claude-fable-5-1"]);
});

test("verify separates syntax errors, browser-only modules and real import failures", async () => {
  const { verify } = await import("../lib/verify.mjs");
  const { mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/ok.mjs"), "export const a = 1;");
  writeFileSync(join(dir, "src/dom.mjs"), "document.title = 'x';");
  writeFileSync(join(dir, "src/bad.mjs"), "import { nope } from './ok.mjs';");
  writeFileSync(join(dir, "src/syntax.mjs"), "export const = ;");
  const v = verify(dir);
  assert.equal(v.files, 4); assert.equal(v.syntax.length, 1); assert.equal(v.browserOnly[0].file, "src/dom.mjs");
  assert.ok(v.failed.some((x) => x.file === "src/bad.mjs")); assert.equal(v.ok, false);
});

test("economizer gate answers no-change before a repository has history", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const hook = new URL("../economizer/scripts/te-hook", import.meta.url).pathname;
  for (const ev of ["SessionStart", "PostToolUse", "Stop"]) {
    const r = spawnSync(hook, [], { input: JSON.stringify({ hook_event_name: ev, session_id: "t", cwd: dir }), encoding: "utf8", env: { ...process.env, TE_HOME: join(dir, ".te"), HOME: dir } });
    assert.equal(r.stdout.trim(), "{}", ev);
  }
});
