// `init`: copies the planner instructions (AGENTS.md at the harness root, with IS_WORKER_HOME replaced by the
// absolute harness path) into the file each agentic IDE reads. Never overwrites silently: the text sits between
// <!-- is-worker:start --> and <!-- is-worker:end --> markers; an existing file gets the section appended, an
// existing section gets replaced in place.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { HOME } from "./paths.mjs";

export const START = "<!-- is-worker:start -->";
export const END = "<!-- is-worker:end -->";
export const IDES = ["claude", "cursor", "codex", "opencode", "antigravity", "all"];
export const PLUGIN_COMMANDS = ["/plugin marketplace add IndicStack/is-worker", "/plugin install is-worker@indicstack"];

// Cursor rule file (agent-requested: Cursor offers it to the agent by description, never injects it unasked).
const CURSOR_FRONTMATTER = "---\ndescription: IndicStack is-worker planner\nalwaysApply: false\nglobs: []\n---\n";

// Where each tool reads instructions from, relative to the project root.
export const targets = {
  agents: { rel: "AGENTS.md", readBy: "Cursor, Codex CLI, OpenCode, Antigravity" },
  cursor: { rel: ".cursor/rules/is-worker.mdc", readBy: "Cursor (rule, agent-requested)", head: CURSOR_FRONTMATTER },
  antigravity: { rel: ".agent/rules/is-worker.md", readBy: "Antigravity (rule)" },
};
export const filesFor = {
  claude: [],
  cursor: ["cursor", "agents"],
  codex: ["agents"],
  opencode: ["agents"],
  antigravity: ["agents", "antigravity"],
  all: ["agents", "cursor", "antigravity"],
};

export function plannerText(home = HOME) {
  return readFileSync(resolve(home, "AGENTS.md"), "utf8").replaceAll("IS_WORKER_HOME", () => home);
}

// Pure: returns the new file text and what happened (new | appended | replaced).
export function merge(existing, section, head = "") {
  const block = `${START}\n${section.trim()}\n${END}\n`;
  if (existing == null) return { text: head + block, action: "new" };
  const s = existing.indexOf(START), e = existing.indexOf(END, s);
  if (s !== -1 && e !== -1) return { text: existing.slice(0, s) + block + existing.slice(e + END.length).replace(/^\n/, ""), action: "replaced" };
  const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { text: existing + sep + block, action: "appended" };
}

export function initProject({ project, ide = "all", home = HOME }) {
  ide = String(ide).toLowerCase();
  if (!IDES.includes(ide)) throw new Error(`unknown --ide "${ide}"; one of ${IDES.join("|")}`);
  project = resolve(project);
  if (project === resolve(home)) throw new Error("--project must be a project folder, not the harness folder itself");
  const text = plannerText(home);
  const written = [];
  for (const key of filesFor[ide]) {
    const t = targets[key];
    const path = resolve(project, t.rel);
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    const { text: out, action } = merge(existing, text, t.head || "");
    writeFileSync(path, out);
    written.push({ path, action, readBy: t.readBy });
  }
  return { project, ide, written, claude: ide === "claude" || ide === "all" };
}
