# Typed review experiment — Flappy Bird, 21 Oct 2026

Same brief, same 6 tickets, same 31 tests. Opus 5.5 via OpenRouter (exact billed cost), qwen38-27b via api.indicstack.ai.
Rate: ₹94.47/USD (frankfurter, 2026-10-21). qwen judge calls priced at the 12 Oct run's blended rate (₹1.37 / 32,329 tokens).
Worker step (qwen writes the 6 tickets: ₹1.37, 89 s, 31/31 tests) is the 12 Oct run, shared by A, B, D and E.

| | **B. is-worker today** | **C. Opus alone** | **A. Typed, per ticket** | **D. Typed, whole diff** | **E. D + planner checklist + Score** |
|---|---|---|---|---|---|
| Writes code | qwen | Opus | qwen | qwen | qwen |
| Reviews | Opus reads everything, prose | nobody (tests only) | qwen gate → Opus ×6, one ticket each | qwen gate → Opus ×1, whole diff | same as D, sharper questions |
| Questions | — | — | 30 fixed (rule / logic / constants) | 30 fixed | 23 planner-written (6 cross-file) + 6 Score |
| Sent to Opus | all | — | 17 of 30 | 21 of 30 | 8 of 23 |
| Opus tokens in / out | 7,631 / 11,360 | 30,783 / 6,770 | 7,885 / 3,872 | 7,859 / 3,189 | 6,795 / 1,809 |
| Opus cost | $0.258 = ₹24.37 | $0.259 = ₹24.42 | $0.109 = ₹10.30 | $0.095 = ₹8.99 | $0.063 = ₹5.99 |
| qwen judge cost | — | — | ₹3.07 | ₹3.09 | ₹3.32 |
| **Total cost (incl. ₹1.37 write)** | **₹25.74** | **₹24.42** | **₹14.74** | **₹13.45** | **₹10.68** |
| Review time | 98 s | — | 38 + 54 = 92 s | 36 + 31 = 67 s | 31 + 16 = **47 s** |
| **Total time** | **187 s** | **63 s** | 181 s | 156 s | **136 s** |
| Logic bugs caught (of B's 5) | 5 | not checked | 0 | 0 | **5** |
| Other findings | — | — | 3 hard-coded numbers | 3 hard-coded numbers | — |

Reference: the 12 Oct review through the Claude Code CLI (tool loop, cache writes) cost ₹51.10 and took 101 s for what B did here for ₹24.37.

## What each step taught

- **A → D (whole diff in one call):** cheaper and faster, still blind. The generic "no logic bug" question is the problem, not the slice.
- **D → E (planner writes the questions):** 5 of 5. Opus cost drops to a quarter of B; review time to half. The planner's cross-file statements are what found the bugs. qwen's gate also rated all five below 0.85 on its own.
- **Score (piece 1):** qwen's risk score ranked ticket 1 and 6 (main.mjs) highest, which is where 4 of 5 bugs live. Useful as a tie-breaker; it opened no extra item here.
- **Parallel qwen:** no gain. 8 concurrent calls took 36 s, same as sequential; api.indicstack.ai serves qwen one call at a time. Each call ~1.2 s alone.
- **IndicStack's response cache:** a repeated identical prompt returns in 0.0 s. v2 adds a run id to every prompt so timings are real.

**Disclosure:** the planner (Claude) wrote checklist-planner.json after seeing B's findings. Three statements (restart reseed, storage errors, key auto-repeat) are standard review questions but were written knowing the answers. The fair test is the next project, where the planner writes the checklist before any review exists.

## Threshold from data (piece 3, on our own labels, not WorkflowEvals)

44 statements have an Opus answer. Treating Opus as truth:

| qwen P(fine) | n | Opus said fine |
|---|---|---|
| 0.0–0.2 | 3 | 0% |
| 0.2–0.5 | 18 | 72% |
| 0.5–0.7 | 6 | 83% |
| 0.7–0.9 | 17 | 88% |

| threshold | escalated (of 44) | bugs missed |
|---|---|---|
| 0.5 | 21 | 3 |
| 0.7 | 27 | 2 |
| 0.8 | 39 | 1 (reseed, P=0.82) |
| **0.85** | 42 | **0** |

qwen is a ranker, not a calibrated judge: a 0.3 is "fine" 7 times in 10. 0.85 is the lowest threshold that missed nothing here. Only escalated items have labels, so this is a floor, not a full calibration. WorkflowEvals' 700 cases were not run: they are invoice/support/security tasks, not code review, so they would calibrate a different question.

## Files
- typed-review.mjs — A. typed-review-v2.mjs — D and E. checklist-planner.json — E's questions. opus.mjs — OpenRouter helper. full-review.mjs — B. opus-worker.mjs — C.
- Raw results in flappy-bird/.is-worker/: typed-review.json (A), typed-review-D.json, typed-review-E.json, full-review-B.json, opus-worker-C.json. B's REVIEW.md: ~/eval-isolated/review-2026-10-21-6.
