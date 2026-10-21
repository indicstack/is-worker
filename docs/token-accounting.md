# How is-worker counts tokens

`is-worker.mjs table` prints tokens, not rupees, in three columns.

| Column | What it is | Where the numbers come from |
|---|---|---|
| Worker | the IndicStack model (qwen) writing tickets | the `usage` block of every worker API call, `runs/*/calls.jsonl`, summed over every run of the milestone (same frozen brief) |
| Frontier with is-worker | Claude (or whichever model plans) while using is-worker, plus the reviewer | the planner's Claude Code transcript, from the `/is-worker` command to the table, subagents included, plus the review call's reported usage |
| Frontier alone | the same model building the same request with no harness | a measured build in `alone-baselines.json` (recorded with `is-worker.mjs baseline`); if this app has none, an estimate (below) |

## Rows
- **New input tokens**: input + cache writes. Text the model reads for the first time.
- **Cache-read tokens**: the same context read again on every turn. An agent that takes 13 turns over a 70k-token context reads about 900k tokens this way. These are real tokens, shown on their own row because they are much cheaper than new input.
- **Output tokens**: what the model wrote.

## Why output is counted from text
Claude Code writes each reply's `usage` block when the reply *starts*, so its `output_tokens` is only the first few tokens. The input numbers in that block are exact; the output is not. The table takes the reply's visible text (text plus tool-call arguments), sends it once to the same model's tokenizer through OpenRouter as the input of a 1-token call, and uses the reported count. With no OpenRouter key it falls back to characters ÷ 2.5 and says so. Hidden thinking is not in any transcript, so it is left out of every frontier column. That keeps the comparison fair: neither side counts thinking.

## Estimate when there is no measured baseline
Frontier-alone tokens = (tokens per KB of finished code, pooled over the measured baselines for that model) × this app's KB. The note under the table lists each baseline's rate and the resulting range. Add baselines to make it tighter: one build gives a point, not a law.

## Known biases (all listed in the table notes)
- A baseline built by a subagent starts with a smaller context than a main session (41k vs 63k tokens on 21 Oct), so it understates frontier-alone tokens a little.
- Apps differ in size: the harness app may carry tests the alone build skipped. The note prints both apps' KB.

## Explaining it to a non-engineer
"Qwen typed the code. We counted every word Claude read and wrote while planning and checking. Then we had Claude build the same thing alone and counted again. The difference is what is-worker saved, or cost."
