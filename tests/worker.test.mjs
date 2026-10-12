// Offline end-to-end: worker.mjs against the stub for the outcome paths that reach check.mjs and the queue.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { startStub } from "../stub/stub.mjs";
import { ROOT } from "../lib/brief.mjs";
import { readJsonl } from "../lib/jsonl.mjs";

let stub; const tmpRuns = mkdtempSync(resolve(tmpdir(), "is-worker-"));
before(async () => { stub = await startStub(0); });
after(() => { stub.server.closeAllConnections(); stub.server.close(); rmSync(tmpRuns, { recursive: true, force: true }); });

function spawnAsync(args, env) {
  return new Promise((resolveP) => { let out = ""; const c = spawn(process.execPath, args, { cwd: ROOT, env }); c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("exit", (status) => resolveP({ status, stderr: out })); });
}
async function runWorker(model, name, extra = {}) {
  const runDir = resolve(tmpRuns, name); mkdirSync(resolve(runDir, "work/game"), { recursive: true }); mkdirSync(resolve(runDir, "outputs"), { recursive: true });
  const stateDir = resolve(tmpRuns, `state-${name}`); mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "settings.json"), JSON.stringify({ A: { baseUrl: stub.baseUrl, model, thinking: false, concurrency: 2, maxTokens: 512, ...extra } }));
  writeFileSync(resolve(stateDir, "probe-A.json"), JSON.stringify({ context_window: 65536 }));
  const r = await spawnAsync(["worker.mjs", "--arm", "A", "--run", runDir], { ...process.env, IS_WORKER_API_KEY: "test", IS_WORKER_STATE_DIR: stateDir, IS_WORKER_TEST_FAST: "1" });
  return { r, runDir, tickets: readJsonl(resolve(runDir, "tickets.jsonl")), calls: readJsonl(resolve(runDir, "calls.jsonl")), queue: existsSync(resolve(runDir, "claude-queue.jsonl")) ? readJsonl(resolve(runDir, "claude-queue.jsonl")) : [], meta: JSON.parse(readFileSync(resolve(runDir, "meta.json"), "utf8")) };
}

test("ok answers that fail their tests get one retry with the error, then go to the queue", async () => {
  const { r, tickets, calls, queue, meta } = await runWorker("ok", "ok");
  assert.equal(r.status, 0, r.stderr);
  const latest = new Map(tickets.map((t) => [t.ticket, t]));
  assert.ok([...latest.values()].every((t) => t.status === "queued"), JSON.stringify(tickets));
  // independent tickets 1-4 each: attempt 1 ok->check fail, attempt 2 with [fix check_failure], then queue; 5 and 6 blocked by deps
  for (const id of [1, 2, 3, 4]) { const c = calls.filter((x) => x.ticket === id); assert.equal(c.length, 2, `ticket ${id} calls`); assert.deepEqual(c[1].fixes, ["check_failure"]); }
  assert.equal(queue.length, 6);
  assert.equal(meta.status, "needs_claude");
});
test("bad_json: named fix once, then queue; never resent unchanged", async () => {
  const { calls, queue } = await runWorker("badjson", "badjson");
  const c = calls.filter((x) => x.ticket === 2);
  assert.ok(c.some((x) => x.kind === "bad_json"));
  assert.equal(c.filter((x) => x.fixes?.includes("bad_json_notice")).length, 1);
  assert.ok(queue.find((q) => q.ticket === 2 && /bad_json/.test(q.reason)));
});
test("length: budget doubled once then queued", async () => {
  const { calls } = await runWorker("cutoff", "cutoff");
  const c = calls.filter((x) => x.ticket === 3);
  assert.equal(c[0].kind, "length"); assert.ok(c[1].max_tokens > c[0].max_tokens);
});
test("5xx: three tries with waits, then queue", async () => {
  const { calls, queue } = await runWorker("http503", "http503");
  assert.equal(calls.filter((x) => x.ticket === 1).length, 3);
  assert.ok(queue.find((q) => q.ticket === 1 && /http_5xx/.test(q.reason)));
});
test("429 x6: credit breaker exits with the distinct code and saves state", async () => {
  const { r, meta } = await runWorker("http429", "http429");
  assert.equal(r.status, 75);
  assert.equal(meta.status, "breaker");
});
test("flaky 503 then ok: resend is safe", async () => {
  const { calls, queue } = await runWorker("flaky", "flaky", { concurrency: 1 });
  assert.equal(calls[0].kind, "http_5xx"); assert.equal(calls[1].kind, "http_5xx");
  for (const id of [1, 2, 3, 4]) assert.ok(calls.some((c) => c.ticket === id && c.kind === "ok"), `ticket ${id} eventually got an ok answer`);
  assert.ok(queue.every((q) => !/http_5xx|unchanged/.test(q.reason)), JSON.stringify(queue.map((q) => q.reason)));
});
test("arm B makes no calls and queues every ticket", async () => {
  const runDir = resolve(tmpRuns, "B"); mkdirSync(resolve(runDir, "work/game"), { recursive: true });
  const stateDir = resolve(tmpRuns, "state-B"); mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "settings.json"), "{}");
  const r = await spawnAsync(["worker.mjs", "--arm", "B", "--run", runDir], { ...process.env, IS_WORKER_STATE_DIR: stateDir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJsonl(resolve(runDir, "claude-queue.jsonl")).length, 6);
  assert.equal(readJsonl(resolve(runDir, "calls.jsonl")).length, 0);
  assert.equal(stub.state.counts["B"], undefined);
});
