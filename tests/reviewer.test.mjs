// Pluggable blind reviewer: the table of CLIs, the custom template, and a missing binary that skips instead of throwing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { reviewers, runReview, fillTemplate, selectedReviewer, reviewerStatus, PROMPT, DEFAULT_REVIEWER } from "../lib/reviewer.mjs";

const tmp = realpathSync(mkdtempSync(resolve(tmpdir(), "isw-rev-"))); // realpath: macOS tmpdir is a symlink and the child reports the resolved cwd
after(() => rmSync(tmp, { recursive: true, force: true }));
const base = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, IS_WORKER_API_KEY: "secret-A", INDICSTACK_API_KEY: "secret-B" };

test("reviewers table has claude, codex, opencode and custom", () => { assert.deepEqual(Object.keys(reviewers), ["claude", "codex", "opencode", "custom"]); for (const r of Object.values(reviewers)) { assert.equal(typeof r.bin, "function"); assert.equal(typeof r.usage, "function"); } });
test("claude keeps today's exact command and parses usage from the JSON line", () => {
  assert.deepEqual(reviewers.claude.args({ model: "opus" }), ["-p", "--model", "opus", "--output-format", "json", "--no-session-persistence", "--allowedTools", "Read", "Write", "Glob", "Grep"]);
  assert.equal(reviewers.claude.stdin, PROMPT);
  const u = reviewers.claude.usage('noise\n{"usage":{"input_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":7},"total_cost_usd":0.5,"modelUsage":{"claude-opus-5-5":{}}}\n');
  assert.deepEqual(u, { input: 5, cache_write: 2, cache_read: 3, output: 7, cost_usd: 0.5, model: "claude-opus-5-5" });
  assert.equal(reviewers.claude.usage("not json"), null);
});
test("codex and opencode commands match the documented flags; usage is unknown (null)", () => {
  assert.deepEqual(reviewers.codex.args({ folder: "/f", model: null }), ["exec", "--cd", "/f", "--sandbox", "workspace-write", "--skip-git-repo-check", PROMPT]);
  assert.deepEqual(reviewers.codex.args({ folder: "/f", model: "o3" }), ["exec", "--cd", "/f", "--sandbox", "workspace-write", "--skip-git-repo-check", "--model", "o3", PROMPT]);
  assert.deepEqual(reviewers.opencode.args({ model: null }), ["run", PROMPT]);
  assert.deepEqual(reviewers.opencode.args({ model: "x/y" }), ["run", "--model", "x/y", PROMPT]);
  assert.equal(reviewers.codex.usage("anything"), null); assert.equal(reviewers.opencode.usage("anything"), null);
});
test("custom template substitutes {folder} and {prompt}", () => {
  assert.equal(fillTemplate('tool --cwd "{folder}" "{prompt}" {folder}', { folder: "/a b", prompt: "P" }), 'tool --cwd "/a b" "P" /a b');
  assert.equal(reviewers.custom.command({ folder: "/x", env: { IS_WORKER_REVIEW_CMD: "r {folder} -- {prompt}" } }), `r /x -- ${PROMPT}`);
});
test("selectedReviewer: default, flag, env, unknown", () => {
  assert.equal(selectedReviewer(undefined, {}), DEFAULT_REVIEWER); assert.equal(DEFAULT_REVIEWER, "claude");
  assert.equal(selectedReviewer("Codex", {}), "codex"); assert.equal(selectedReviewer(undefined, { IS_WORKER_REVIEWER: "opencode" }), "opencode");
  assert.equal(selectedReviewer("custom", { IS_WORKER_REVIEWER: "codex" }), "custom", "flag beats env");
  assert.throws(() => selectedReviewer("nope", {}), /unknown reviewer "nope"/);
});
test("reviewerStatus marks the selected one and honours *_BIN overrides only when the file exists", () => {
  const env = { ...base, CODEX_BIN: resolve(tmp, "no-such-codex"), OPENCODE_BIN: process.execPath };
  const st = Object.fromEntries(reviewerStatus("opencode", env).map((s) => [s.name, s]));
  assert.equal(st.codex.bin, null); assert.equal(st.opencode.bin, process.execPath); assert.equal(st.opencode.selected, true); assert.equal(st.claude.selected, false); assert.equal(st.custom.bin, null);
});
test("missing codex binary: skipped, no throw, verdict names the CLI", () => {
  const r = runReview({ name: "codex", folder: tmp, env: { ...base, CODEX_BIN: resolve(tmp, "no-such-codex") } });
  assert.equal(r.skipped, true); assert.equal(r.verdict, "skipped (no codex CLI)"); assert.match(r.reason, /not found/); assert.equal(r.usage, null);
});
test("custom without IS_WORKER_REVIEW_CMD: skipped", () => {
  const r = runReview({ name: "custom", folder: tmp, env: { ...base } });
  assert.equal(r.skipped, true); assert.equal(r.verdict, "skipped (no custom CLI)"); assert.match(r.reason, /IS_WORKER_REVIEW_CMD/);
});
test("custom command that does not exist on the shell: skipped, no throw", () => {
  const r = runReview({ name: "custom", folder: tmp, env: { ...base, IS_WORKER_REVIEW_CMD: 'is-worker-no-such-binary-9f3 "{folder}" "{prompt}"' } });
  assert.equal(r.skipped, true); assert.equal(r.verdict, "skipped (no custom CLI)");
});
test("custom reviewer runs in the folder with the prompt and a blanked key, and REVIEW.md is picked up", () => {
  const script = resolve(tmp, "fake-reviewer.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync("REVIEW.md", JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), keyA: process.env.IS_WORKER_API_KEY, keyB: process.env.INDICSTACK_API_KEY }));`);
  const r = runReview({ name: "custom", folder: tmp, env: { ...base, IS_WORKER_REVIEW_CMD: `"${process.execPath}" "${script}" "{folder}" "{prompt}"` } });
  assert.equal(r.skipped, false, r.stderr); assert.equal(r.status, 0, r.stderr); assert.equal(r.usage, null); assert.ok(r.seconds >= 0);
  assert.ok(existsSync(resolve(tmp, "REVIEW.md")));
  const j = JSON.parse(readFileSync(resolve(tmp, "REVIEW.md"), "utf8"));
  assert.equal(j.cwd, tmp); assert.deepEqual(j.argv, [tmp, PROMPT]); assert.equal(j.keyA, ""); assert.equal(j.keyB, "");
});
test("unknown reviewer name throws (only the missing-binary case is soft)", () => { assert.throws(() => runReview({ name: "nope", folder: tmp }), /unknown reviewer/); });
