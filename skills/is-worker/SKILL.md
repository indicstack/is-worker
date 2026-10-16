---
name: is-worker
description: Build a feature or app with the planner-worker-reviewer pattern on IndicStack. Use when the user types /is-worker  followed by an idea or attaches a PRD. Claude plans (brief, tickets, tests) and reviews; IndicStack's qwen model writes every ticket; scripts check every answer. Ends with a one-row cost/time table in rupees and a link to try the result.
---

# /is-worker — planner-worker-reviewer on IndicStack

Harness home: `${CLAUDE_PLUGIN_ROOT}` (call it HARNESS; it is this plugin's folder). Project: the current working directory (call it PROJECT). Everything per project lives in `PROJECT/.is-worker/`. Run every harness command with `IS_WORKER_PROJECT=PROJECT` in the environment. The same steps, packaged for Cursor, Codex, OpenCode and Antigravity, are in `${CLAUDE_PLUGIN_ROOT}/AGENTS.md`; the two files must agree from "Ground rules" onward (tests/init.test.mjs checks this).

Ground rules (from `HARNESS/explainer.html`):
- You never write an identifier, path, or number from memory into results. Numbers come from the logs; the `table` command prints them.
- You do not write ticket code yourself unless a ticket lands in `claude-queue.jsonl` after the worker failed twice.
- Keep the API key out of chat, files in the repo, and logs. Never ask the user to paste it here.
- Never overwrite a run. Rule changes go into a new brief version (re-freeze).

## Step 0 — connect (always first, every time is-worker is used)
Do these in order and show the user each result in one line. Do not plan, ask questions, or write any code until this step ends in READY.

1. **Node.** Run `node --version`. If it fails or is below 18:
   - Windows: run `winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements`. Then tell the user: "Node is installed. Restart your IDE so it sees it, then ask for is-worker again." Stop. If winget is missing, give https://nodejs.org/en/download and stop.
   - macOS: if `brew` exists run `brew install node`; otherwise give https://nodejs.org/en/download and stop.
   - Nothing here needs Python.
2. **Connection.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" doctor --project PROJECT` and repeat its first line to the user word for word.
   - `IS-WORKER: READY` → continue to the status check below.
   - `IS-WORKER: NOT CONNECTED` (key missing or rejected) → the key must be saved before anything else. If you can open a terminal panel for the user (Claude desktop app, Cursor, Antigravity), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/key.mjs"` there and tell the user to paste their IndicStack key into that panel (typing is hidden) and press Enter. In a CLI tool (Claude Code CLI, Codex CLI, OpenCode), print that command and ask the user to run it in a second terminal. Never ask for the key in chat. When the user says "saved", run doctor again. Repeat until READY.
   - `IS-WORKER: NOT CONNECTED — unreachable` → say that IndicStack is not answering, suggest checking the network or asking IndicStack ops, and stop.
   - `IS-WORKER: DEGRADED` → continue, but say that the blind review step will be skipped until the selected reviewer CLI is on the PATH (claude by default; doctor lists every reviewer CLI it found; pick another with `--reviewer codex|opencode|custom` or the `IS_WORKER_REVIEWER` environment variable).
3. **Never substitute yourself for the worker.** If the key is missing, rejected, or IndicStack is down, stop and say so. The only code you write is a ticket that appears in `claude-queue.jsonl` after a READY run.

Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" status --project PROJECT`. If a brief and tickets already exist, tell the user where they are and continue from the first unfinished step below. If the user said "status", print the one-line summary and stop.

## Step 1 — questions (max 5)
If the user attached or named a PRD or spec (docx, pdf, md), read it first (for .docx: unzip `word/document.xml` and strip tags, or use a document-reading tool you have). Treat it as the source of the brief; skip every question it already answers; list the milestones it implies. If the file can't be read (e.g. a pasteboard path), ask the user to save it inside PROJECT first.
Ask only what the brief cannot be written without: who uses it, what "done" looks like, anything they don't want, the stack if not obvious from the repo. One message, numbered. Wait.

## Step 2 — brief
Write `PROJECT/.is-worker/BRIEF.md` in plain words: deliverable, numbered rules (R1…), constants with values, interfaces each test will pin (function names, inputs, outputs). Settle every judgement call now. Show the brief, ask "ok to freeze?". On yes: `node "${CLAUDE_PLUGIN_ROOT}/scripts/freeze-brief.mjs"` with `IS_WORKER_PROJECT=PROJECT` in the environment.

## Step 3 — tickets and tests
Split into milestones (one PR each), then tickets: one file or function each, logic before UI, 4–15 per milestone. Write `PROJECT/.is-worker/tickets.jsonl`, one JSON per line:
`{"id":1,"title":"…","deps":[],"writes":["src/x.mjs"],"reads":["src/constants.mjs"],"test":"tests/t1.test.mjs","rules":["R1"],"task":"…exact instructions, quoting the brief…"}`
Write each test under `PROJECT/.is-worker/tests/` BEFORE any ticket runs (`node:test`; import the code under test from `process.env.IS_WORKER_WORK`, which is PROJECT). Harness-owned files (constants, config) you write yourself and commit first. Show the ticket list.

## Step 4 — preflight
`node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" preflight --project PROJECT`. It re-runs the connection check and refuses to continue if not READY (go back to Step 0). Preflight probes once a day (about 10 tiny calls). There is no separate calibration: the first run uses defaults and every run recalibrates budgets and timeouts from its own calls.

## Step 5 — run
Say: "N tickets, IndicStack, about ₹X" (X from the last calibration run's cost if any, else say unknown). Wait for "go". Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" run --project PROJECT`. It writes code into PROJECT, checks every ticket, re-runs earlier tickets' tests after each one. Queued tickets: write them yourself and submit with `node "${CLAUDE_PLUGIN_ROOT}/check.mjs" --run <run> --ticket N --files <json>` (with `IS_WORKER_PROJECT=PROJECT` in the environment).

## Step 6 — review and table
`node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" review --project PROJECT` runs a blind session of the selected reviewer CLI in an isolated folder: `claude` with Opus by default (about ₹50), or `--reviewer codex`, `--reviewer opencode`, or `--reviewer custom` (a command template in `IS_WORKER_REVIEW_CMD`; see `HARNESS/README.md`). Pick the one your IDE ships with: Claude Code → claude, Cursor → claude or codex, Codex CLI → codex, OpenCode → opencode, Antigravity → claude, codex or custom. If that CLI is missing the review is skipped and the table says so. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" table --project PROJECT`. Paste the table as-is. Then give the user one way to try the result (a URL, a command, or a file to open). Turn any finding the review repeats into a new test before the next milestone.

## Step 7 — next milestone
Commit on a branch named after the milestone (ask before pushing). Say "next" to continue with the next milestone from Step 3.
