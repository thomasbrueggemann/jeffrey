# Benchmark results

Jeffrey vs. OpenCode on the same local model, five tasks, scored by hidden tests. Method and caveats:
[README.md](README.md).

## Setup

Qwen3.6-35B-A3B-oQ4-mtp on oMLX (Apple silicon), 32k max output. OpenCode 1.18.15 with defaults.
Jeffrey with `quickExtraBody` set, so the executor thinks only on the steps the decision model says
need it. Measured 2026-09-20: Jeffrey is the mean of two runs per task, OpenCode one run per task.

## Totals

| agent | wall time | local LLM tokens | uncached | completion | checks passed |
|---|---:|---:|---:|---:|---:|
| **Jeffrey** | **8m 14s** | **159,064** | **116,055** | **28,666** | **43/47** |
| OpenCode | 17m 30s | 1,196,676 | 197,530 | 44,259 | 44/47 |

Three token columns, because they answer different questions. Total is what the model server
processed. Uncached is what a provider with prompt caching bills at the full input price: OpenCode's
conversation grows by appending, so 86.7% of its prompt comes from the cache, while Jeffrey's
per-step briefs reuse a fixed head and little else. Completion tokens are what no cache helps with,
and they set most of the wall time.

Jeffrey also used 211k tokens on Jev, the remote decision model, per suite. Jev is a separate API and
is not counted in local tokens.

## Per task

| task | kind | agent | wall time | LLM requests | local tokens | uncached | checks |
|---|---|---|---:|---:|---:|---:|---:|
| pomodoro | greenfield web app | Jeffrey | 1m 47s | 15 | 47,796 | 28,340 | 22/22 |
| | | OpenCode | 1m 11s | 4 | 32,473 | 32,473 | 11/11 |
| pricing-bugfix | bug fix to documented rules | Jeffrey | 0m 32s | 5 | 12,787 | 10,739 | 17/18 |
| | | OpenCode | 0m 46s | 7 | 61,638 | 8,202 | 7/9 |
| todo-due-dates | feature across module + CLI | Jeffrey | 2m 29s | 11 | 37,304 | 31,160 | 17/18 |
| | | OpenCode | 5m 24s | 23 | 406,479 | 65,927 | 9/9 |
| notes-api | HTTP route + validation | Jeffrey | 2m 14s | 9 | 35,273 | 27,081 | 14/20 |
| | | OpenCode | 6m 06s | 27 | 525,839 | 62,303 | 9/10 |
| expense-report | feature + bug fix, Python | Jeffrey | 1m 13s | 10 | 25,904 | 18,736 | 16/16 |
| | | OpenCode | 4m 03s | 14 | 170,247 | 28,625 | 8/8 |

Jeffrey's checks are out of two runs, OpenCode's out of one. OpenCode's uncached column is derived
from the cache hits its own run database records.

Checks missed. Jeffrey: notes-api's validation cases, in both runs, and one run of each of
pricing-bugfix and todo-due-dates. OpenCode: notes-api's whitespace-only title, and pricing-bugfix's
rule that a discount never makes an amount negative.

## Takeaways

- Fewer requests, not just shorter ones. Jeffrey makes 5 to 15 local calls per task against
  OpenCode's 4 to 27. A read, a search or a command whose arguments the decision model settled runs
  with no local call at all, and only a change or a failed command is read back by a model.
- Raw token totals flatter Jeffrey. The gap is 7.5x on totals, 1.7x on uncached tokens and 1.5x on
  completion tokens. On a caching provider the last two are the bill.
- Time is where the difference is clearest: 8m 14s against 17m 30s, on the same model and machine.
- Deciding costs less than writing. The decision model settles which file a step works on, which
  line proves an acceptance criterion, which imported files the call has to see, and whether the step
  needs the executor to think at all. Each of those removes local tokens.
- notes-api is the weak task, and the noisy one. Across builds it lands between 5 and 9 of 10, on
  whether the first edit gets the route right; nothing else in the suite swings that far.

## Reproduce

```bash
node bench/compare.mjs --verify
node bench/compare.mjs --runs 2
```

Two runs per task still has sampling variance. For decisions, use more and compare ranges.
