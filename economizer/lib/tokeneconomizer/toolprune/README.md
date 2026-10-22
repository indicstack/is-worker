# Tool pruning

How tool pruning (see the [main README](../../README.md)) decides what to drop, per agent.

- **Evidence pruning** (Claude Code, Copilot CLI; `stage.ToolingStage`). After each session, a
  loaded tool's unused streak grows or resets. A tool is proposed once its streak reaches
  `evidence` sessions; a protected work-surface tool (`tools.PROTECTED_TOOLS`) or one ever seen
  in use is never proposed. An optional per-task judge (`tools.judge_tools_for_task`) can also
  drop tools the task text makes irrelevant, its cost charged to the ledger.
- **Capability pruning** (Codex; `codex.CodexUntoolProfile`). Codex's unit is a capability
  package (collaboration, goals, image/media, ...) switched off in its config. A package is
  demoted only after enough loaded-but-unused sessions, at most two per session, and a single
  use protects it for good.

This package decides *what* to drop. Writing the decision into an agent's own settings file, only
after the person approves it and only from the next session, is the plugin's job
(`tokeneconomizer/plugin/denylist.py`).

| Module | |
|---|---|
| `stage.py` | `ToolingStage`: evidence across sessions, the proposal, the Codex mask |
| `codex.py` | `CodexUntoolProfile`: Codex's evidence-gated capability controller |
| `tools.py` | the protected and inapplicable tool sets; the optional per-task tool judge |
