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

## Option F — split the writing by the dependency graph (21 Oct, later run)

Rule: the ticket with the most deps (the critical-path tail, ticket 6) is written by Opus; qwen writes the rest. No qwen gate: Opus answers the whole planner checklist (23 statements) in one typed call over the full diff. Budget: Opus tokens under 3/5 of Opus-alone (22,532).

| | **C. Opus alone** | **E. typed, wired in** | **F. split write + typed review** |
|---|---|---|---|
| qwen | — | 6 tickets ₹1.37 (89 s) + gate ₹3.25 (40 s) | 5 tickets, 22,376 tokens, ₹0.95, 50 s (t1 needed a retry) |
| Opus writes | 37,553 tokens | — | ticket 6: 10,698 tokens, $0.093, 27 s |
| Opus reviews | — | 9,443 tokens, $0.063, 17 s | 11,774 tokens, $0.099, 31 s |
| **Opus tokens** | 37,553 | 9,443 | **22,472 (60%)** |
| **Total cost** | ₹24.42 | ₹10.24 | **₹19.1** |
| **Total time** | 63 s | 146 s | **108 s** |
| Tests | 31/31 | 31/31 | 31/31 |
| Findings | none looked | 5 | 5 (4 of the known 5; best-write not flagged in Opus's own main.mjs; new: rng closure impurity) |

F is 26% faster than E for the same findings, at the token cap. It is not 63 s: with IndicStack serving one request per key, the chain is qwen 50 s → Opus t6 27 s → review 31 s. Overlapping the review of tickets 1–5 with Opus writing t6 would cut ~20 s but costs ~3,700 more Opus tokens (70% of Opus-alone), over the cap. The remaining time lever is the same as before: per-key parallelism on IndicStack, which would let tickets 1–4 run at once (qwen 50 s → ~15 s, F → ~75 s).

Script: option-f.mjs. Raw: flappy-bird/.is-worker/option-F.json.

## Option G — contract-first, two lanes, commit in order (21 Oct, evening)

Correction first: IndicStack is NOT one request per key. A probe with ticket-sized prompts (3.5k in, 184 out): 1 call 5.5 s, 4 concurrent calls 7.5 s each — near 4× throughput. The earlier gate was slow because 30 prompts of 2.5k tokens are prefill-bound, not because of a cap. Everything below uses qwen concurrency 4.

**Design (option-g.mjs; the rules generalise from tickets.jsonl + brief + calibration):**
1. Contract-first: the frozen brief pins every interface, so every ticket starts at t=0. A dependency orders the commit and the test of a ticket, not its writing; 'reads' that do not exist yet are absent from the prompt.
2. Two lanes: qwen (4 at once) and Opus (parallel, expensive). Knapsack rule: longest expected qwen time first (calibration tokens ÷ 50 tok/s × expected attempts) into the Opus lane while Opus tokens ÷ all tokens ≤ cap. With the cap at 0.4 on this six-ticket project it picks nothing; `--frontier 6` forces the tail ticket.
3. Commit in order: files land in the work dir only after every dep has committed, so when two tickets write one file the later one in dependency order wins, whichever finished first.
4. Keep-green: a ticket that rewrites an earlier ticket's file gets that ticket's test in its prompt and in its own test run (static from tickets.jsonl, no regression pass needed to discover it).
5. Ladder: a failed ticket retries on the cheap lane if it has a free slot, then goes to Opus; an Opus ticket falls back to qwen. Final regression blames the last writer of the failing test's files and uses the same ladder.
6. Review: the 6 cross-file statements only (+ per-ticket statements of escalated tickets), one Opus call, no gate.

| | **C. Opus alone** | **F** | **G-cheap (all qwen)** | **G (Opus writes the tail)** |
|---|---|---|---|---|
| qwen tokens | 0 | 22,376 | 32,456 (t6 twice) | 17,443 |
| Opus tokens | 37,553 | 22,472 | 22,681 (t6 fix + review) | 19,242 (t6 + review) |
| Opus share of all tokens | 100% | 50% | 41% | 52% |
| Opus vs Opus-alone | 100% | 60% | 60% | 51% |
| Cost | ₹24.42 | ₹19.1 | ₹16.4 | ₹14.9 |
| **Wall** | 63 s | 108 s | 98 s | **42.5 s** |
| Tests | 31/31 | 31/31 | 31/31 | 31/31 first try |
| Findings | — | 5 | 5 | 5 |

**What decided it.** Ticket 6 fails the "no numeric literal in main.mjs" rule on qwen every time (12 Oct, F, G-cheap twice): the brief gives no constants for text layout, so qwen invents numbers; Opus derives them (`BIRD_H * 2`). Every qwen attempt on t6 is 23 s of wasted bottleneck time. The knapsack must use expected attempts from calibration, not just length: with attempts = 2, t6's expected qwen time (50 s) is double Opus's (27 s) and the rule picks it on time. The real fix is upstream: a test that demands what the contract does not provide is a planner defect; the brief should carry the text-layout constants.

**The 3/5 : 2/5 share.** Opus's load in G is fixed per milestone: one tail ticket (~10.7k) and one review (~8.6k) ≈ 19k, whatever the project size. qwen's load grows with the leaf tickets (~3.5k each). Projection at the measured sizes: 6 tickets → 52% Opus (this run); 10 tickets → ~37%; 15 tickets (KareSathi M1 size) → ~27%; 25 tickets → ~18%. Flappy Bird is the worst case for the ratio because it is tiny. On any real milestone G meets 3/5 : 2/5 with room, at ~45 s plus about 3 s per extra leaf ticket (4 lanes).

**Timeline of the 42.5 s run:** t1–t4 on qwen from 0 s (done 9–16 s), t5 at 9 s (done 16 s), Opus t6 from 0 s with t1's test in its prompt (done 30.5 s, 11/11), regression 31/31 at 31 s, review 11 s. Critical path = Opus writing t6. The next cut is splitting t6 into two tickets (machine.mjs, main.mjs) so two Opus calls run side by side: ~16 s write, ~30 s wall — a planner change, not a harness change.

Script: option-g.mjs. Raw: flappy-bird/.is-worker/option-G6.json (Opus tail, before the fixes).
### G after the critic's fixes (21 Oct, late)

Fixes: (1) a ticket starts at t=0 only when every 'reads' file is contract-covered (exists already, or its module is in the brief's Interfaces section); otherwise it waits for its deps; (2) each ticket's tests run in a snapshot of harness-owned files + its deps' and co-writers' committed files + its own, never a half-committed sibling; the full tree runs once at the end; (3) the knapsack reads calibration state (tokens per ticket, speed, ttft) and last run's attempts, does not stop at a rejected ticket, and takes a known-bad qwen ticket (≥ 2 attempts last run) even past the share cap; the review shards into parallel calls past 10k prompt tokens and treats an unparsable answer as an error.

Run with no flags (the rule chose Opus for t6 by itself: "qwen needed 2 attempts last run"): **46.2 s wall**, 31/31 first try, 4 findings (reseed not present in this Opus-written machine.mjs), qwen 17,443 tokens ₹0.74, Opus 19,581 tokens $0.158 (52% of Opus-alone), Opus share 53%. Time is unchanged within Opus's own variance (t6 31.8 s vs 30.5 s before the fixes; review 13.5 s vs 11.2 s). Raw: flappy-bird/.is-worker/option-G.json.


## Files
- typed-review.mjs — A. typed-review-v2.mjs — D and E. checklist-planner.json — E's questions. opus.mjs — OpenRouter helper. full-review.mjs — B. opus-worker.mjs — C.
- Raw results in flappy-bird/.is-worker/: typed-review.json (A), typed-review-D.json, typed-review-E.json, full-review-B.json, opus-worker-C.json. B's REVIEW.md: ~/eval-isolated/review-2026-10-21-6.
