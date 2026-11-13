// Local stub of an OpenAI-compatible streaming server for offline tests.
// The scenario is chosen by the request's model name: ok, slow, hang, stall, runaway, cutoff, empty, badjson, http503, http429, nonstream, flaky-then-ok.
import { createServer } from "node:http";

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (text, finish = null, usage) => ({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: finish }], ...(usage ? { usage } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
const GOOD = JSON.stringify({ files: [{ path: "game/physics.mjs", content: "export const x = 1;\n" }] });

export function startStub(port = 0) {
  const state = { calls: 0, flakyLeft: 2, counts: {} };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "stub-qwen-3.8-27b", name: "Qwen 3.8 27B", context_length: 4096, pricing: { prompt: "0.000001", completion: "0.000002" } }] })); }
    const req0 = JSON.parse(body);
    const mode = req0.model;
    state.calls++; state.counts[mode] = (state.counts[mode] || 0) + 1;
    if (req0.max_tokens > 65536) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: `This model's maximum context length is 65536 tokens. However, you requested ${req0.max_tokens + 20} tokens.` } })); }
    if (mode === "http503") { res.writeHead(503); return res.end("upstream unavailable"); }
const GOOD1 = JSON.stringify({ files: [{ path: "game/index.html", content: "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"><title>Flappy</title></head>\n<body style=\"margin:0\">\n<canvas id=\"game\" width=\"400\" height=\"600\"></canvas>\n<script type=\"module\">\nimport { start } from \"./main.mjs\";\nstart(document.getElementById('game'), window, window.localStorage);\n</script>\n</body>\n</html>\n" }, { path: "game/main.mjs", content: "import { CANVAS_W, CANVAS_H, GROUND_Y, GROUND_HEIGHT, BIRD_X, BIRD_START_Y, BIRD_W, BIRD_H, MAX_DT } from \"./constants.mjs\";\nlet bird, last = null;\nexport function render(ctx, st = {}) {\n  const b = st.bird || bird; if (!b) return;\n  ctx.fillStyle = \"#70c5ce\"; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);\n  ctx.fillStyle = \"#ded895\"; ctx.fillRect(0, GROUND_Y, CANVAS_W, GROUND_HEIGHT);\n  ctx.fillStyle = \"#f5d33a\"; ctx.fillRect(b.x, b.y, b.w, b.h);\n}\nexport function start(canvas, win, storage) {\n  const ctx = canvas.getContext(\"2d\");\n  bird = { x: BIRD_X, y: BIRD_START_Y, w: BIRD_W, h: BIRD_H, vy: 0 };\n  const frame = (t) => { const dt = last == null ? 0 : Math.min((t - last) / 1000, MAX_DT); last = t; render(ctx, { bird }); win.requestAnimationFrame(frame); };\n  win.requestAnimationFrame(frame);\n}\n" }] });
    if (mode === "http401") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } })); }
    if (mode === "ok-then-401" && (state.counts[mode] || 0) > 4) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } })); }
    if (mode === "ok-then-401") { res.writeHead(200, { "content-type": "text/event-stream" }); sse(res, chunk(GOOD1)); sse(res, chunk("", "stop", { prompt_tokens: 100, completion_tokens: 20 })); res.write("data: [DONE]\n\n"); return res.end(); }
    if (mode === "http429") { res.writeHead(429, { "retry-after": "0" }); return res.end("your credit balance may be exhausted, or you are sending too fast"); }
    if (mode === "http400") { res.writeHead(400); return res.end("bad request"); }
    if (mode === "flaky") { if (state.flakyLeft-- > 0) { res.writeHead(503); return res.end("flaky"); } }
    if (mode === "nonstream") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content: GOOD }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
    if (mode === "hang") { await sleep(60000); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const usage = { prompt_tokens: 100, completion_tokens: 20 };
    if (mode === "stall") { sse(res, chunk("{\"files\":")); await sleep(60000); return res.end(); }
    if (mode === "slow") { for (const ch of GOOD.match(/.{1,8}/g)) { sse(res, chunk(ch)); await sleep(40); } sse(res, chunk("", "stop", usage)); res.write("data: [DONE]\n\n"); return res.end(); }
    if (mode === "runaway") { for (let i = 0; i < 40; i++) { sse(res, chunk("ab".repeat(50))); await sleep(2); } sse(res, chunk("", "stop", usage)); return res.end(); }
    if (mode === "cutoff") { sse(res, chunk(GOOD.slice(0, 20))); sse(res, chunk("", "length", usage)); res.write("data: [DONE]\n\n"); return res.end(); }
    if (mode === "empty") { sse(res, { choices: [{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null }] }); sse(res, chunk("", "stop", { ...usage, completion_tokens_details: { reasoning_tokens: 20 } })); return res.end(); }
    if (mode === "badjson") { sse(res, chunk("{\"files\": [oops")); sse(res, chunk("", "stop", usage)); return res.end(); }
    // ok, flaky (after failures), anything else
    const text = req0.messages.some((m) => /\[fix /.test(m.content)) ? GOOD : GOOD;
    sse(res, chunk(text)); sse(res, chunk("", "stop", usage)); res.write("data: [DONE]\n\n"); res.end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state, port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

if (process.argv[1] && process.argv[1].endsWith("stub.mjs")) startStub(Number(process.argv[2] || 3901)).then((s) => console.log(`stub on ${s.baseUrl}`));
