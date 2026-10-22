// N7: qwen reads long files so the frontier does not (after HazyResearch/minions: the small model reads, the frontier reasons).
// Each file above --min bytes gets a typed digest: purpose, exports with signatures and what they return, invariants and
// gotchas. Export signatures come from code (lib/digest.mjs) and are given to qwen as facts; qwen adds the meaning.
// Digests are cached by content hash in .is-worker/digests/, so an unchanged file never costs a second call.
// Writes .is-worker/DIGESTS.md: the planner reads that instead of the files.
//   IS_WORKER_PROJECT=<dir> IS_WORKER_API_KEY=… node scripts/digest.mjs [--files a.mjs,b.mjs | --dir src] [--min 3000]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
import { IS_WORKER_DIR, WORK_ROOT } from "../lib/paths.mjs";
import { armConfig } from "../lib/settings.mjs";
import { askJson } from "../lib/typed.mjs";
import { exportsDigest } from "../lib/digest.mjs";
import { createLimiter } from "../lib/limiter.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter((x) => x.length));
const key = process.env.IS_WORKER_API_KEY || process.env.INDICSTACK_API_KEY;
if (!key) { console.error("IS_WORKER_API_KEY missing"); process.exit(2); }
const project = WORK_ROOT || process.cwd();
const cfg = armConfig("A");
const min = Number(args.min ?? 3000);
const CODE = /\.(m?js|ts|tsx|jsx|css|html|py)$/;
function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (CODE.test(e.name)) out.push(p);
  }
  return out;
}
const files = (args.files ? String(args.files).split(",").map((f) => resolve(project, f.trim())) : walk(resolve(project, String(args.dir || "src"))))
  .filter((f) => existsSync(f) && statSync(f).size >= min);
const cacheDir = resolve(IS_WORKER_DIR, "digests");
mkdirSync(cacheDir, { recursive: true });

const SCHEMA = { name: "digest", strict: true, schema: { type: "object", additionalProperties: false, required: ["purpose", "exports", "invariants", "gotchas"], properties: {
  purpose: { type: "string" },
  exports: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "signature", "does"], properties: { name: { type: "string" }, signature: { type: "string" }, does: { type: "string" } } } },
  invariants: { type: "array", items: { type: "string" } },
  gotchas: { type: "array", items: { type: "string" } },
} } };
const system = [
  "You read one source file and write a digest a senior engineer can plan from without opening the file.",
  "purpose: one sentence. exports: every export listed in FACTS, with its exact signature and one short line on what it does and returns (shapes of returned objects by key names).",
  "invariants: rules the code enforces (validation, units, sign conventions, ordering). gotchas: anything surprising a caller must know. At most 6 items each, short.",
  "Never invent an export or a key that is not in the file.",
].join("\n");

const limiter = createLimiter({ start: cfg.concurrency || 4, max: cfg.concurrency || 4, cleanMultiplier: 2 });
let fresh = 0, cached = 0, inTok = 0, outTok = 0;
const results = await Promise.all(files.map(async (f) => {
  const rel = relative(project, f), src = readFileSync(f, "utf8");
  const hash = createHash("sha256").update(cfg.model + "\n" + src).digest("hex").slice(0, 16);
  const cf = resolve(cacheDir, `${hash}.json`);
  if (existsSync(cf)) { cached++; return { rel, bytes: src.length, ...JSON.parse(readFileSync(cf, "utf8")) }; }
  const facts = exportsDigest(rel, src);
  await limiter.acquire();
  try {
    const r = await askJson({ system, user: `FACTS (from code):\n${facts}\n\nFILE ${rel}:\n${src}`, schema: SCHEMA, baseUrl: cfg.baseUrl, key, model: cfg.model, maxTokens: 1500 });
    limiter.release("clean");
    fresh++; inTok += r.usage.prompt_tokens; outTok += r.usage.completion_tokens;
    writeFileSync(cf, JSON.stringify(r.value, null, 1));
    return { rel, bytes: src.length, ...r.value };
  } catch (e) { limiter.release("other"); console.error(`${rel}: ${e.message}`); return { rel, bytes: src.length, purpose: "(digest failed: read the file)", exports: [], invariants: [], gotchas: [] }; }
}));
results.sort((a, b) => a.rel.localeCompare(b.rel));
const md = ["# Digests (written by qwen from the code; read these instead of the files)", ""];
for (const d of results) {
  md.push(`## ${d.rel} (${(d.bytes / 1024).toFixed(1)} KB)`, d.purpose);
  for (const x of d.exports) md.push(`- \`${x.signature}\` — ${x.does}`);
  if (d.invariants.length) md.push(`Invariants: ${d.invariants.join("; ")}`);
  if (d.gotchas.length) md.push(`Gotchas: ${d.gotchas.join("; ")}`);
  md.push("");
}
const out = resolve(IS_WORKER_DIR, "DIGESTS.md");
writeFileSync(out, md.join("\n"));
const srcBytes = results.reduce((a, d) => a + d.bytes, 0), mdBytes = Buffer.byteLength(md.join("\n"));
console.log(`digest: ${results.length} file(s) ≥ ${min} B (${fresh} new, ${cached} cached), ${(srcBytes / 1024).toFixed(1)} KB of code → ${(mdBytes / 1024).toFixed(1)} KB in ${relative(project, out)}; qwen ${inTok} in / ${outTok} out tokens.`);
