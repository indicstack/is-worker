---
name: is-worker
description: Opt-in only. Use ONLY when the user explicitly types /is-worker or names is-worker. Never use it on your own for ordinary app, feature or code requests: build those directly. When invoked, Claude writes the app in one pass leaving repetitive files as // @qwen stubs, and one build command has IndicStack's qwen fill and test them.
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

## Small tasks in existing code (chunk route)
For a change to an existing project (a fix, a feature, a refactor), qwen is not an agent: it cannot explore the repo and sees only what you give it. You plan, it edits:
1. Read only the code the change touches. Then, in one Bash call, write `PROJECT/.is-worker/chunks.json` and run the build command above.
2. `{"goal": "one line", "chunks": [{"id": "short-name", "file": "src/x.mjs", "region": {"start": "exact unique text where the region begins", "end": "exact text where it ends"}, "task": "1-5 lines: what the region must do", "context": ["src/y.mjs", "src/z.mjs:10-60"], "checks": ["m.fn(2) === 4"], "run": ["node", "--test", "test/x.test.mjs"]}]}`
3. One chunk = one function, class or block, at most ~150 lines out. Omit `region` to write a whole new or small file. Give `context` as line ranges, only what the chunk needs (the build rejects more than ~60k characters). Chunks in the same file run in order; others run in parallel.
4. Give every chunk a check: `checks` (expressions on the module, for plain .js/.mjs) or `run` (a command, no shell: e.g. `["node", "--test", "test/x.test.mjs"]` or `["npx", "tsc", "--noEmit"]`). Write the test first if none exists.
5. A chunk qwen cannot finish after 3 retries is reverted and described in `PROJECT/.is-worker/chunks-failed.md` (task, errors, closest candidate). Fix those yourself from that file; do not re-read the rest.
Skip the chunk route when the whole change is under ~40 lines: write it yourself.

## Then
- Build OK → paste the table and one way to open the app. Stop.
- Files listed as left → fix exactly those (the closest candidate is on disk), then `build --project PROJECT --verify-only --commit "<message>"`.
- `IS-WORKER: NOT CONNECTED` → tell the user to save the IndicStack key with the command shown, or fill the stubs yourself.
- The user asks for tickets, a review, or expand patterns → read `${CLAUDE_PLUGIN_ROOT}/docs/tickets-route.md` and follow it.
