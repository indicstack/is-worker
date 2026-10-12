# pwris-model — planner-worker-reviewer on IndicStack

Claude plans and reviews. IndicStack's Qwen model writes every ticket. Plain Node scripts check every answer. Pattern: `explainer.html` (Prasanth Ghanta, Oct 2026).

## Install (Mac, Windows, Linux)

Needs Claude Code 2.1.289+. Node 18+ is needed too; if it is missing, `/pwris` installs it for you (winget on Windows, Homebrew on Mac) or gives you the download link. No Python.

Inside Claude Code:
```
/plugin marketplace add IndicStack/pwris-model
/plugin install pwris@indicstack
```
Then type `/pwris` with your idea. The first thing it does is a connection check (`doctor`): Node, the `claude` command, and whether IndicStack accepts your key. If no key is saved it opens the key prompt for you (hidden input, never in chat) and refuses to plan or write code until IndicStack answers `READY`. Alternatively set the `INDICSTACK_API_KEY` environment variable before starting Claude Code.

Check the connection yourself any time:
```
node "<plugin folder>/scripts/pwris.mjs" doctor
```

## Workflow

![workflow](docs/workflow.svg)

## Use

Open any project folder in Claude Code and type `/pwris` followed by your idea, or attach a PRD. The skill asks a few questions, writes a frozen brief, tickets and tests, waits for your go, runs IndicStack on every ticket, runs a blind review, and prints a one-row table (tokens, ₹ cost, tests, findings, time).

Per-project files live in `<project>/.pwr/` (brief, tickets, tests, runs, state). Run logs are git-ignored.

## The bench (optional)

`npm run ui` opens http://127.0.0.1:3900 to compare arms (IndicStack, Opus alone, OpenRouter) on the same brief. Offline tests: `npm test` (stub server, every outcome of the worker loop).

## Layout

- `skills/pwris/SKILL.md` — the recipe Claude follows
- `scripts/pwris.mjs` — doctor, status, preflight, run, review, table
- `docs/workflow.svg` — the end-to-end flow from prompt to table
- `worker.mjs`, `check.mjs`, `probe.mjs`, `calibrate.mjs`, `lib/` — the harness
- `review/` — isolated blind review folder builder and its byte-identical prompt
- `BRIEF.md`, `tickets.jsonl`, `tests/` — the Flappy Bird bench task
