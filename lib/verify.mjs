// The checks every build ends with, in one call: `node --check` on every module, then an import of each under Node.
// A module that fails only because it touches browser globals (document, window, localStorage…) at import time is
// reported as browser-only, not as a failure. Used by `is-worker build`.
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BROWSER = /\b(document|window|localStorage|sessionStorage|navigator|location|HTMLElement|customElements|requestAnimationFrame|matchMedia|alert|confirm|prompt)\b is not defined/;

export function modules(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name) && statSync(p).size < 1e6) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function verify(project, dir = "src") {
  const root = resolve(project, dir);
  const files = modules(root);
  const syntax = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) syntax.push({ file: relative(project, f), error: (r.stderr.split("\n").find((l) => /Error/.test(l)) || r.stderr.trim().split("\n")[0] || "").slice(0, 200) });
  }
  // One child imports every module, so a slow or hanging module cannot stop the parent; ESM import errors are caught per file.
  const script = `const out = [];
for (const f of ${JSON.stringify(files)}) {
  try { await import("file://" + f); out.push({ f, ok: true }); }
  catch (e) { out.push({ f, ok: false, error: String(e && e.message || e).split("\\n")[0].slice(0, 200) }); }
}
console.log("@@" + JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: project, encoding: "utf8", timeout: 120000 });
  let results = [];
  try { results = JSON.parse((r.stdout.split("@@")[1] || "[]").trim()); } catch { results = []; }
  const browserOnly = [], failed = [];
  for (const x of results) if (!x.ok) (BROWSER.test(x.error) ? browserOnly : failed).push({ file: relative(project, x.f), error: x.error });
  if (!results.length && files.length) failed.push({ file: dir, error: (r.stderr || "import check did not run").split("\n")[0].slice(0, 200) });
  return { files: files.length, syntax, imported: results.filter((x) => x.ok).length, browserOnly, failed, ok: !syntax.length && !failed.length };
}
