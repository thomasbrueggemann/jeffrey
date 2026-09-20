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

## Why the tokens stop here

Per suite the local model sees 49 requests: 2,661 prompt tokens each, of which 1,783 are not served
from the cache, and 585 completion tokens each. That shape sets the floor.

- The brief has to carry the file being changed. An edit cannot be written without the text it
  replaces, and that text is most of the prompt. Showing one file instead of two took a suite to
  108k uncached tokens, within 9% of half OpenCode's, and cost eight checks out of 94. The tokens
  that look like waste are what the executor needs to be right.
- The cache returns one block, not the whole prompt. The server serves 2048-token blocks of an
  identical prefix, and the stable head here is about 2,300 tokens: the system turn, the tool
  definitions, the goal, the criteria and the file list. Growing that head to catch a second block
  costs those tokens on every request that misses. Tried: prompt grew 93k and cached grew 104k over
  ten runs, for no change in what was billed.
- Completion tokens have no cache at all. They are 29k of the 116k, and they are the answer itself:
  the new content of an edit, the note after a change.
- What is left is steps. Cutting a step saves a whole request, which is why the decision model
  settling an argument, or a change carrying its own proof, moved more than any prompt trimming.

OpenCode's 197,530 uncached tokens come out of 1.2M sent, because an append-only conversation is
almost entirely cache. Jeffrey sends 159k and reuses little. Below roughly this point the two agents
are paying for the same thing: the code they have to read and the code they have to write.

## Why the checks stop here

The four checks missed per suite are not spread evenly. They sit on the validation cases of one
task, and that task swings between 5 and 9 of 10 across builds that differ in nothing that should
matter to it.

- The run is decided by the first edit. When the first attempt writes a handler that works, the run
  ends in three or four steps. When it writes one that throws, everything after is repair, and the
  repair has to work from a failing assertion rather than from the code that was wrong.
- The decision model cannot see the mistake. It routes from a state summary and never sees a file
  whole, by design. It can tell that tests failed; it cannot tell that a handler calls a method the
  module does not define.
- A proven criterion is a quote, not a behaviour. Criteria are proven by finding a line in a file.
  A handler that answers 500 still proves "the handler updates the note and responds 200" if the
  line is there. That is why a run can finish with every criterion met and hidden tests failing.

So the ceiling is the executor's first attempt at code, and nothing in the loop above it can lift
that ceiling, only notice afterwards that it was too low.

## What this benchmark does not test

Every run here has the same decision model in the loop, so these numbers say nothing about what it
contributes. The comparison is Jeffrey against another agent, never Jeffrey against itself with a
worse decision maker. Three runs would answer it, and none of them has been done:

1. Route with the local model instead. Same tools, same state, same executor; the local model
   answers "which action next" in place of the decision model. If the checks hold, the decision
   model is buying speed and tokens rather than correctness.
2. Route with a fixed policy. Read, change, test, repeat, with no model deciding anything. A suite
   this small may not need a router at all, and that would be worth knowing before tuning one.
3. Vary the decision model's quality deliberately, by degrading its state (shorter history, no
   ledger) and watching which checks fail first. That says which part of what it is told is doing
   the work.

Until one of those is run, "a better decision maker gives better results" is an assumption in this
repository, not a finding.

## Reproduce

```bash
node bench/compare.mjs --verify
node bench/compare.mjs --runs 2
```

Two runs per task still has sampling variance. For decisions, use more and compare ranges.
