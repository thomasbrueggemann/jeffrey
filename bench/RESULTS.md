# Benchmark results

Jeffrey vs. OpenCode on the same local model, five tasks, scored by hidden tests. Method and caveats:
[README.md](README.md).

## Setup

Qwen3.6-35B-A3B-oQ4-mtp on oMLX (Apple silicon), 32k max output. OpenCode 1.18.15 with defaults.
Jeffrey with `quickExtraBody` set, so it thinks only on the steps Jev says need it. Measured
2026-09-19. Jeffrey rows are the mean of two runs per task, except pomodoro and pricing-bugfix,
which are single runs from a build earlier the same evening; those two tasks were unaffected by the
later changes. OpenCode rows are one run per task.

## Totals

| agent | wall time | local LLM tokens | uncached | completion | checks passed |
|---|---:|---:|---:|---:|---:|
| **Jeffrey** | **10m 28s** | **135,689** | **130,569** | **37,847** | **44/47** |
| OpenCode | 17m 30s | 1,196,676 | 197,530 | 44,259 | 44/47 |

Three numbers, because they answer different questions. Total tokens is what the model server
processed. Uncached is what a provider with prompt caching would bill at the full input price:
OpenCode's conversation grows by appending, so 86.7% of its prompt came from the cache, while
Jeffrey's per-step briefs get almost no reuse. Completion tokens are what no cache helps with, and
they set most of the wall time.

Jeffrey also used 260k tokens on Jev, the remote decision model. Jev is a separate API and is not
counted in local tokens.

## Per task

| task | kind | agent | wall time | LLM requests | local tokens | Jev tokens | checks |
|---|---|---|---:|---:|---:|---:|---:|
| pomodoro | greenfield web app | Jeffrey | 0m 40s | 3 | 7,176 | 4,880 | 11/11 |
| | | OpenCode | 1m 11s | 4 | 32,473 | — | 11/11 |
| pricing-bugfix | bug fix to documented rules | Jeffrey | 0m 51s | 8 | 14,564 | 99,118 | 9/9 |
| | | OpenCode | 0m 46s | 7 | 61,638 | — | 7/9 |
| todo-due-dates | feature across module + CLI | Jeffrey | 3m 06s | 10 | 32,302 | 40,088 | 8/9 |
| | | OpenCode | 5m 24s | 23 | 406,479 | — | 9/9 |
| notes-api | HTTP route + validation | Jeffrey | 3m 32s | 17 | 49,162 | 71,345 | 8/10 |
| | | OpenCode | 6m 06s | 27 | 525,839 | — | 9/10 |
| expense-report | feature + bug fix, Python | Jeffrey | 2m 19s | 14 | 32,485 | 44,638 | 8/8 |
| | | OpenCode | 4m 03s | 14 | 170,247 | — | 8/8 |

Checks missed. Jeffrey: notes-api's whitespace-only title and one PATCH case; one todo-due-dates run
finished before writing tests, because its acceptance criteria did not name them. OpenCode:
notes-api's whitespace-only title, and pricing-bugfix's rule that a discount never makes an amount
negative (both of its checks).

## Takeaways

- Fewer requests, not just shorter ones. Jeffrey makes 3 to 17 local calls per task against
  OpenCode's 4 to 27. A read, a search or a command whose arguments the decision model has settled
  runs with no local call at all, and only a failed command is read back by a model.
- The token gap is mostly prompt, and prompt is what caching makes cheap. Raw totals differ by 8.8x,
  but on a caching provider the honest comparison is uncached tokens, where the gap is 1.5x, and
  completion tokens, where it is 1.2x. The time difference is real and is not explained by tokens.
- Deciding costs less than writing. Moving work to the decision model (which file a step works on,
  which line proves an acceptance criterion, whether a step needs careful reasoning, which imported
  files the call has to see) removes local calls and local prompt.
- Correctness is level overall, and different per task. Only Jeffrey fixed the documented pricing
  rule no visible test covers. OpenCode was steadier on the two feature tasks.
- notes-api is the noisy one. Across builds it lands between 8 and 9 of 10, on whether the first
  edit gets the handler right.

## Reproduce

```bash
node bench/compare.mjs --verify
node bench/compare.mjs --runs 2
```

Two runs per task still has sampling variance. For decisions, use more and compare ranges.
