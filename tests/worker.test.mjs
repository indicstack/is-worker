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

test("ok answers that fail their tests get two sampled retries with the error, then go to the queue", async () => {
  const { r, tickets, calls, queue, meta } = await runWorker("ok", "ok");
  assert.equal(r.status, 0, r.stderr);
  const latest = new Map(tickets.map((t) => [t.ticket, t]));
  assert.ok([...latest.values()].every((t) => t.status === "queued"), JSON.stringify(tickets));
  // independent tickets 1-4 each: attempt 1 ok->check fail, attempts 2 and 3 with the check_failure fixes (check_retries = 2), then queue; 5 and 6 blocked by deps
  for (const id of [1, 2, 3, 4]) { const c = calls.filter((x) => x.ticket === id); assert.equal(c.length, 3, `ticket ${id} calls`); assert.deepEqual(c[1].fixes, ["check_failure"]); assert.deepEqual(c[2].fixes, ["check_failure", "check_failure_2"]); }
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
test("401: the run stops, nothing is queued, exit 76, marker written", async () => {
  const { r, runDir, queue, meta } = await runWorker("http401", "http401");
  assert.equal(r.status, 76, r.stderr);
  assert.equal(meta.status, "key_rejected");
  assert.ok(existsSync(resolve(runDir, "key-rejected.json")));
  assert.ok(JSON.parse(readFileSync(resolve(runDir, "key-rejected.json"), "utf8")).status === 401);
  assert.equal(queue.length, 0, `a dead key must not queue tickets: ${JSON.stringify(queue)}`);
  // every call was rejected; none retried, none queued for the planner
  assert.ok(readJsonl(resolve(runDir, "calls.jsonl")).every((c) => c.http_status === 401));
});
test("401 mid-run: the run stops, the earlier ok ticket is kept, nothing queued", async () => {
  // the stub answers the first call (ticket 1, concurrency 1) and rejects every call after it
  const { r, runDir, queue, tickets } = await runWorker("ok-then-401", "okthen401", { concurrency: 1 });
  assert.equal(r.status, 76, r.stderr);
  // every in-flight ticket answered before the stop reached them; none of the queued reasons may be an HTTP error
  assert.ok(queue.every((q) => !/HTTP \d/.test(q.reason)), `a dead key must not queue tickets: ${JSON.stringify(queue)}`);
  const latest = new Map(tickets.map((t) => [t.ticket, t]));
  const t1 = latest.get(1) || {};
  assert.equal(t1.status, "ok", `ticket 1 passed its test before the key died and stays done; t1=${JSON.stringify(t1)}; tickets=${JSON.stringify(tickets)}`);
  assert.ok(readJsonl(resolve(runDir, "calls.jsonl")).some((c) => c.kind === "ok") && readJsonl(resolve(runDir, "calls.jsonl")).some((c) => c.http_status === 401), "an ok answer and a 401 are both recorded");
  // resuming the stopped run with the same dead key makes no calls and exits 76 again
  const stateDir = resolve(tmpRuns, `state-okthen401`);
  const again = await spawnAsync(["worker.mjs", "--arm", "A", "--run", runDir], { ...process.env, IS_WORKER_API_KEY: "test", IS_WORKER_STATE_DIR: stateDir, IS_WORKER_TEST_FAST: "1" });
  assert.equal(again.status, 76, again.stderr);
  const rejectedAt = JSON.parse(readFileSync(resolve(runDir, "key-rejected.json"), "utf8")).at;
  assert.ok(!readJsonl(resolve(runDir, "calls.jsonl")).some((c) => c.ts > rejectedAt), "no API calls after the key rejection");
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
