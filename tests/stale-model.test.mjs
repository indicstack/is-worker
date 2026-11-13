// The stale-model guard: a model that left the gateway's listing (25 Oct: gemma4-31b and medgemma4-4b were removed but
// kept serving 4xx on every call) must be caught before the first paid call, and the fix named — set the arm A model,
// never "rotate the key".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { HOME } from "../lib/paths.mjs";

const tmp = realpathSync(mkdtempSync(resolve(tmpdir(), "isw-stale-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const home = resolve(tmp, "home"); mkdirSync(home, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, INDICSTACK_API_KEY: "isw-test-not-a-key" };
const isw = (project, ...a) => spawnSync(process.execPath, [resolve(HOME, "scripts/is-worker.mjs"), ...a, "--project", project], { encoding: "utf8", cwd: HOME, env });
const fresh = (name) => { const p = resolve(tmp, name); mkdirSync(p, { recursive: true }); return p; };
// A frozen BRIEF.md (brief.mjs refuses to run without the recorded hash) so preflight reaches the guard and the probe.
// frozenBrief uses the real environment (not the sandboxed env): the guard is what this file tests, and a brief-check
// failure would hide it.
const frozenBrief = (p) => { const path = resolve(p, ".is-worker", "BRIEF.md"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "# brief\nR1. nothing\n"); const r = spawnSync(process.execPath, [resolve(HOME, "scripts/freeze-brief.mjs")], { cwd: HOME, env: { ...process.env, IS_WORKER_PROJECT: p }, encoding: "utf8" }); assert.equal(r.status, 0, `freeze-brief failed: ${r.stdout}${r.stderr}`); };
// The hit log goes to a file, not stdout: console.log from the stub deadlocked under node:test's runner (the hit lines
// never arrived), while the port line did. A file is written synchronously and read after the stub exits.
const withStub = async (ids, fn) => {
  const logPath = resolve(tmp, `stub-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
  const stub = spawn(process.execPath, ["-e", `const fs=require("node:fs");let n=0;const s=require("node:http").createServer((q,r)=>{n++;r.setHeader("content-type","application/json");r.end(JSON.stringify(${JSON.stringify({ data: ids.map((id) => ({ id })) })}));fs.appendFileSync(${JSON.stringify(logPath)},"hit "+q.url+" n="+n+"\\n");});s.listen(0,"127.0.0.1",()=>console.log("port "+s.address().port));`], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  stub.stdout.on("data", (d) => (out += d));
  stub.stderr.on("data", (d) => (err += d));
  const port = await new Promise((ok, no) => { const tick = () => { const m = out.match(/port (\d+)/); if (m) ok(m[1]); else setTimeout(tick, 20); }; tick(); setTimeout(() => no(new Error("stub did not start: " + err)), 5000); });
  let killed = false;
  const stop = () => { if (!killed) { killed = true; stub.kill(); } };
  try {
    const res = await fn(`http://127.0.0.1:${port}/v1`, {});
    stop();
    await new Promise((ok) => stub.on("close", ok)); // wait for the stub to exit so the hit log is fully written
    return { ...res, hits: readFileSync(logPath, "utf8").split("\n").filter((l) => l.startsWith("hit ")), err };
  } finally { stop(); try { rmSync(logPath, { force: true }); } catch {} }
};

test("doctor: model in the listing stays READY and says how many models", async () => {
  await withStub(["qwen38-27b"], async (base) => {
    const p = fresh("ready"); mkdirSync(resolve(p, ".is-worker", "state"), { recursive: true });
    writeFileSync(resolve(p, ".is-worker", "state", "settings.json"), JSON.stringify({ A: { baseUrl: base, model: "qwen38-27b" } }));
    const d = isw(p, "doctor");
    assert.ok(d.status === 0 || d.status === 6, `exit ${d.status}\n${d.stdout}${d.stderr}`);
    assert.match(d.stdout, /1 models listed, model qwen38-27b\)/);
  });
});

test("doctor: model missing from the listing names every listed model and says rotation is not the fix", async () => {
  await withStub(["qwen38-27b"], async (base) => {
    const p = fresh("stale"); mkdirSync(resolve(p, ".is-worker", "state"), { recursive: true });
    writeFileSync(resolve(p, ".is-worker", "state", "settings.json"), JSON.stringify({ A: { baseUrl: base, model: "gemma4-31b" } }));
    const d = isw(p, "doctor");
    assert.match(d.stdout, /model gemma4-31b IS NOT IN THE LISTING/);
    assert.match(d.stdout, /listing qwen38-27b/);
    assert.match(d.stdout, /no key rotation fixes this/);
  });
});

test("preflight: model missing from the listing exits 2 with the fix, before any chat call", async () => {
  const out = await withStub(["qwen38-27b"], async (base) => {
    const p = fresh("stale-preflight");
    mkdirSync(resolve(p, ".is-worker", "state"), { recursive: true });
    writeFileSync(resolve(p, ".is-worker", "state", "settings.json"), JSON.stringify({ A: { baseUrl: base, model: "gemma4-31b" } }));
    writeFileSync(resolve(p, ".is-worker", "tickets.jsonl"), "{}\n");
    frozenBrief(p);
    const d = isw(p, "preflight");
    assert.equal(d.status, 2, d.stdout + d.stderr);
    assert.match(d.stderr, /model gemma4-31b is not in the IndicStack listing \(qwen38-27b\)/);
    assert.match(d.stderr, /probe\.mjs.*--find-model/);
  });
  assert.deepEqual(out.hits, ["hit /v1/models n=1", "hit /v1/models n=2"], `listing checked by doctor (via preflight's connection check) and by the guard; no /chat/completions. stub err: ${out.err.slice(-300)}`);
});

test("preflight: model still listed passes the guard", async () => {
  await withStub(["qwen38-27b"], async (base) => {
    const p = fresh("ok-preflight");
    mkdirSync(resolve(p, ".is-worker", "state"), { recursive: true });
    writeFileSync(resolve(p, ".is-worker", "state", "settings.json"), JSON.stringify({ A: { baseUrl: base, model: "qwen38-27b" } }));
    writeFileSync(resolve(p, ".is-worker", "tickets.jsonl"), "{}\n");
    frozenBrief(p);
    const d = isw(p, "preflight");
    assert.equal(d.status, 2, d.stdout + d.stderr);
    assert.ok(!/is not in the IndicStack listing/.test(d.stderr), `should not die on the listing: ${d.stderr}`);
    // the stub serves only /models, so the probe's one call fails and preflight dies on "probe failed" — the listing guard itself passed
    assert.match(d.stderr, /probe failed/);
    // the guard's own line went to stdout before the probe
    assert.match(d.stdout, /models listed: qwen38-27b/);
  });
});
