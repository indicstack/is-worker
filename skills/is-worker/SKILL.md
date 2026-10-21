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
- Your own tokens are the expensive ones. One Bash call per step (batch the commands), no reading of harness source, no hand-made token sums (`table` prints them), no re-reading of files the tests already passed. Every extra turn re-reads the whole conversation.
- You never review the worker's code yourself or through a subagent, and you never start a new brief version or milestone on your own. After the table you stop and wait for the user.

## Step 0 — connect (always first, every time is-worker is used)
Do these in order and show the user each result in one line. Do not plan or write any code until this step ends in READY.

1. **Node.** Run `node --version`. If it fails or is below 18:
   - Windows: run `winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements`. Then tell the user: "Node is installed. Restart your IDE so it sees it, then ask for is-worker again." Stop. If winget is missing, give https://nodejs.org/en/download and stop.
   - macOS: if `brew` exists run `brew install node`; otherwise give https://nodejs.org/en/download and stop.
   - Nothing here needs Python.
2. **Connection.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" doctor --project PROJECT` and repeat its first line to the user word for word.
   - `IS-WORKER: READY` → continue to the status check below.
   - `IS-WORKER: NOT CONNECTED` (key missing or rejected) → the key must be saved before anything else. If you can open a terminal panel for the user (Claude desktop app, Cursor, Antigravity), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/key.mjs"` there and tell the user to paste their IndicStack key into that panel (typing is hidden) and press Enter. In a CLI tool (Claude Code CLI, Codex CLI, OpenCode), print that command and ask the user to run it in a second terminal. Never ask for the key in chat. When the user says "saved", run doctor again. Repeat until READY.
   - `IS-WORKER: NOT CONNECTED — unreachable` → say that IndicStack is not answering, suggest checking the network or asking IndicStack ops, and stop.
   - `IS-WORKER: DEGRADED` → continue, but say that the blind review step will be skipped until the selected reviewer is available (claude CLI by default; doctor lists every reviewer it found; pick another with `--reviewer codex|opencode|custom|openrouter` or the `IS_WORKER_REVIEWER` environment variable).
3. **Never substitute yourself for the worker.** If the key is missing, rejected, or IndicStack is down, stop and say so. The only code you write is a ticket that appears in `claude-queue.jsonl` after a READY run.

Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" status --project PROJECT`. If a brief and tickets already exist, tell the user where they are and continue from the first unfinished step below. If the user said "status", print the one-line summary and stop.

## Step 1 — decide, don't ask
Work like a direct build: no questionnaire. From the idea (or the PRD, if one is attached: read it first) settle every judgement call yourself — who uses it, what "done" looks like, the stack (what the repo already uses; else plain HTML/JS for a page, Node for a service), the data. Put your assumptions in ONE chat line ("Assuming: single page, no backend, 8 domains, 4+ items each, search box"). Ask at most one question, and only when a wrong guess would change the architecture (which database, which auth) and the repo gives no hint; never ask about scope, naming or looks. If the user says "ask me first" anywhere, ask up to 5 questions instead, in one message, and wait.

## Step 2 — brief, frozen at once
Write `PROJECT/.is-worker/BRIEF.md` in plain words: deliverable, numbered rules (R1…), constants with values, interfaces each test will pin (function names, inputs, outputs). Settle every judgement call now. Freeze it immediately with `node "${CLAUDE_PLUGIN_ROOT}/scripts/freeze-brief.mjs"` (IS_WORKER_PROJECT=PROJECT in the environment). Do not ask "ok to freeze?": a wrong brief costs one new version, a question costs a round trip. Say where the brief is, in the same line as the assumptions.

