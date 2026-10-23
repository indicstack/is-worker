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

## Once invoked, it stays on
When the user invokes is-worker or says to use it, apply it to EVERY change in this session until they say stop, whatever the size. Before each change, say in one line how it splits (e.g. "is-worker: 3 chunks to qwen, layout tweak myself"). After each build, say what qwen wrote (chunks/stubs finished, KB). Never skip it silently.
Route every piece, at any size:
- **New repetitive files** (plain .js/.mjs) → stubs (below).
- **New files in TypeScript/TSX/JSX, or edits to existing code of ~15+ lines** → chunks (below); a whole new file is a chunk without `region`.
- **Edits under ~15 lines, or layout/visual tuning that needs your eye** → write yourself; say so in the one-line split.
- **A PRD or requirements doc** → map each requirement ID to the stubs/chunks that implement it (`"req": ["FR-1"]` on a chunk) so nothing is missed.
Batch: plan all pieces of the change in ONE Bash call that writes the files/specs and runs the build, so qwen's work runs in parallel and you add no extra turns.

## The one call
In a single Bash call, write every file with heredocs, then run the build:
1. **Write coupled and novel code in full**: store, schema, main logic, app shell, routing, styles, `index.html`.
2. **Write repetitive files as stubs** (views, charts, formatters, validators, parsers, filters, data, per-feature helpers): the real imports and exported signatures, one comment per export saying what it does and returns, a first line `// @qwen`, and 1–3 `// @test <expression>` lines (`m` is the module; e.g. `// @test m.render(sample).includes("<svg")`). Empty bodies. Make every stub self-sufficient: name its inputs' shapes in the comment.
3. Mark only what qwen can write from the stub alone. Any number of stubs is fine (one is fine): the build runs them in parallel.
4. End the call with: `node "${CLAUDE_PLUGIN_ROOT}/scripts/is-worker.mjs" build --project PROJECT --commit "<message>"` (foreground, 10-minute timeout). It fills the stubs with qwen (3 parallel retries on failure), tests each against its stub, checks and imports every module, commits and prints the token table.

## Small tasks in existing code (chunk route)
For a change to an existing project (a fix, a feature, a refactor), qwen is not an agent: it cannot explore the repo and sees only what you give it. You plan, it edits:
1. Read only the code the change touches. Then, in one Bash call, write `PROJECT/.is-worker/chunks.json` and run the build command above.
2. `{"goal": "one line", "chunks": [{"id": "short-name", "file": "src/x.mjs", "region": {"start": "exact unique text where the region begins", "end": "exact text where it ends"}, "task": "1-5 lines: what the region must do", "context": ["src/y.mjs", "src/z.mjs:10-60"], "checks": ["m.fn(2) === 4"], "run": ["node", "--test", "test/x.test.mjs"]}]}`
3. One chunk = one function, class or block, at most ~150 lines out. Omit `region` to write a whole new or small file. Give `context` as line ranges, only what the chunk needs (the build rejects more than ~60k characters). Chunks in the same file run in order; others run in parallel.
4. Give every chunk a check: `checks` (expressions on the module, for plain .js/.mjs) or `run` (a command, no shell: e.g. `["node", "--test", "test/x.test.mjs"]`). For TypeScript or a whole-project check, put ONE command in the spec's top-level `"after"` (e.g. `["npx", "tsc", "--noEmit"]`): it runs once after all chunks, which is much faster than one per chunk.
5. A chunk qwen cannot finish after 3 retries is reverted and described in `PROJECT/.is-worker/chunks-failed.md` (task, errors, closest candidate). Fix those yourself from that file; do not re-read the rest.
Write a chunk only for edits of ~15+ lines; smaller edits you make yourself in the same call.

## Then
- Build OK → paste the table and one way to open the app. Stop.
- Files listed as left → fix exactly those (the closest candidate is on disk), then `build --project PROJECT --verify-only --commit "<message>"`.
- `IS-WORKER: NOT CONNECTED` → tell the user to save the IndicStack key with the command shown, or fill the stubs yourself.
- The user asks for tickets, a review, or expand patterns → read `${CLAUDE_PLUGIN_ROOT}/docs/tickets-route.md` and follow it.
