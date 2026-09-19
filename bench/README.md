# Benchmark: Jeffrey vs. OpenCode on a local model

The benchmark compares two agents on the same local model: Jeffrey, which splits decisions (Jev)
from execution (a small local executor), and OpenCode, a conventional single-model coding agent.
Same model, same tasks, same machine, same scoring. Only the agent differs.

The latest results are in [RESULTS.md](RESULTS.md).

## Quick start

```bash
node bench/compare.mjs --verify                      # check the tasks themselves (no model calls)
node bench/compare.mjs --runs 2                      # every task, both agents, twice
node bench/compare.mjs --task notes-api --only jeffrey
node bench/compare.mjs --no-think                    # thinking off for both agents
```

Requirements: the local model server (oMLX, or anything OpenAI-compatible) on `127.0.0.1:8000`,
`~/.jeffrey/config.json` with a Jev key, `opencode` on the PATH, and a built Jeffrey (`npm run build`).
Each run prints one line as it finishes. The full report (`report.md`), raw data (`results.json`), per-run
logs, the token meter log and every run's working folder are kept under
`$TMPDIR/jeffrey-bench/<timestamp>/` for inspection.

| flag | default | meaning |
|---|---|---|
| `--task a,b` | all | tasks to run (folder names under `bench/tasks`) |
| `--runs N` | 1 | repetitions of every task × agent |
| `--only jeffrey\|opencode` | both | run one agent |
| `--no-think` | off | inject `chat_template_kwargs.enable_thinking=false` into every request, for both agents |
| `--timeout-min N` | 45 | per-run wall-clock limit; the process is killed and the run marked timed out |
| `--port N` | 8100 | port of the metering proxy |
| `--verify` | n/a | score each task's seed (must fail) and reference solution (must pass); no agents run |

## What is measured

| metric | how | why this way |
|---|---|---|
| Wall time | from spawning the agent to its exit | what a user waits for; includes every model call, tool and test run |
| Local LLM tokens | prompt + completion tokens as reported by the model server, per request | counted at the one place both agents share (see below), thinking included |
| Cached prompt tokens | `usage.prompt_tokens_details.cached_tokens`, per request | prompt the server served from its prefix cache: near-free in time, and what a hosted provider bills at a fraction of the input price. Uncached tokens are the honest cost comparison |
| LLM requests | chat-completion calls through the proxy | a proxy for round trips; each one pays prompt processing |
| Cut off | requests that ended with `finish_reason: length` | truncated output is wasted generation |
| Jev calls / tokens | from Jeffrey's session log (`~/.jeffrey/sessions`) | Jev is a remote API the proxy never sees; reported separately, never added to local tokens |
| Checks | task-specific scoring, below | correctness; speed and tokens mean nothing without it |

### Token metering

[proxy.mjs](proxy.mjs) sits between both agents and the model server. Each agent's base URL is
`http://127.0.0.1:<port>/t/<run-tag>/v1`, so every request is attributed to its run. The proxy:

- forwards requests unchanged, except that it forces `stream_options.include_usage` on streaming
  requests, so a client that does not ask for usage is still counted;
- records the server's own `usage` for every chat completion (prompt, completion, cached prompt tokens, finish reason, latency);
- cancels the upstream request when a client disconnects, so an aborted run does not keep the GPU busy;
- with `--no-think`, injects the same body field into every request of both agents.

Because counting happens at the server, neither agent's own accounting is trusted, and a thinking
model's hidden reasoning is included in completion tokens.

### Isolation and fairness

