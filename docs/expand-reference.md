# expand.json — complete reference

`PROJECT/.is-worker/expand.json` lists every family of sibling files qwen should write, in one run. You write each family's
example file to disk first; the spec only names it. Everything below is the whole format: do not read harness code.

```json
{
  "instructions": "rules shared by every pattern (optional)",
  "reads": ["src/shared.mjs"],
  "patterns": [
    {
      "name": "views",
      "instructions": "rules for this family: exports, style, what to use from ctx",
      "example": { "path": "src/views/accounts.mjs", "exports": { "id": "accounts", "title": "Accounts" }, "hooks": ["data-act=\"account.create\""] },
      "reads": ["src/ctx.mjs"],
      "digest": true,
      "test": { "kind": "html-view", "fixture": ".is-worker/fixtures/ctx.mjs", "variants": [{}, { "edit": "first" }], "root": "^\\s*<section", "unsafe": ["<b>x"] },
      "targets": [
        { "path": "src/views/budgets.mjs", "exports": { "id": "budgets", "title": "Budgets" }, "hooks": ["data-form=\"budget.set\""], "spec": "one or two lines of what this one shows" }
      ]
    }
  ]
}
```

## Fields
- `example.path` (required): a file you already wrote. Its content is read from disk; never paste it into the spec.
  The example carries the same test fields as a target, and the pattern's test must pass on it (checked before any qwen call).
- `reads`: files qwen sees in full. With `"digest": true` it gets their export signatures instead, plus the live shape of the
  `html-view` fixture: never describe an interface in prose.
- `spec`: one or two lines per target. Anything the test checks (`hooks`, `cases`, `data`) is already sent to qwen.
- `samples` (default 3), `retries` (default 1): parallel candidates per retry round after a failed first attempt.
- `test_template`: free-form node:test source with `{{path}}` and `{{params.NAME}}` (target `params`), importing
  `process.env.IS_WORKER_WORK + "/" + "{{path}}"`. Only when no kind below fits.

## Test kinds
| kind | pattern `test` fields | target / example fields | checks |
|---|---|---|---|
| `pure-fn` | — | `exports: ["name"]`, `cases: [{fn, args, equals \| match \| throws \| type}]` | each case: deep-equal result, regex on `String(result)`, throws, or `typeof` |
| `html-view` | `fixture` (module; default export = object or `fn(params)` built from the app's real modules), `variants` (params list), `root` (regex), `unsafe` (strings that must be escaped), `fn` (default `render`) | `exports: {name: value}`, `hooks: [substring…]` | string output for every variant, root matches, no `undefined`/`NaN`/`[object`, unsafe strings absent, every hook present |
| `svg-chart` | `fn` (default `render`), `width`/`height` (default 640×260), `emptyText` | `data`, `label`, `mark` (tag name), `min` | `<svg viewBox="0 0 W H">`, label present, at least `min` marks, empty data and a custom size work |

Keep `cases` minimal (2–3 per target): every case is frontier output. Put edge cases in the fixture data (an over-budget
category, a transfer, an empty list) so every view sees them.

## Running
`node "$HARNESS/scripts/is-worker.mjs" build --project PROJECT [--target-kb N] [--commit "message"] [--baseline <app>]` runs, in one
foreground command (give it a 10-minute timeout; never background it or poll): self-test of every pattern, expand,
`node --check` of every module, an import of every `src/` module under Node (browser-only modules are reported, not
failed), an optional commit, and the token table. Output is a summary; failed targets are listed with their first error
and their closest candidate is left on disk: fix that file, then run `build --verify-only --commit "…"`.
