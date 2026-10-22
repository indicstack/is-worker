// Built-in test kinds for `expand` (N2): the frontier model gives data (hooks, cases, chart data), the harness owns the
// node:test source. A pattern sets `"test": {"kind": "pure-fn" | "html-view" | "svg-chart", …}`; each target (and the
// example, for the self-test) carries its own fields. Free-form `test_template` stays as the escape hatch.
//   pure-fn   target: {exports: ["name"], cases: [{fn, args, equals | match | throws | type}]}
//   html-view pattern.test: {fixture: "src/ctx.mjs" (default export: object or fn(params)), variants: [{params}…],
//             root: "^\\s*<section", unsafe: ["<b>x"], fn: "render"}   target: {exports: {id: "…"}, hooks: ["data-act=…"]}
//   svg-chart pattern.test: {fn: "render", width: 640, height: 260, emptyText: "No data"}
//             target: {data: […], label: "…", mark: "rect", min: 3}
export const KINDS = ["pure-fn", "html-view", "svg-chart"];

const J = (v) => JSON.stringify(v ?? null);
const head = (path) => `import test from "node:test";
import assert from "node:assert/strict";
const W = process.env.IS_WORKER_WORK;
const m = await import(W + "/" + ${J(path)});
const bad = (s) => ["undefined", "NaN", "[object "].find((x) => String(s).includes(x));
`;

function exportsBlock(t) {
  const ex = t.exports;
  if (!ex) return "";
  if (Array.isArray(ex)) return `test("exports", () => { for (const n of ${J(ex)}) assert.ok(n in m, "missing export " + n); });\n`;
  return `test("exports", () => { for (const [k, v] of Object.entries(${J(ex)})) assert.deepEqual(m[k], v, "export " + k); });\n`;
}

function pureFn(spec, t) {
  const cases = (t.cases || []).map((c, i) => {
    const call = `m[${J(c.fn)}](...${J(c.args || [])})`;
    let body;
    if (c.throws) body = `assert.throws(() => ${call});`;
    else if (c.match != null) body = `assert.match(String(${call}), new RegExp(${J(c.match)}));`;
    else if (c.type) body = `assert.equal(typeof (${call}), ${J(c.type)});`;
    else body = `assert.deepEqual(${call}, ${J(c.equals)});`;
    return `test(${J(`case ${i + 1}: ${c.fn}`)}, () => { ${body} });`;
  });
  return head(t.path) + exportsBlock(t) + cases.join("\n") + "\n";
}

function htmlView(spec, t) {
  const fn = spec.fn || "render";
  const variants = spec.variants?.length ? spec.variants : [{}];
  return head(t.path) + `const fx = (await import(W + "/" + ${J(spec.fixture)})).default;
const ctx = (p) => (typeof fx === "function" ? fx(p) : { ...fx, params: { ...(fx.params || {}), ...p } });
` + exportsBlock(t) + `test("renders every variant", async () => {
  let all = "";
  for (const p of ${J(variants)}) {
    const html = await m[${J(fn)}](ctx(p));
    assert.equal(typeof html, "string");
    assert.match(html, new RegExp(${J(spec.root || "^\\s*<")}), "root element");
    assert.ok(!bad(html), "contains " + bad(html));
    for (const u of ${J(spec.unsafe || [])}) assert.ok(!html.includes(u), "unescaped user text " + u);
    all += html;
  }
  for (const h of ${J([...(t.hooks || []), ...(t.contains || [])])}) assert.ok(all.includes(h), "missing " + h);
});
`;
}

function svgChart(spec, t) {
  const fn = spec.fn || "render", w = spec.width || 640, h = spec.height || 260;
  return head(t.path) + `test("renders an svg", () => {
  const svg = m[${J(fn)}](${J(t.data || [])});
  assert.equal(typeof svg, "string");
  assert.match(svg, /^<svg[^>]*viewBox="0 0 ${w} ${h}"/);
  assert.ok(svg.trim().endsWith("</svg>"));
  assert.ok(!bad(svg), "contains " + bad(svg));
  ${t.label ? `assert.ok(svg.includes(${J(t.label)}), "label");` : ""}
  ${t.mark ? `assert.ok((svg.match(new RegExp("<" + ${J(t.mark)} + "[ >/]", "g")) || []).length >= ${Number(t.min || 1)}, "enough <${t.mark}> marks");` : ""}
});
test("empty data and custom size", () => {
  ${spec.emptyText ? `assert.ok(m[${J(fn)}]([]).includes(${J(spec.emptyText)}), "empty state");` : `assert.equal(typeof m[${J(fn)}]([]), "string");`}
  assert.match(m[${J(fn)}](${J(t.data || [])}, { width: 300, height: 200 }), /viewBox="0 0 300 200"/);
});
`;
}

export function buildTest(spec, t) {
  if (spec.kind === "pure-fn") return pureFn(spec, t);
  if (spec.kind === "html-view") { if (!spec.fixture) throw new Error("html-view needs test.fixture"); return htmlView(spec, t); }
  if (spec.kind === "svg-chart") return svgChart(spec, t);
  throw new Error(`unknown test kind ${spec.kind} (known: ${KINDS.join(", ")})`);
}
