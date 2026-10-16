// `init` writes the planner instructions where each agentic IDE reads them, never overwriting what is already there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { HOME } from "../lib/paths.mjs";
import { START, END, merge, IDES, PLUGIN_COMMANDS } from "../lib/init.mjs";

const tmp = mkdtempSync(resolve(tmpdir(), "isw-init-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const init = (project, ide) => spawnSync(process.execPath, [resolve(HOME, "scripts/is-worker.mjs"), "init", "--project", project, "--ide", ide], { encoding: "utf8", cwd: HOME });
const fresh = (name) => { const p = resolve(tmp, name); mkdirSync(p, { recursive: true }); return p; };
const read = (p) => readFileSync(p, "utf8");
const count = (text, needle) => text.split(needle).length - 1;
const expectFiles = { cursor: [".cursor/rules/is-worker.mdc", "AGENTS.md"], codex: ["AGENTS.md"], opencode: ["AGENTS.md"], antigravity: ["AGENTS.md", ".agent/rules/is-worker.md"], all: ["AGENTS.md", ".cursor/rules/is-worker.mdc", ".agent/rules/is-worker.md"] };
const allFiles = ["AGENTS.md", ".cursor/rules/is-worker.mdc", ".agent/rules/is-worker.md"];

for (const ide of Object.keys(expectFiles)) {
  test(`init --ide ${ide} writes exactly its files, with markers and the harness path filled in`, () => {
    const p = fresh(ide);
    const r = init(p, ide);
    assert.equal(r.status, 0, r.stderr);
    for (const f of allFiles) assert.equal(existsSync(resolve(p, f)), expectFiles[ide].includes(f), `${ide}: ${f}`);
    for (const f of expectFiles[ide]) {
      const t = read(resolve(p, f));
      assert.equal(count(t, START), 1, `${f} start marker`); assert.equal(count(t, END), 1, `${f} end marker`);
      assert.ok(t.includes(HOME), `${f} has the absolute harness path`);
      assert.ok(!t.includes("IS_WORKER_HOME"), `${f} placeholder replaced`);
      assert.ok(t.includes("## Step 0 — connect"), `${f} carries the steps`);
      assert.match(r.stdout, new RegExp(`wrote .*${f.replace(/[.]/g, "\\.")}`));
    }
  });
}
test("cursor rule file starts with the agent-requested frontmatter", () => {
  const t = read(resolve(tmp, "cursor", ".cursor/rules/is-worker.mdc"));
  assert.ok(t.startsWith("---\ndescription: IndicStack is-worker planner\nalwaysApply: false\nglobs: []\n---\n" + START), t.slice(0, 160));
});
test("init --ide claude writes nothing and prints the two plugin commands", () => {
  const p = fresh("claude");
  const r = init(p, "claude");
  assert.equal(r.status, 0, r.stderr);
  for (const f of allFiles) assert.equal(existsSync(resolve(p, f)), false, f);
  for (const c of PLUGIN_COMMANDS) assert.ok(r.stdout.includes(c), c);
});
test("init --ide all also prints the plugin commands", () => { assert.ok(init(fresh("all2"), "all").stdout.includes(PLUGIN_COMMANDS[1])); });
test("an existing AGENTS.md is kept: section appended, then replaced on a second run, never duplicated", () => {
  const p = fresh("append");
  writeFileSync(resolve(p, "AGENTS.md"), "# My project\n\nkeep me\n");
  let r = init(p, "codex"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /appended is-worker section to .*AGENTS\.md/);
  let t = read(resolve(p, "AGENTS.md"));
  assert.ok(t.startsWith("# My project\n\nkeep me\n"), "original text first"); assert.equal(count(t, START), 1); assert.equal(count(t, END), 1);
  r = init(p, "opencode"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /replaced is-worker section in .*AGENTS\.md/);
  const t2 = read(resolve(p, "AGENTS.md"));
  assert.ok(t2.startsWith("# My project\n\nkeep me\n")); assert.equal(count(t2, START), 1); assert.equal(count(t2, END), 1); assert.equal(t2, t, "second run is idempotent");
});
test("existing .mdc and .agent files get the same append/replace treatment", () => {
  const p = fresh("append2");
  mkdirSync(resolve(p, ".cursor/rules"), { recursive: true }); mkdirSync(resolve(p, ".agent/rules"), { recursive: true });
  writeFileSync(resolve(p, ".cursor/rules/is-worker.mdc"), "---\ndescription: mine\nalwaysApply: true\n---\nmy rule\n");
  writeFileSync(resolve(p, ".agent/rules/is-worker.md"), "my antigravity rule\n");
  init(p, "all"); init(p, "all");
  const m = read(resolve(p, ".cursor/rules/is-worker.mdc")), a = read(resolve(p, ".agent/rules/is-worker.md"));
  assert.ok(m.startsWith("---\ndescription: mine\nalwaysApply: true\n---\nmy rule\n")); assert.equal(count(m, START), 1);
  assert.ok(a.startsWith("my antigravity rule\n")); assert.equal(count(a, START), 1);
});
test("merge: pure cases", () => {
  assert.deepEqual(merge(null, "X", "H\n"), { text: `H\n${START}\nX\n${END}\n`, action: "new" });
  assert.equal(merge("a", "X").action, "appended"); assert.ok(merge("a", "X").text.startsWith("a\n\n" + START));
  assert.equal(merge("", "X").text, `${START}\nX\n${END}\n`);
  const r = merge(`top\n${START}\nold\n${END}\nbottom\n`, "new"); assert.equal(r.action, "replaced"); assert.equal(r.text, `top\n${START}\nnew\n${END}\nbottom\n`);
});
test("unknown --ide fails with exit 2 and lists the choices", () => { const r = init(fresh("bad"), "vim"); assert.equal(r.status, 2); assert.match(r.stderr, new RegExp(IDES.join("\\|"))); });
test("init refuses the harness folder as the project", () => { const r = init(HOME, "codex"); assert.equal(r.status, 2); assert.match(r.stderr, /harness folder/); });
test("SKILL.md (Claude Code) and AGENTS.md (other IDEs) agree on every step", () => {
  const body = (t) => { const i = t.indexOf("\nGround rules (from"); assert.ok(i > 0, "shared body starts at the Ground rules line"); return t.slice(i + 1); };
  const skill = body(read(resolve(HOME, "skills/is-worker/SKILL.md"))).replaceAll("${CLAUDE_PLUGIN_ROOT}", "IS_WORKER_HOME");
  const agents = body(read(resolve(HOME, "AGENTS.md")));
  assert.ok(skill.length > 2000); assert.equal(skill, agents);
  for (const step of ["Step 0", "Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Step 6", "Step 7"]) assert.ok(agents.includes(`## ${step}`), step);
  for (const rule of ["never write an identifier", "do not write ticket code yourself", "Keep the API key out of chat", "Never overwrite a run"]) assert.ok(agents.includes(rule), rule);
});
