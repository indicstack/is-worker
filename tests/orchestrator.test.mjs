// The orchestrator fails cleanly on user errors: exit 2, one line that says where it looked and what to do, never a stack trace.
// Runs with an empty $HOME and no key so nothing is read from ~/.is-worker and no IndicStack call can happen.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { HOME } from "../lib/paths.mjs";

const tmp = realpathSync(mkdtempSync(resolve(tmpdir(), "isw-orch-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const home = resolve(tmp, "home"); mkdirSync(home, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot };
const isw = (project, ...a) => spawnSync(process.execPath, [resolve(HOME, "scripts/is-worker.mjs"), ...a, "--project", project], { encoding: "utf8", cwd: HOME, env });
const fresh = (name) => { const p = resolve(tmp, name); mkdirSync(p, { recursive: true }); return p; };
const fakeRun = (project, id = "2026-10-16-A") => { const d = resolve(project, ".is-worker", "runs", id); mkdirSync(d, { recursive: true }); writeFileSync(resolve(d, "meta.json"), JSON.stringify({ id, status: "done", model: "m" })); return d; };
const clean = (r, re) => {
  assert.equal(r.status, 2, `exit ${r.status}\n${r.stderr}${r.stdout}`);
  assert.match(r.stderr, re);
  assert.doesNotMatch(r.stderr, /^\s*at /m, "no stack frames:\n" + r.stderr);
  assert.doesNotMatch(r.stderr, /node:fs|node:internal/, "no Node internals:\n" + r.stderr);
  assert.equal(r.stderr.trim().split("\n").length, 1, "one line:\n" + r.stderr);
};

for (const cmd of ["review", "table"]) {
  test(`${cmd} with no run names the runs folder and the next command`, () => {
    const p = fresh(`norun-${cmd}`);
    clean(isw(p, cmd), new RegExp(`no run found under .*${cmd === "review" ? "norun-review" : "norun-table"}.*runs\\. Run \`node .*is-worker\\.mjs" run --project`));
  });
  test(`${cmd} --run <missing dir> names the path and exits 2 without a stack trace`, () => {
    const p = fresh(`badrun-${cmd}`);
    clean(isw(p, cmd, "--run", resolve(p, "nope")), /no run found at .*nope \(no meta\.json there\)/);
  });
}
test("review of a run whose project has no brief: one line from make-review, no stack trace", () => {
  const p = fresh("nobrief");
  clean(isw(p, "review", "--run", fakeRun(p)), /^review folder not built: no brief at .*nobrief\/\.is-worker\/BRIEF\.md\n$/);
});
test("review of a run whose brief is not frozen: one line, no stack trace", () => {
  const p = fresh("unfrozen"), run = fakeRun(p);
  writeFileSync(resolve(p, ".is-worker", "BRIEF.md"), "# brief\nR1. nothing\n");
  clean(isw(p, "review", "--run", run), /^review folder not built: .*BRIEF\.md is not frozen/);
});
test("make-review.mjs itself refuses a missing run and a missing brief in one line each", () => {
  const p = fresh("direct");
  const mk = (run) => spawnSync(process.execPath, [resolve(HOME, "review/make-review.mjs"), "--run", run], { encoding: "utf8", cwd: HOME, env: { ...env, IS_WORKER_PROJECT: p } });
  let r = mk(resolve(p, "nope")); assert.equal(r.status, 2); assert.match(r.stderr, /^no run at .*nope \(no meta\.json\)\n$/);
  r = mk(fakeRun(p)); assert.equal(r.status, 2); assert.match(r.stderr, /^no brief at .*direct\/\.is-worker\/BRIEF\.md\n$/);
});
test("doctor --project probes that project's settings, not the harness's (IS_WORKER_PROJECT is set in-process)", async () => {
  // A local stub (its own process: spawnSync would starve an in-process server) stands in for IndicStack; the project's
  // settings.json points at it. If the orchestrator read the harness's own settings, the line would name a different URL
  // and the stub would log no request.
  const { spawn } = await import("node:child_process");
  const stub = spawn(process.execPath, ["-e", 'const s=require("node:http").createServer((q,r)=>{console.log("hit "+q.url);r.setHeader("content-type","application/json");r.end(JSON.stringify({data:[{id:"stub-model"}]}))});s.listen(0,"127.0.0.1",()=>console.log("port "+s.address().port));'], { stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; stub.stdout.on("data", (d) => (out += d));
  const port = await new Promise((ok, no) => { const tick = () => { const m = out.match(/port (\d+)/); if (m) ok(m[1]); else setTimeout(tick, 20); }; tick(); setTimeout(() => no(new Error("stub did not start")), 5000); });
  try {
    const base = `http://127.0.0.1:${port}/v1`;
    const p = fresh("settings"); mkdirSync(resolve(p, ".is-worker", "state"), { recursive: true });
    writeFileSync(resolve(p, ".is-worker", "state", "settings.json"), JSON.stringify({ A: { baseUrl: base, model: "stub-model" } }));
    const d = spawnSync(process.execPath, [resolve(HOME, "scripts/is-worker.mjs"), "doctor", "--project", p], { encoding: "utf8", cwd: HOME, env: { ...env, INDICSTACK_API_KEY: "isw-test-not-a-key" } });
    assert.ok(d.status === 0 || d.status === 6, `exit ${d.status}\n${d.stdout}${d.stderr}`); // 6 only where no claude CLI is installed
    assert.match(d.stdout, new RegExp(`indicstack api: connected \\(${base.replace(/[.]/g, "\\.")}, 1 models listed, model stub-model\\)`));
  } finally {
    stub.kill(); await new Promise((ok) => stub.on("close", ok));
  }
  assert.deepEqual(out.split("\n").filter((l) => l.startsWith("hit ")), ["hit /v1/models"]);
});
