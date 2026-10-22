// Interface digests for `expand` (N1 + N3): instead of the frontier model describing an interface in prose, the harness
// reads it from code. exportsDigest() lists a module's exports with their signatures; shapeOf() walks a live value (a
// fixture built from the app's real modules) and prints its shape, calling zero-argument functions and any function
// named in `probe` to show what they return.

const sig = (fn) => {
  const s = Function.prototype.toString.call(fn);
  const m = s.match(/^(?:async\s+)?(?:function\*?\s*[\w$]*\s*)?\(([^)]*)\)/) || s.match(/^(?:async\s+)?([\w$]+)\s*=>/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "…";
};

export function exportsDigest(path, src) {
  const out = [];
  for (const line of src.split("\n")) {
    let m;
    if ((m = line.match(/^export\s+(async\s+)?function\*?\s+([\w$]+)\s*\(([^)]*)\)/))) out.push(`${m[1] ? "async " : ""}${m[2]}(${m[3].trim()})`);
    else if ((m = line.match(/^export\s+const\s+([\w$]+)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>/))) out.push(`${m[1]}(${m[3].trim()})`);
    else if ((m = line.match(/^export\s+const\s+([\w$]+)\s*=\s*(async\s*)?([\w$]+)\s*=>/))) out.push(`${m[1]}(${m[3]})`);
    else if ((m = line.match(/^export\s+(?:const|let)\s+([\w$]+)\s*=\s*(.*)$/))) out.push(`${m[1]} = ${m[2].slice(0, 90)}${m[2].length > 90 ? "…" : ""}`);
    else if ((m = line.match(/^export\s+class\s+([\w$]+)/))) out.push(`class ${m[1]}`);
    else if ((m = line.match(/^export\s*\{([^}]*)\}/))) out.push(`{${m[1].trim()}}`);
  }
  return `${path} exports:\n${out.map((x) => "  " + x).join("\n") || "  (none)"}`;
}

const prim = (v) => {
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 24 ? `string e.g. ${JSON.stringify(v.slice(0, 24) + "…")}` : `string e.g. ${JSON.stringify(v)}`;
  if (typeof v === "number") return Number.isInteger(v) ? "number" : "number (decimal)";
  return typeof v;
};

export async function shapeOf(v, { depth = 6, probe = {}, path = "", seen = new Set() } = {}) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return prim(v);
  if (typeof v === "function") {
    const s = `(${sig(v)})`;
    const args = probe[path] ?? (v.length === 0 ? [] : null);
    if (!args || depth <= 0) return `fn${s}`;
    try { const r = await v(...args); return `fn${s} → ${await shapeOf(r, { depth: Math.max(depth, 3), probe, path: path + "()", seen })}`; }
    catch { return `fn${s}`; }
  }
  if (seen.has(v) || depth <= 0) return Array.isArray(v) ? "[…]" : "{…}";
  seen.add(v);
  if (Array.isArray(v)) return v.length ? `[${await shapeOf(v[0], { depth: depth - 1, probe, path: path + "[]", seen })}] (${v.length})` : "[] (empty)";
  const keys = Object.keys(v);
  const parts = [];
  for (const k of keys.slice(0, 30)) parts.push(`${k}: ${await shapeOf(v[k], { depth: depth - 1, probe, path: path ? `${path}.${k}` : k, seen })}`);
  if (keys.length > 30) parts.push(`… ${keys.length - 30} more`);
  return `{ ${parts.join(", ")} }`;
}
