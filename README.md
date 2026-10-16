# IndicStack worker (/is-worker) — planner-worker-reviewer on IndicStack

## Quick start

Copy the text below and paste it into the Claude Code prompt box (the message field at the bottom of the Claude Code window, or the `claude` prompt in your terminal). Claude Code does the rest: it installs the plugin from this repository, checks your IndicStack connection, and starts `/is-worker`.

```
Set up IndicStack for me from https://github.com/indicstack/is-worker, step by step, and wait for me after each step:
1. Run /plugin marketplace add IndicStack/is-worker, then /plugin install is-worker@indicstack.
2. Run the plugin's connection check. If Node is missing, install it. If no IndicStack API key is saved, tell me the exact command to run in my own terminal to save it, and never ask me to paste the key here.
3. When I say "saved", run the check again and confirm it says READY.
4. Then start /is-worker with the idea or PRD I give you next.
```

No IndicStack account yet? Sign up at https://console.indicstack.ai/signup. New accounts receive ₹2,000 of free credit, with no credit card required.

Claude plans and reviews. IndicStack's Qwen model writes every ticket. Plain Node scripts check every answer. Pattern: `explainer.html` (Prasanth Ghanta, Oct 2026).

## Use with other agentic IDEs (Cursor, Codex, OpenCode, Antigravity)

The Claude Code plugin is one packaging. The same planner steps live in [AGENTS.md](AGENTS.md), and the harness scripts are plain Node that never depend on which IDE drives them. Three steps:

1. **Clone the harness to a fixed folder** (the project files written in step 2 point at it, so it must stay put):
   ```
   git clone https://github.com/IndicStack/is-worker ~/is-worker
   ```
2. **Run `init` in your project.** It writes the planner instructions where your IDE reads them, with the harness path filled in. An existing `AGENTS.md` is never overwritten: a marked `<!-- is-worker:start -->…<!-- is-worker:end -->` section is appended, or replaced if it is already there.
   ```
   node ~/is-worker/scripts/is-worker.mjs init --project . --ide cursor
   ```
   `--ide` is one of `claude|cursor|codex|opencode|antigravity|all`.
3. **Open the project in the IDE and type** `use is-worker to build <your idea>` (or attach a PRD). The agent runs the connection check first, then questions → brief → tickets and tests → run → blind review → table, exactly like `/is-worker`.

| IDE | Reads | `init --ide` | Reviewer to pick (`--reviewer` or `IS_WORKER_REVIEWER`) |
|---|---|---|---|
| Claude Code | the plugin skill (`/is-worker`) | `claude` (prints the two plugin commands) | `claude` (default; Opus) |
| Cursor | `.cursor/rules/is-worker.mdc` and `AGENTS.md` | `cursor` | `claude` if the claude CLI is installed, else `codex` |
| OpenAI Codex CLI | `AGENTS.md` | `codex` | `codex` |
| OpenCode | `AGENTS.md` | `opencode` | `opencode` |
| Google Antigravity | `AGENTS.md` and `.agent/rules/is-worker.md` | `antigravity` | `claude`, `codex`, or `custom` |

The blind review is a second, headless CLI session in an isolated folder. It defaults to `claude` (Opus). `--reviewer codex` runs `codex exec`, `--reviewer opencode` runs `opencode run`, and `--reviewer custom` runs any command from `IS_WORKER_REVIEW_CMD`, for example `IS_WORKER_REVIEW_CMD='mytool --cwd "{folder}" "{prompt}"'`. Only the claude reviewer reports tokens and cost; the others show `?` in those columns. `doctor` lists every reviewer CLI it finds and says DEGRADED only when the selected one is missing (runs still work; the review is skipped). The exact CLI flags are in `lib/reviewer.mjs` with the versions they were written against. The IndicStack key is saved the same way in every IDE: `node ~/is-worker/scripts/key.mjs` in your own terminal, never in chat.

## Install (Mac, Windows, Linux)

Needs Claude Code 2.1.289+. Node 18+ is needed too; if it is missing, `/is-worker` installs it for you (winget on Windows, Homebrew on Mac) or gives you the download link. No Python.

Inside Claude Code:
```
/plugin marketplace add IndicStack/is-worker
/plugin install is-worker@indicstack
```
Then type `/is-worker` with your idea. The first thing it does is a connection check (`doctor`): Node, the reviewer CLI (`claude` by default), and whether IndicStack accepts your key. If no key is saved it opens the key prompt for you (hidden input, never in chat) and refuses to plan or write code until IndicStack answers `READY`. Alternatively set the `INDICSTACK_API_KEY` environment variable before starting Claude Code.

Check the connection yourself any time:
```
node "<plugin folder>/scripts/is-worker.mjs" doctor
```

## Cost

New IndicStack accounts get ₹2,000 of free credit on sign-up, with no credit card or payment details needed. The worker model `qwen38-27b` is priced at ₹21 per 1M input tokens and ₹190 per 1M output tokens (October 2026); a 15-ticket milestone has cost about ₹9 of that in practice.

## Guide

Step-by-step with screenshots, from sign-up to the first table: [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

## Workflow

![workflow](docs/workflow.svg)

Shown for Claude Code; Cursor, Codex, OpenCode and Antigravity follow the same flow, with the reviewer of your choice at the blind-review step.

## Use

Open any project folder in Claude Code and type `/is-worker` followed by your idea, or attach a PRD. The skill asks a few questions, writes a frozen brief, tickets and tests, waits for your go, runs IndicStack on every ticket, runs a blind review, and prints a one-row table (tokens, ₹ cost, tests, findings, time).

Per-project files live in `<project>/.is-worker/` (brief, tickets, tests, runs, state). Run logs are git-ignored.


## Layout

- `skills/is-worker/SKILL.md` — the recipe Claude follows (the /is-worker command)
- `AGENTS.md` — the same recipe for any coding agent (Cursor, Codex, OpenCode, Antigravity); `init` copies it into a project
- `scripts/is-worker.mjs` — init, doctor, status, preflight, run, review, table
- `lib/init.mjs`, `lib/reviewer.mjs` — the per-IDE instruction files and the pluggable blind reviewer (claude, codex, opencode, custom)
- `docs/workflow.svg` — the end-to-end flow from prompt to table
- `worker.mjs`, `check.mjs`, `probe.mjs`, `calibrate.mjs`, `lib/` — the harness
- `review/` — isolated blind review folder builder and its byte-identical prompt
- `BRIEF.md`, `tickets.jsonl`, `tests/` — the Flappy Bird bench task

## Upgrading from an older name

If you installed `pwris@indicstack` or `is@indicstack` before 12 Oct 2026:
```
/plugin uninstall is@indicstack
/plugin marketplace remove indicstack
/plugin marketplace add IndicStack/is-worker
/plugin install is-worker@indicstack
```
