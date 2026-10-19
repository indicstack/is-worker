# Plan log: cut frontier tokens and wall time (19 Oct 2026)

Baseline (measured, Dino): harness total ₹54 = about ₹50 blind Opus review + about ₹1 Qwen + the rest for planning. Opus alone: ₹16. The review is about 93% of the cost. All savings below are **estimates**.

## Size gate: when NOT to use is-worker
Rule (estimate; tune with pwr-bench):
- Use Opus directly if the expected code is under about 15 KB, or there are 8 or fewer tickets, and it all fits in one file the frontier model can write in one pass. Dino (about 8 KB, 8 tickets) falls below this line.
- Use is-worker when the code is over about 30 KB, or there are many independent tickets, or the user wants rupee or India-only processing.
- Between 15 and 30 KB, run is-worker with review off.
- Where it goes: SKILL.md step 1, plus a `scripts/is-worker.mjs estimate` check. Evidence: RouteLLM and Hybrid LLM (route each job before work starts). Risk: the size estimate is wrong, so print it and let the user override.

## Ranked changes
1. **No review on clean runs (already done, not committed).** Files: check.mjs, lib/reviewer.mjs, defaults.json. Saving: about ₹50 → ₹0 on a clean run, which brings Dino from ₹54 to about ₹4. Time: removes the review step (minutes). Evidence: Agentless, LEVER, AutoMix (tests verify; escalate only on a signal). Risk: weak tests let bugs through. See item 4.
2. **Review only what changed or failed.** Feed the reviewer the brief, the failing or retried tickets' diffs, and test output, not the whole project. Files: lib/reviewer.mjs. Saving: 113k → about 10–20k tokens, so about ₹50 → about ₹5–8 (Sonnet makes it lower). Evidence: Agentless (localised context). Risk: misses problems that span tickets. Do a full review only on request.
3. **Run independent tickets in parallel.** Files: check.mjs, lib/limiter.mjs (concurrency already rate-limited). Time: Dino at 3.5 min run one after another → about 1–1.5 min at 3–4 workers (estimate, if the 12 tok/s holds per stream). Frontier tokens: none saved. Evidence: none read. Risk: hitting 429s (the breaker exists), and tickets that depend on each other. Add `deps` to tickets.jsonl.
4. **Self-debug and sample on Qwen before escalating.** On failure, retry with the test output (already partly done). On a second failure, ask for 2–3 samples and keep the one that passes. Files: worker.mjs, check.mjs. Saving: fewer failures queued to Claude (each one costs a frontier turn of about 5–15k tokens). Evidence: Self-Debugging, CodeT. Risk: small extra Qwen cost (paise).
5. **Shorter planner output.** Tickets carry only a signature and acceptance tests, with no repeated brief text. Keep one stable prefix (brief) so Claude Code caches it. Files: skills/is-worker/SKILL.md, BRIEF.md template, lib/brief.mjs. Saving: estimate 20–40% of planning output tokens. Evidence: caching docs (reads 0.05x). Risk: Qwen gets less context, so watch the first-try rate.
6. **Cache-friendly review.** If a full review runs, put the stable parts (brief, tests) first so they are cached, and the code last. Saving: small on a one-off review. Bigger when the review re-runs. Evidence: caching docs.
7. **Stronger tests from the planner** (edge cases, one test that covers all tickets together). Files: SKILL.md. This makes item 1 safe. Evidence: CodeT, LEVER. Risk: more planning tokens (estimate +1–3k).

## Expected result on Dino (estimate)
About ₹4–6 and about 1.5–2.5 min, compared with ₹54 / 3.5 min now and ₹16 for Opus alone. Below the size gate, Opus alone still wins on simplicity.
