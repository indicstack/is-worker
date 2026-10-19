# Read log (19 Oct 2026)

Abstract pages / docs opened with a fetch tool. Only abstracts were read, not full papers. Anything marked NOT VERIFIED was not opened.

## 1. Agent scaffolds / SWE-bench
- **SWE-agent** — arXiv:2405.15793 (May 2024) https://arxiv.org/abs/2405.15793
  - 12.5% pass@1 on SWE-bench; the agent-computer interface (edit, search, test tools) drives results.
  - Relevance: tool design matters more than model size; our ticket + test interface is our "ACI".
- **Agentless** — arXiv:2407.01489 (Jul 2024) https://arxiv.org/abs/2407.01489
  - Fixed 3-step pipeline (locate, repair, validate with tests), no free-roaming agent: 32% on SWE-bench Lite at $0.70 per issue.
  - Relevance: supports is-worker's fixed pipeline. Cheap and simple can match agents.
- **OpenHands** — arXiv:2407.16741 (Jul 2024) https://arxiv.org/abs/2407.16741
  - Open platform, 15 benchmarks. The abstract has no Verified scores.
  - Relevance: low. Reference only.
- SWE-bench leaderboard https://www.swebench.com/ — page did not render scores. **Open-weight vs frontier numbers: NOT VERIFIED.**
- Moatless Tools: **NOT READ.**

## 2. Routing / cascades
- **FrugalGPT** — arXiv:2305.05176 (May 2023) https://arxiv.org/abs/2305.05176
  - Cascade: try cheap models first, stop when a scorer accepts. Matches GPT-4 at up to 98% lower cost.
  - Relevance: is-worker is a cascade (Qwen first, Claude only on failure). Tests are our scorer.
- **RouteLLM** — arXiv:2406.18665 (Jun 2024, v4 Feb 2025) https://arxiv.org/abs/2406.18665
  - Learned strong/weak router gives over 2x cost cut with no quality loss. Works when you swap the model pair.
  - Relevance: route at the job level (harness vs Opus-direct), not just the ticket level.
- **Hybrid LLM** — arXiv:2404.14618 (Apr 2024, ICLR) https://arxiv.org/abs/2404.14618
  - Difficulty-based router. Up to 40% fewer large-model calls at the same quality, with a quality knob you can set at run time.
  - Relevance: a size/difficulty gate before starting is-worker.
- **AutoMix** — arXiv:2310.12963 (Oct 2023) https://arxiv.org/abs/2310.12963
  - The small model checks its own answer and escalates only when unsure. Over 50% cost cut.
  - Relevance: escalate to the reviewer only on a signal (failures, retries), not every time.

## 3. Planner / executor splits
- **Aider architect/editor** (blog, 26 Sep 2024) https://aider.chat/2024/09/26/architect.html
  - A strong architect plus a cheap editor scored 85% (o1-preview + DeepSeek/o1-mini). Even a model paired with itself improved.
  - Relevance: direct evidence for the Opus-plans, Qwen-writes split.
- **Plan-and-Solve** — arXiv:2305.04091 (ACL 2023) https://arxiv.org/abs/2305.04091
  - Planning before solving beats zero-shot chain of thought.
  - Relevance: weak. Supports writing the brief first.

## 4. Tests instead of LLM review
- **CodeT** — arXiv:2207.10397 (Jul 2022) https://arxiv.org/abs/2207.10397
  - Generated tests plus agreement between candidates pick the right code. +18.8 points pass@1 on HumanEval.
  - Relevance: sample 2–3 Qwen answers and let the tests pick one. This is cheap on Qwen.
- **LEVER** — arXiv:2302.08468 (Feb 2023) https://arxiv.org/abs/2302.08468
  - A verifier that reads execution results gives +4.6 to 10.9%.
  - Relevance: run results are the verifier, so no frontier review is needed.
- **Self-Debugging** — arXiv:2304.05128 (Apr 2023) https://arxiv.org/abs/2304.05128
  - Feeding test failures back gives up to +12 points. Beats taking 10x more samples.
  - Relevance: put failing-test output in Qwen's retry before sending anything to Claude.

## 5. Prompt caching
- **Anthropic prompt caching docs** https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (read 19 Oct 2026)
  - 5-minute write costs 1.25x, 1-hour write 2x. Reads cost 0.05x on Opus 5.5 / Sonnet 5.5. Minimum cacheable prompt is 512 tokens on 5.x models.
  - Relevance: the Opus-alone Dino run was cheap mostly because 241k of its tokens were cache reads. The blind review's 113k tokens are paid fresh.

## 6. Latency / parallelism
- No paper read. **NOT VERIFIED.** Parallel ticket timings below are estimates from the harness's own numbers.
