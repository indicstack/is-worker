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

## Install (Mac, Windows, Linux)

Needs Claude Code 2.1.289+. Node 18+ is needed too; if it is missing, `/is-worker` installs it for you (winget on Windows, Homebrew on Mac) or gives you the download link. No Python.

Inside Claude Code:
```
/plugin marketplace add IndicStack/is-worker
/plugin install is-worker@indicstack
```
Then type `/is-worker` with your idea. The first thing it does is a connection check (`doctor`): Node, the `claude` command, and whether IndicStack accepts your key. If no key is saved it opens the key prompt for you (hidden input, never in chat) and refuses to plan or write code until IndicStack answers `READY`. Alternatively set the `INDICSTACK_API_KEY` environment variable before starting Claude Code.

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

## Use

Open any project folder in Claude Code and type `/is-worker` followed by your idea, or attach a PRD. The skill asks a few questions, writes a frozen brief, tickets and tests, waits for your go, runs IndicStack on every ticket, runs a blind review, and prints a one-row table (tokens, ₹ cost, tests, findings, time).

Per-project files live in `<project>/.is-worker/` (brief, tickets, tests, runs, state). Run logs are git-ignored.


## Layout

- `skills/is-worker/SKILL.md` — the recipe Claude follows (the /is-worker command)
- `scripts/is-worker.mjs` — doctor, status, preflight, run, review, table
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
