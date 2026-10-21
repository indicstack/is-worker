// The typed review's gate: probabilities from logprobs, the Score, and the statements with or without a checklist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pFine, scoreValue, statementsFor } from "../review/typed-gate.mjs";

const lp = (pairs) => pairs.map(([token, p]) => ({ token, logprob: Math.log(p) }));
test("pFine: YES/NO mass is normalised over the variants that appear; null when neither does", () => {
  assert.ok(Math.abs(pFine(lp([["YES", 0.6], [" NO", 0.2], ["Yes", 0.1], ["maybe", 0.1]])) - 0.7 / 0.9) < 1e-9);
  assert.equal(pFine(lp([["NO", 0.9]])), 0);
  assert.equal(pFine(lp([["hmm", 0.9]])), null);
  assert.equal(pFine([]), null);
});
test("scoreValue: probability-weighted level, only digits inside 1..n count", () => {
  const s = scoreValue(lp([["2", 0.5], ["3", 0.25], ["9", 0.1], ["x", 0.15]]), 4);
  assert.ok(Math.abs(s.value - (2 * 0.5 + 3 * 0.25) / 0.75) < 1e-9); assert.ok(Math.abs(s.mass - 0.75) < 1e-9);
  assert.deepEqual(scoreValue(lp([["x", 1]]), 4), { value: null, mass: 0 });
});
const tickets = [{ id: 1, writes: ["a.mjs"], rules: ["R1"] }, { id: 2, writes: ["b.mjs", "c.mjs"], rules: ["R2", "R3"] }];
test("statementsFor without a checklist: rules + logic + constants per ticket, nothing cross-file", () => {
  const qs = statementsFor(tickets, null, (r) => `rule ${r}`);
  assert.deepEqual(qs.map((q) => q.id), ["1.R1", "1.logic", "1.constants", "2.R2", "2.R3", "2.logic", "2.constants"]);
  assert.match(qs[0].text, /rule R1/); assert.deepEqual(qs[3].files, ["b.mjs", "c.mjs"]); assert.equal(qs.some((q) => q.kind === "cross"), false);
});
test("statementsFor with a checklist: the planner's statements per ticket, cross statements against every written file", () => {
  const ck = { "1": [{ id: "1.a", text: "A" }], cross: [{ id: "x.1", text: "X" }] };
  const qs = statementsFor(tickets, ck, (r) => r);
  assert.deepEqual(qs.map((q) => q.id), ["1.a", "2.R2", "2.R3", "2.logic", "2.constants", "x.1"], "ticket 2 has no entry, so it gets the generic three");
  assert.equal(qs[0].kind, "planner"); assert.equal(qs.at(-1).kind, "cross"); assert.deepEqual(qs.at(-1).files, ["a.mjs", "b.mjs", "c.mjs"]); assert.equal(qs.at(-1).ticket, "x");
});
