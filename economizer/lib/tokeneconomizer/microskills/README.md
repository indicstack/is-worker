# Micro-skills

How micro-skills (see the [main README](../../README.md)) are learned, kept and injected.

Each finished session goes through three steps:

1. **Observe** (`observe.py`). Every shell command is split into segments and classified by
   *intent* (run the tests, run the interpreter, use the package tool, fetch, probe the VCS) and
   *form* (how it was spelled), and its outcome is read off the output as an environmental error
   class or a sign that tests ran. The words that name intents come from a `Vocabulary`
   (`PYTHON_GIT`, `NODE_WEB`), so the same reader handles a Python or a Node repository.
2. **Propose.** `envfacts.py` turns recurring shapes of evidence into candidate facts, with no
   model call: a failing form followed by a working one (*form repair*), every fetch to a host
   refused (*boundary*), VCS probes that always come back empty (*empty probe*), a test label
   that loads once rewritten (*arg repair*), a missing environment variable that a later run
   sets (*env value*). With `paid=true`, `distiller.py` adds an LLM proposer that authors facts
   with host-checked detectors.
3. **Keep or retire** (`lifecycle.py`). A candidate becomes active after confirmations on
   three sessions (for a proposed fact about the code, sessions that edited different files),
   retires on contradiction, and is injected only while
   the failure it prevents keeps occurring (or keeps being prevented).

`stage.PrefixStage` ties these together for a caller: render the block before a session, fold
the session in after it. The block is capped (`MAX_FACTS`, `MAX_TOKENS`), and a lint refuses any
fact that reads as completion or verification advice.

| Module | |
|---|---|
| `observe.py` | command segmentation, intent and form, error classes, `observe_task` |
| `envfacts.py` | `EnvFactsDistiller`: the five LLM-free fact families, rendering, caps |
| `distiller.py` | `Distiller`: the optional paid proposer and its detector DSL |
| `lifecycle.py` | `Lifecycle`: formation, retirement, the firing gate |
| `stage.py` | `PrefixStage`, `ComposedDistiller` |
