// Builds a fresh isolated review folder outside this project: BRIEF.md, DIFF.md (the run's game files
// as a unified diff against an empty tree), and a byte-identical PROMPT-REVIEW.md. Then leak-scans it.
//   node review/make-review.mjs --run runs/<id> [--out ~/eval-isolated]
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { ROOT, loadBrief } from "../lib/brief.mjs";
import { BRIEF_PATH, WORK_ROOT } from "../lib/paths.mjs";
import { updateMeta, runPaths } from "../lib/runs.mjs";
import { loadTickets } from "../lib/prompt.mjs";
import { spawnSync } from "node:child_process";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
if (!args.run) { console.error("usage: node review/make-review.mjs --run runs/<id> [--out dir]"); process.exit(2); }
// Fail in one line (exit 2), never with a stack trace: a bad --run or a missing/unfrozen brief are user errors.
const runDir = resolve(ROOT, args.run);
if (!existsSync(resolve(runDir, "meta.json"))) { console.error(`no run at ${runDir} (no meta.json)`); process.exit(2); }
if (!existsSync(BRIEF_PATH)) { console.error(`no brief at ${BRIEF_PATH}`); process.exit(2); }
try { loadBrief(); } catch (e) { console.error(e.message); process.exit(2); }
const work = runPaths(runDir).work;
if (!existsSync(work)) { console.error(`no work dir ${work}`); process.exit(2); }
const outBase = resolve(String(args.out || resolve(homedir(), "eval-isolated")));
if (outBase.startsWith(ROOT)) { console.error("review folder must be outside the project"); process.exit(2); }
mkdirSync(outBase, { recursive: true });
const date = new Date().toISOString().slice(0, 10);
let n = 1, dir;
do { dir = resolve(outBase, `review-${date}-${n++}`); } while (existsSync(dir));
mkdirSync(dir);

// Project mode: the diff of every file the tickets write, against git HEAD when the project is a git repo
// (new files appear as additions). Bench mode: every file under game/ as a new-file diff.
function walk(dir, base = "") { const out = []; for (const n of readdirSync(dir).sort()) { const p = join(dir, n); if (statSync(p).isDirectory()) out.push(...walk(p, base + n + "/")); else out.push(base + n); } return out; }
const newFileDiff = (rel, abs) => { const lines = readFileSync(abs, "utf8").split("\n"); if (lines[lines.length - 1] === "") lines.pop(); return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n") + "\n"; };
let text = "";
let prefix = "";
if (WORK_ROOT) {
  const files = [...new Set(loadTickets().flatMap((t) => t.writes))].filter((f) => existsSync(resolve(work, f))).sort();
  const isGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: work, encoding: "utf8" }).stdout?.trim() === "true";
  for (const f of files) {
    const tracked = isGit && spawnSync("git", ["ls-files", "--error-unmatch", f], { cwd: work }).status === 0;
    if (tracked) { const d = spawnSync("git", ["diff", "--no-color", "HEAD", "--", f], { cwd: work, encoding: "utf8", maxBuffer: 50e6 }).stdout; text += d || `(${f}: unchanged since HEAD)\n`; }
    else text += newFileDiff(f, resolve(work, f));
  }
  prefix = "Diff of every file the tickets wrote" + (isGit ? ", against the project's git HEAD (new files as additions)." : ".");
} else {
  const game = resolve(work, "game");
  for (const rel of walk(game)) text += newFileDiff("game/" + rel, resolve(game, rel));
  prefix = "Diff of every file under game/ in one run, against an empty tree. Harness-owned game/constants.mjs is included.";
}
const header = `${prefix}\n\n`;
writeFileSync(resolve(dir, "DIFF.md"), header + "```diff\n" + text + "\n```\n");
copyFileSync(BRIEF_PATH, resolve(dir, "BRIEF.md"));
copyFileSync(resolve(ROOT, "review/PROMPT-REVIEW.md"), resolve(dir, "PROMPT-REVIEW.md"));

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
if (sha(resolve(dir, "PROMPT-REVIEW.md")) !== sha(resolve(ROOT, "review/PROMPT-REVIEW.md"))) { console.error("PROMPT-REVIEW.md copy differs"); process.exit(1); }

// leak scan: model, vendor and project names must not appear in the review folder
const LEAK = /qwen|indicstack|openrouter|opus|claude|anthropic|is-worker|is-worker|calibrat|worker|planner/i;
const leaks = [];
for (const f of readdirSync(dir)) { const t = readFileSync(resolve(dir, f), "utf8"); t.split("\n").forEach((line, i) => { if (f !== "PROMPT-REVIEW.md" && LEAK.test(line)) leaks.push(`${f}:${i + 1}: ${line.slice(0, 120)}`); }); }
updateMeta(runDir, { reviewFolder: dir, reviewPromptSha256: sha(resolve(dir, "PROMPT-REVIEW.md")) });
console.log(`review folder: ${dir}`);
console.log(`files: ${readdirSync(dir).join(", ")}`);
console.log(leaks.length ? `LEAKS (${leaks.length}):\n${leaks.join("\n")}` : "leak scan: clean");
console.log(`\nNext: open a new Claude Code session in ${dir} and send @PROMPT-REVIEW.md. Say "done" here when it has written REVIEW.md.`);
