---
name: is-worker
description: Build or extend an app or feature cheaply with IndicStack's qwen model writing the repetitive files. Use automatically whenever a request means writing a whole app or a feature with several similar files (views, charts, routes, validators, formatters, data); also on /is-worker. Claude writes the app in one pass and leaves repetitive files as marked stubs; one build command has qwen fill them, tests each against its stub, checks every module, commits and prints a token table. Skip it for small edits and bug fixes.
---
# /is-worker — stub route (0.10.1B)

HARNESS = `${CLAUDE_PLUGIN_ROOT}`; PROJECT = the working directory.

Ground rules (from `HARNESS/explainer.html`):
- Every turn re-reads the whole conversation: finish in **two turns** — one Bash call that writes everything and runs the build, then your reply. A third only if the build lists failures.
- Never read harness code or other docs; never review qwen's files yourself; never sum tokens by hand (the build prints the table).
- Keep the API key out of chat and the repo.

## The one call
In a single Bash call, write every file with heredocs, then run the build:
1. **Write coupled and novel code in full**: store, schema, main logic, app shell, routing, styles, `index.html`.
2. **Write repetitive files as stubs** (views, charts, formatters, validators, parsers, filters, data, per-feature helpers): the real imports and exported signatures, one comment per export saying what it does and returns, a first line `// @qwen`, and 1–3 `// @test <expression>` lines (`m` is the module; e.g. `// @test m.render(sample).includes("<svg")`). Empty bodies. Make every stub self-sufficient: name its inputs' shapes in the comment.
3. Mark only what qwen can write from the stub alone. Fewer than 4 stubs: write them in full instead and skip the harness.
4. End the call with: `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" build --project PROJECT --commit "<message>"` (foreground, 10-minute timeout). It fills the stubs with qwen (3 parallel retries on failure), tests each against its stub, checks and imports every module, commits and prints the token table.

## Then
- Build OK → paste the table and one way to open the app. Stop.
- Files listed as left → fix exactly those (the closest candidate is on disk), then `build --project PROJECT --verify-only --commit "<message>"`.
- `IS-WORKER: NOT CONNECTED` → tell the user to save the IndicStack key with the command shown, or fill the stubs yourself.
- The user asks for tickets, a review, or expand patterns → read `${CLAUDE_PLUGIN_ROOT}/docs/tickets-route.md` and follow it.
