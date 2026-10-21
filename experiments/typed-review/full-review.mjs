// Option B: today's is-worker review, as it is: Opus reads BRIEF.md + DIFF.md (every file) with PROMPT-REVIEW.md and writes prose REVIEW.md.
// Same prompt as the harness; the files are inlined instead of read with tools (no tool loop, so if anything this is cheaper than 12 Oct).
//   node full-review.mjs --folder ~/eval-isolated/review-... --out results.json
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { askOpus } from "./opus.mjs";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]] : []).filter((x) => x.length));
const F = resolve(args.folder);
const prompt = `${readFileSync(resolve(F, "PROMPT-REVIEW.md"), "utf8")}\n\n=== BRIEF.md ===\n${readFileSync(resolve(F, "BRIEF.md"), "utf8")}\n\n=== DIFF.md ===\n${readFileSync(resolve(F, "DIFF.md"), "utf8")}\n\nWrite the full contents of REVIEW.md now.`;
const r = await askOpus([{ role: "user", content: prompt }], { maxTokens: 16000 });
writeFileSync(resolve(F, "REVIEW.md"), r.text);
const verdict = (r.text.match(/^.*Verdict.*$/mi) || [""])[0];
const findings = (r.text.match(/Logic findings[\s\S]*?(?=\n#+ |\n\*\*Playability|\nPlayability)/i) || [""])[0];
const out = { folder: F, seconds: Number(r.seconds.toFixed(1)), usage: r.usage, verdict, findings };
writeFileSync(resolve(args.out || resolve(F, "result.json")), JSON.stringify(out, null, 2));
console.log(`opus full review: in ${r.usage.input} out ${r.usage.output} $${r.usage.cost_usd} ${r.seconds.toFixed(1)}s\n${verdict}\n${findings.slice(0, 1500)}`);
