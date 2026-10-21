// Option C: Opus writes every ticket itself (same worker prompt qwen got), tests check each one, no separate review.
//   IS_WORKER_PROJECT=<dir> node opus-worker.mjs --out results.json
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { askOpus } from "./opus.mjs";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length));
const PROJECT = resolve(process.env.IS_WORKER_PROJECT);
const { buildMessages, loadTickets } = await import("../../lib/prompt.mjs");
const work = resolve(tmpdir(), `opus-worker-${Date.now()}`);
mkdirSync(resolve(work, "game"), { recursive: true });
cpSync(resolve(PROJECT, "game/constants.mjs"), resolve(work, "game/constants.mjs")); // harness-owned, never written by a ticket
const res = { work, tickets: [], totals: { input: 0, output: 0, cost_usd: 0, opusSeconds: 0, calls: 0 }, tests: { pass: 0, fail: 0 } };
const t0 = performance.now();
for (const t of loadTickets()) {
  const row = { id: t.id, title: t.title, attempts: [] };
  let fixes = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = buildMessages(t, work, fixes, "opus-C");
    const r = await askOpus(messages, { maxTokens: 6000 });
    res.totals.calls++; res.totals.input += r.usage.input; res.totals.output += r.usage.output; res.totals.cost_usd += r.usage.cost_usd || 0; res.totals.opusSeconds += r.seconds;
    let files = null; try { files = JSON.parse(r.text.replace(/^```json\s*|```\s*$/g, "").trim()).files; } catch {}
    const a = { attempt, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, parsed: Boolean(files), tests: null };
    if (files) for (const f of files) { if (!t.writes.includes(f.path)) continue; mkdirSync(dirname(resolve(work, f.path)), { recursive: true }); writeFileSync(resolve(work, f.path), f.content); }
    const tr = spawnSync("node", ["--test", resolve(PROJECT, ".is-worker", t.test)], { cwd: PROJECT, encoding: "utf8", env: { ...process.env, IS_WORKER_WORK: work } });
    const out = tr.stdout + tr.stderr;
    const pass = Number((out.match(/^(?:ℹ|#) pass (\d+)/m) || [0, 0])[1]), fail = Number((out.match(/^(?:ℹ|#) fail (\d+)/m) || [0, 0])[1]);
    a.tests = { pass, fail };
    row.attempts.push(a);
    console.log(`t${t.id} attempt ${attempt}: ${pass} pass ${fail} fail, ${r.usage.input} in ${r.usage.output} out $${(r.usage.cost_usd || 0).toFixed(4)} ${r.seconds.toFixed(1)}s`);
    if (fail === 0 && pass > 0) { res.tests.pass += pass; break; }
    if (attempt === 2) { res.tests.pass += pass; res.tests.fail += fail; }
    fixes = [{ name: "test-output", text: `The tests failed. Output:\n${out.slice(0, 3000)}\nFix the files and return them in full.` }];
  }
  res.tickets.push(row);
}
res.wallSeconds = Number(((performance.now() - t0) / 1000).toFixed(1));
writeFileSync(resolve(args.out || resolve(work, "result.json")), JSON.stringify(res, null, 2));
console.log(`\nopus worker: ${res.totals.calls} calls, in ${res.totals.input} out ${res.totals.output}, $${res.totals.cost_usd.toFixed(4)}, model ${res.totals.opusSeconds.toFixed(1)}s, wall ${res.wallSeconds}s, tests ${res.tests.pass}/${res.tests.pass + res.tests.fail}`);
