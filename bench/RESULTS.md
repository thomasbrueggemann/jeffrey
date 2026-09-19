# Benchmark results

Jeffrey vs. OpenCode on the same local model, five tasks, scored by hidden tests. Method and caveats:
[README.md](README.md).

## Setup

Qwen3.6-35B-A3B-oQ4-mtp on oMLX (Apple silicon), thinking on, 32k max output. OpenCode 1.18.15
with defaults. Jeffrey with `quickExtraBody` set (no thinking for notes, criteria and retries). One
run per task and agent, 2026-09-19. The pricing-bugfix Jeffrey row is from the latest build. The
other Jeffrey rows are from the build just before it, which differs only in when a run may stop
(sending a premature "done" back once).

## Totals

| agent | wall time | local LLM tokens | checks passed |
|---|---:|---:|---:|
| **Jeffrey** | **15m 16s** | **195,193** | **46/47** |
| OpenCode | 17m 30s | 1,196,676 | 44/47 |

Jeffrey also used 444k tokens on Jev, the remote decision model. Jev is a separate API and is not
counted in local tokens.

## Per task

| task | kind | agent | wall time | LLM requests | local tokens | checks |
|---|---|---|---:|---:|---:|---:|
| pomodoro | greenfield web app | Jeffrey | 0m 43s | 3 | 6,847 | 11/11 |
| | | OpenCode | 1m 11s | 4 | 32,473 | 11/11 |
| pricing-bugfix | bug fix to documented rules | Jeffrey | 1m 34s | 9 | 16,732 | 9/9 |
| | | OpenCode | 0m 46s | 7 | 61,638 | 7/9 |
| todo-due-dates | feature across module + CLI | Jeffrey | 5m 27s | 22 | 61,910 | 9/9 |
| | | OpenCode | 5m 24s | 23 | 406,479 | 9/9 |
| notes-api | HTTP route + validation | Jeffrey | 4m 16s | 23 | 63,994 | 9/10 |
| | | OpenCode | 6m 06s | 27 | 525,839 | 9/10 |
| expense-report | feature + bug fix, Python | Jeffrey | 3m 16s | 21 | 45,710 | 8/8 |
| | | OpenCode | 4m 03s | 14 | 170,247 | 8/8 |

Checks missed. Jeffrey: notes-api accepts a whitespace-only title. OpenCode: the same notes-api check,
and pricing-bugfix's rule that a discount never makes an amount negative (both of its checks).

## Takeaways

- 6× fewer local tokens, with the same or better correctness. OpenCode resends its whole
  conversation on every request: 14 to 17k prompt tokens each by the end of a feature task. Jeffrey
  gives the executor a fresh, bounded brief every step.
- Faster in total, though not on every task. Jeffrey was faster on three tasks and level on one
  (5m 27s vs 5m 24s). On the short bug fix, OpenCode's single conversation finished sooner.
- Only Jeffrey got the documented rule that no visible test covers. Its acceptance criteria are
  planned from the files the task names, and it finishes only when the criteria are proven in the files
  and the project's tests pass.
- Jev tokens are Jeffrey's largest remaining cost. About 444k across the suite, mostly because
  every step sends the full state to Jev twice.

## Reproduce

```bash
node bench/compare.mjs --verify
node bench/compare.mjs --runs 1
```

One run per task has sampling variance. For decisions, use `--runs 2` or more and compare ranges.