## Step 3 — tickets, tests, checklist
Keep frontier tokens low: the worker writes the code, you only plan. Keep tickets and tests short, read only files you must, and never re-read worker output to double-check it; the tests do that. Size note: if the whole build is likely under ~15 KB of code (about 400 lines), say so in one line ("small enough to build directly; using the worker as asked") and continue. Write the fewest tests that pin each ticket's interface (2–3 per ticket), not exhaustive suites: test code you write is frontier output.
One milestone unless the brief is plainly too big for one PR (more than ~15 tickets) or an attached PRD names phases; then one milestone per phase. Tickets: one file or function each, logic before UI, 4–15 per milestone. Keep each ticket's answer under about 1,500 tokens (roughly 120 lines): a file with many similar items (36 SVGs, 40 data entries) is split across several files and tickets, never one ticket. Write `PROJECT/.is-worker/tickets.jsonl`, one JSON per line:
`{"id":1,"title":"…","deps":[],"writes":["src/x.mjs"],"reads":["src/constants.mjs"],"test":"tests/t1.test.mjs","rules":["R1"],"task":"…exact instructions, quoting the brief…"}`
Write each test under `PROJECT/.is-worker/tests/` BEFORE any ticket runs (`node:test`; import the code under test from `process.env.IS_WORKER_WORK`, which is PROJECT). Harness-owned files (constants, config) you write yourself and commit first.
Then write the review checklist, `PROJECT/.is-worker/checklist.json`, from the brief alone (never from code): the statements the blind review will judge. Each statement is one sentence that is TRUE when the code is fine. Two or three per ticket on what its tests cannot pin (ordering, purity, edge values), plus `cross` statements about behaviour that spans files (state shared between modules, restart, persistence, input handling, error paths) — those are the ones that find real bugs. One `score` question rates each ticket's bug risk. Shape:
`{"score":{"text":"How likely is it that this ticket's code has a bug the tests would not catch?","levels":["Clearly correct","Minor doubt","Likely a bug","Clearly broken"]},"1":[{"id":"1.order","text":"…"}],"2":[…],"cross":[{"id":"x.restart","text":"…"}]}`
Without this file the review falls back to three generic statements per ticket, which miss cross-file bugs. Do not paste the ticket list; say "N tickets, M tests, checklist written" in one line.

## Step 4 — preflight
`node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" preflight --project PROJECT`. It re-runs the connection check and refuses to continue if not READY (go back to Step 0). Preflight probes once a day (about 10 tiny calls). There is no separate calibration: the first run uses defaults and every run recalibrates budgets and timeouts from its own calls.

## Step 5 — run without waiting
Say "N tickets, IndicStack, about ₹X" (X from the last calibration run's cost if any, else the first-run estimate in `${CLAUDE_PLUGIN_ROOT}/defaults.json`). When X is at or under `auto_go_inr` in `${CLAUDE_PLUGIN_ROOT}/defaults.json`, run at once; above it, wait for "go". Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" run --project PROJECT`. It writes code into PROJECT, checks every ticket, re-runs earlier tickets' tests after each one. Queued tickets: first read the queue reason. If the failing test is wrong or stricter than the brief, fix the test and resubmit the worker's files unchanged; only write code for the exact failure named. Submit with `node "${CLAUDE_PLUGIN_ROOT}/check.mjs" --run <run> --ticket N --files <json>` (with `IS_WORKER_PROJECT=PROJECT` in the environment).

## Step 6 — review and table
`node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" review --project PROJECT` is a typed review: ONE blind call of the selected reviewer, over every file involved, answers each cross-file statement in `checklist.json` (plus the per-ticket statements of tickets that were retried, queued or failed) YES or NO with a file, line and one-line reason; every NO is a finding. Clean tickets' own statements are skipped: their tests pinned them. `--gate` first has the worker model judge every statement with one token (logprobs) and close the confident ones; it costs about 36 s of worker time per review and is off by default. The reviewer defaults to `claude` with Opus for this small call (`--model` to change). `--reviewer openrouter` sends the same blind folder to OpenRouter instead of a CLI (key in `OPENROUTER_API_KEY` or `IS_WORKER_KEY_C`, exact cost back); `--reviewer codex`, `opencode` or `custom` (a command template in `IS_WORKER_REVIEW_CMD`; see `HARNESS/README.md`) work as before. Pick the one your IDE ships with: Claude Code → claude, Cursor → claude or codex, Codex CLI → codex, OpenCode → opencode, Antigravity → claude, codex or custom; any IDE → openrouter. `--full` is the old prose review of the whole diff (Sonnet by default, skipped on a clean run, troubled tickets only unless `--force`); use it only if the user asks. If the reviewer is missing the review is skipped and the table says so. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" table --project PROJECT`. Paste the table as-is, including its note line. Then give the user one way to try the result (a URL, a command, or a file to open), and stop. If the review was skipped or could not run, say so in one line and do not replace it with your own reading or a subagent. Only if the user asks for changes: turn each finding into a test before the next milestone.

## Step 7 — next milestone
Commit on a branch named after the milestone (ask before pushing). Only when the user says "next" (with what they want) do you continue with the next milestone from Step 3; never from your own or a reviewer's findings alone.
