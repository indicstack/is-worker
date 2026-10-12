import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, loadBrief } from "./brief.mjs";
import { TICKETS_PATH, TESTS_BASE } from "./paths.mjs";
import { FILES_SCHEMA } from "./schema.mjs";

// Shared text first (system: rules + the frozen brief), task last (user: reads, test, then the ticket line).
export const SHARED_RULES = [
  "You are the worker in a planner-worker-reviewer harness. You write code for exactly one ticket per call.",
  "Output only a JSON object of the shape {\"files\":[{\"path\":\"...\",\"content\":\"...\"}]}. No prose, no markdown fences.",
  "Write only the files the ticket lists under 'writes'; use those exact paths. Do not write any other file. When a file under 'writes' already exists, return its full new content.",
  "The frozen brief below is the only specification. Follow its rules and its interfaces word for word.",
  "Never invent an identifier, path or constant that the brief, the existing files or the test do not name; when the brief provides a constants file, import from it.",
  "The test file shown will be run with `node --test` against your files. Make it pass without changing it.",
  "No new dependencies unless the ticket names them. No comments longer than one line.",
].join("\n");

export function loadTickets() {
  return readFileSync(TICKETS_PATH, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// workDir: the run's work dir, so 'reads' show the files produced by earlier tickets.
export function buildMessages(ticket, workDir, fixes = [], runId = "") {
  const brief = loadBrief();
  const system = `${SHARED_RULES}\n\n=== BRIEF.md (frozen, sha256 ${brief.hash}) ===\n${brief.body}`;
  const parts = [];
  for (const rel of ticket.reads) {
    const p = resolve(workDir, rel);
    const src = existsSync(p) ? readFileSync(p, "utf8") : !process.env.IS_WORKER_PROJECT && existsSync(resolve(ROOT, rel)) ? readFileSync(resolve(ROOT, rel), "utf8") : null;
    if (src != null) parts.push(`=== existing file ${rel} ===\n${src}`);
  }
  parts.push(`=== test ${ticket.test} (run with node --test; IS_WORKER_WORK is the folder holding game/) ===\n${readFileSync(resolve(TESTS_BASE, ticket.test), "utf8")}`);
  parts.push(`=== harness facts ===\nrun: ${runId}\nticket id: ${ticket.id}\nwrites (exact paths): ${ticket.writes.join(", ")}\nrules: ${ticket.rules.join(", ")}`);
  let task = `=== ticket ${ticket.id}: ${ticket.title} ===\n${ticket.task}`;
  for (const f of fixes) task += `\n\n[fix ${f.name}] ${f.text}`;
  parts.push(task);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export function buildBody({ model, messages, maxTokens, thinking, extraBody }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: Boolean(thinking) },
    response_format: { type: "json_schema", json_schema: FILES_SCHEMA },
    messages,
  };
  if (extraBody && typeof extraBody === "object") Object.assign(body, extraBody);
  return body;
}

export const promptChars = (messages) => messages.reduce((a, m) => a + m.content.length, 0);