- Same model and limits. Both agents use the model named in `~/.jeffrey/config.json`, with the same
  maximum output (`llm.maxTokens`, mirrored into OpenCode's model `limit.output`).
- Fresh workspace per run. The task's seed is copied into a new folder under `$TMPDIR` and committed
  as a one-commit git repository, as a real project would arrive. Nothing is shared between runs.
- OpenCode gets a throwaway config home (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`), with
  one provider pointing at the proxy and permissions set to allow. The user's global config, MCP servers
  and rules (and `~/.claude` via `OPENCODE_DISABLE_CLAUDE_CODE`) would otherwise add tools and prompt
  tokens that Jeffrey does not have. It runs as `opencode run --auto --dir <run folder>`, with `PWD` set
  to match: OpenCode takes its project folder from `$PWD`, and without that it once wrote a whole app
  into the folder the benchmark was started from. The harness warns if any new file appears there.
- Jeffrey runs headless with `--print --yes` and its normal config, except the LLM base URL, which
  points at the proxy.
- Runs are sequential. The agents share one GPU; running them in parallel would measure contention.
- Neither agent sees the hidden tests. They live in `bench/tasks/<task>/hidden`, outside every run
  folder, and are copied in only after the agent has exited.

## Tasks

Each task is a folder under [tasks/](tasks):

```
task.md       the prompt, given verbatim to both agents
seed/         the project the agent starts in
hidden/       tests the agent never sees, run against its work afterwards
reference/    a known-good solution, overlaid on the seed by --verify
check.json    { runner?: "node" | "pytest", requireNewTests?, protectedFiles? }
check.mjs     optional custom scorer (the greenfield task)
```

| task | kind | what it takes | hidden tests |
|---|---|---|---|
| [pomodoro](tasks/pomodoro) | greenfield | a three-file web app from an empty folder | 11 static checks ([check.mjs](tasks/pomodoro/check.mjs)): files linked, JS parses, every element the script looks up exists, timer, mm:ss, inputs, localStorage |
| [pricing-bugfix](tasks/pricing-bugfix) | bug fix | a failing suite in a pricing module; fix the code to match its doc comments without touching the tests | 7, including a documented rule no visible test covers (a discount never makes an amount negative) |
| [todo-due-dates](tasks/todo-due-dates) | feature | due dates across a pure module and its CLI: strict date validation, overdue filter and sort, CLI flags and output format, plus new tests | 7, including the CLI run as a subprocess |
| [notes-api](tasks/notes-api) | feature + hardening | a `PATCH` route and 400-validation on a `node:http` JSON API whose seed answers bad JSON with a 500 | 8, against a live server on a random port |
| [expense-report](tasks/expense-report) | feature + bug fix, Python | a monthly summary across report module and CLI, and rejecting negative or over-precise amounts in the parser, plus new tests | 6 (pytest), including the CLI as a subprocess |

No task has dependencies to install: the Node tasks use `node:test`, the Python task the standard
library plus pytest. Nothing is downloaded mid-run, so nothing but the agents skews the timing.

Why a Python task. Jeffrey's language-specific helpers (test command detection, parse checks, import
context) live in tables in [src/core/languages.ts](../src/core/languages.ts), and everything else is
language-neutral. A suite of only JavaScript tasks could not tell a general improvement from one that
only works for JavaScript; the Python task is there to catch the second kind.

Tasks are verified before they are used. `--verify` runs each task's hidden tests against the bare
seed (must fail) and against seed + reference solution (must pass, along with the project's own tests).
A task whose seed already passes cannot tell agents apart; one whose reference fails is testing the
tests. Current state:

```
✔ expense-report: seed passes 1/6 hidden, reference 6/6
✔ notes-api: seed passes 1/8 hidden, reference 8/8
✔ pricing-bugfix: seed passes 3/7 hidden, reference 7/7
✔ todo-due-dates: seed passes 2/7 hidden, reference 7/7
```

## Scoring

For the seeded tasks ([tasks.mjs](tasks.mjs)), one run's checks are:

1. The project's own tests pass: `node --test` (or `pytest`, per the task's `runner`) over the whole
   project, including any tests the agent wrote. An agent that leaves its own tests failing loses this check.
2. New tests were added (feature tasks): more test cases (`test(`/`it(` calls, `def test_…`
   functions, `#[test]` attributes) than the seed had.
3. Protected files are unchanged (bug-fix task): the tests the task said not to edit.
4. One check per hidden test: each top-level `node:test` case in TAP output, or each pytest test
   in its `-rA` summary. Hidden tests import the functions they need inside the test where the task
   adds them, so a partial solution earns partial credit instead of failing the whole file at import.

A run's score is checks passed over checks available. Every check counts the same, so a feature with
8 hidden tests weighs more than one with 7. The report's headline sums checks per agent across all
tasks and runs, next to total time and tokens.

## Reading the numbers

- One run is an anecdote. Local generation is sampled, and one long reasoning burst can double a
  run's time. Compare with `--runs 2` or more, and look at the spread before the mean.
- Tokens and time do not move together. Prompt tokens are cheap on a local server with prefix
  caching; completion tokens cost wall time. An agent that resends a long conversation every turn
  can use many prompt tokens and still be quick; one that thinks at length is slow on few tokens.
- Total tokens overstate the gap. An agent whose conversation grows by appending gets most of its
  prompt from the cache: oMLX serves it in 2048-token blocks, and hosted providers bill cache reads
  at a fraction of the input price. The uncached column is the number to compare, and completion
  tokens, which no cache helps, are the number that sets wall time.
- Jev tokens are a different currency. They are billed by a remote API and do not touch the
  local GPU. Report them, but do not add them to local tokens.

## Threats to validity

- Small task set. Five tasks, four JavaScript and one Python, all small. They cover greenfield,
  bug-fix and feature work; they do not cover large codebases, compiled languages, or ambiguous specs.
- The harness author also tuned Jeffrey. Jeffrey's changes were driven by what these tasks
  revealed. The hidden tests are fixed and verified, but a set that also tunes the agent overfits
  over time. New tasks should be added before trusting further gains.
- One model, one machine. Qwen3.6-35B-A3B (4-bit, MLX) on Apple silicon. Both agents' relative
  cost depends on the model's thinking length and the server's prefix caching.
- Static checks for the greenfield task. Nothing runs the page in a browser; the checks prove
  structure and wiring, not behaviour.
- OpenCode is run with defaults. No prompt or agent tuning was attempted for it, which is how most
  people would run it, but not its best possible configuration.

## Adding a task

1. Create `bench/tasks/<name>/` with `task.md`, `seed/`, `hidden/`, and `reference/` (only the files
   that change). For Python, set `"runner": "pytest"` in `check.json` and `pythonpath = ["."]` in the
   seed's pytest config.
2. Hidden tests run from `<run>/.bench-hidden/`, next to the project's sources: Node tests import from
   `../src/...`, Python tests import the package by name.
3. Test only what `task.md` and the seed's docs specify; a hidden test for an unstated requirement
   measures luck.
4. `node bench/compare.mjs --verify` must show the seed failing and the reference passing.
