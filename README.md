# jeffrey

A coding-agent CLI that splits the work between two models:

- A **decision model** decides. It never writes prose or code; it only answers closed questions. On
  every step it picks the next tool, scores how much progress was made, estimates risk, and says
  whether the goal is reached. Jev ([TypeSafe System One](https://docs.typesafe.ai/introduction))
  is the default; [Laya](https://github.com/NandhaKishorM/laya), which you host yourself, is the
  other one shipped — see [docs/deciders.md](docs/deciders.md).
- Your LLM (any OpenAI-compatible server, local by default) executes. It fills in the tool
  arguments, which is where the actual code comes from, for whatever tool the decider chose.

The loop is `decide → tool → decide → tool → …` until the goal is scored as reached, or escalates.

```
            goal
             │
             ▼
   ┌───────────────────┐   questions: which tool? which file? scores
   │ Decider (Jev/Laya)│◀──────────────────────────────────────────┐
   └─────────┬─────────┘                                          │
             │ tool + confidence + risk + progress                │
             ▼                                                    │
   ┌───────────────────┐  "call read_file, here are the args"      │
   │  Executor LLM     │───────────────────────────────────────────┤
   └─────────┬─────────┘                                          │
             ▼                                                    │
   ┌───────────────────┐   observation (stdout / diff / file list) │
   │  Tool runtime     │───────────────────────────────────────────┘
   └───────────────────┘
```

## Install

```bash
npm install -g @thomasbrueggemann/jeffrey
jeffrey --help
```

Or without installing anything:

```bash
npx @thomasbrueggemann/jeffrey --help
```

Requires Node >= 22 (Ink 7).

To work on it instead of just running it:

```bash
git clone https://github.com/thomasbrueggemann/jeffrey.git
cd jeffrey
npm install
npm run build
node bin/jeffrey.js --help      # or: npm link && jeffrey --help
```

## Configure

Point it at your local model and give it a decision model:

```bash
jeffrey --init                     # writes ~/.jeffrey/config.json
```

```jsonc
{
  "llm": {
    "baseUrl": "http://localhost:11434/v1",  // Ollama, llama.cpp, LM Studio, vLLM, …
    "apiKey": "not-needed",                  // sentinel is fine for local servers
    "model": "Qwen3.6-35B-A3B-oQ4-mtp",
    "temperature": 0.1,
    "maxTokens": 4096,                       // per executor reply; a cut-off reply retries with double, up to 65536
    "noteMaxTokens": 4096,                   // the short per-step note and the criteria
    "extraBody": {},                         // merged into every request body
    "quickExtraBody": {},                    // merged into notes, criteria and executor retries
    "thinkingAllowance": 2048,               // with quickExtraBody: a thinking attempt's room
    "executorThinking": "jev"                // when the executor thinks: always | after-failure | jev
  },
  "decider": {
    "provider": "typesafe",                  // typesafe (Jev) | laya (self-hosted) | mock
    "url": "https://api.typesafe.ai/v1/systemone",
    "apiKey": "",                            // or export TYPESAFE_API_KEY; laya needs none
    "model": "jev-latest"
  },
  "agent": { "maxSteps": 24, "maxRecoveries": 3, "autoApprove": false }
}
```

Config is layered, later wins:

`defaults` → `~/.jeffrey/config.json` → `./jeffrey.config.json` → environment → CLI flags.

Environment variables: `JEFFREY_LLM_BASE_URL`, `JEFFREY_LLM_API_KEY`, `JEFFREY_LLM_MODEL`,
`JEFFREY_DECIDER`, `JEFFREY_DECIDER_URL`, `JEFFREY_DECIDER_MODEL`, `TYPESAFE_API_KEY` (or
`JEFFREY_JEV_API_KEY`), `JEFFREY_MAX_STEPS`, `JEFFREY_MAX_RECOVERIES`, `JEFFREY_AUTO_APPROVE`.

The `decider` section used to be called `jev`, and that name is still read. Switching provider is
one flag — each brings its own endpoint and model name — and the self-hosted one is set up below.

A thinking model (Qwen3) thinks before every answer, and the thinking counts against `maxTokens`.
Give the executor room (`"maxTokens": 32768` is fine for a local model), and switch thinking off
where it only costs time: the three-sentence note, the criteria, and executor retries (a rejected
call is fixed mechanically; a cut-off reply is retried without thinking before its budget is doubled).
With the setting below, thinking is off unless the step needs it:

```jsonc
"quickExtraBody": { "chat_template_kwargs": { "enable_thinking": false } }
```

Who decides, per `executorThinking`: `jev` asks the decision model whether this step takes careful
reasoning, `after-failure` thinks only when the last step failed, `always` thinks on every first
attempt. In every mode a rejected call is retried with thinking, and a call that only fills in a
path, a pattern or a command never thinks. A thinking attempt gets `thinkingAllowance` tokens on top
of an estimate of its answer, not the whole `maxTokens`, so a runaway is cut off in seconds rather
than minutes; cut off, it is retried without thinking.

Edits and writes to `.js`/`.mjs`/`.cjs`/`.json` files are parse-checked before they touch the disk.

The workspace is always the folder `jeffrey` starts in (or `--cwd`); a global config cannot pin it.

Before finishing, Jeffrey runs the project's tests (and, unattended, once before the first step). The
command is detected (npm/pnpm/yarn/bun, cargo, go, pytest/unittest, maven, gradle, dotnet, mix, rspec,
`make test`), set with `"agent": { "testCommand": "…" }`, or turned off with `false`. Detection,
parse checks and import lookup are tables in [src/core/languages.ts](src/core/languages.ts); a language
that is not in them gets no guesses, only the language-neutral agent.

### Running Laya, the self-hosted decider

Jev is a hosted API and needs a key. [Laya](https://github.com/NandhaKishorM/laya) is Apache 2.0
and runs on your machine: same three question types, same response shape, no key and no network.
It ships as a Python package with no server, so this repo carries one —
[sidecar/laya-server.py](sidecar/laya-server.py), standard library only, exposing the single
endpoint jeffrey speaks.

```bash
# terminal 1 — the decider. First run downloads the checkpoint (~1 GB), later runs start in seconds.
uv run --python 3.12 --with laya --with torch sidecar/laya-server.py --preload typed-decisions
```

It prints its endpoint when it is up, and you can check it:

```bash
curl http://127.0.0.1:8137/healthz     # {"ok": true, "laya": "0.3.4", "loaded": ["typed-decisions"]}
```

```bash
# terminal 2 — the agent, routed by Laya instead of Jev
jeffrey --decider laya "fix the failing test in src/parse.py"
```

Use `--python 3.12` unless your default Python has PyTorch wheels; with `laya` and `torch` already
installed, `python3 sidecar/laya-server.py --preload typed-decisions` is the same thing. Stop the
server with ctrl-c, or `pkill -f laya-server.py`.

`--preload` matters: without it a cold checkpoint build costs seconds on the first request of each
language, and the default keeps only one model resident.

| Server flag | Meaning |
| --- | --- |
| `--port <n>` | Default 8137. Match it in `decider.url` or `--jev-url`. |
| `--preload [names…]` | Build checkpoints at startup: all of them, or the ones named |
| `--default-model <name>` | Checkpoint for English states: `english`, `multilingual`, `typed-decisions` (default) |
| `--device <cpu\|cuda\|mps>` | Laya picks one otherwise |
| `--max-len <n>`, `--head-max-len <n>` | Tokens per question, and the share its options get |
| `--api-key <key>` | Require a bearer token, for a server on a shared host |

To make it the default, put it in the config instead of passing the flag:

```jsonc
"decider": { "provider": "laya", "model": "router" }
```

What Laya trades against Jev — a 512–1024 token context against jeffrey's larger state, a
different confidence scale — and how to add a third provider:
[docs/deciders.md](docs/deciders.md).

To see what the layering resolved to:

```bash
jeffrey --show-config     # effective config, secrets redacted
jeffrey --list-models     # models the chosen decider offers
```

## Use

```bash
jeffrey "add retry with backoff to the http client"     # TUI, runs immediately
jeffrey                                                 # TUI, type the goal
jeffrey --print "fix the failing test"                  # headless transcript
cat task.txt | jeffrey --json                           # one JSON event per line
```

The TUI works like Claude Code or opencode: frozen step history that scrolls, a live step with
Jev's confidence and score meters, inline diffs, a status bar, `esc` to abort a run, and a prompt
that stays open for the next goal.

| Key | Does |
| --- | --- |
| `enter` | Run the goal you typed |
| `/exit` | Leave (also `/quit`, `/q`) |
| `ctrl-c` | Leave, or abort the running step if one is in flight |
| `esc` | Abort the running step |

Mutating tools pause for approval when Jev's risk score is >= 0.5:

```
  ⚠ approve write_file?  risk 2.4/4 · reversible but touches several files
  y = allow once · a = always allow this tool · n = deny
```

Use `-y/--yes` to auto-approve, or `--dry-run` to deny every mutating tool and see the plan only.

### Tools

`read_file`, `write_file`, `edit_file`, `multi_edit`, `list_dir`, `glob`, `grep`, `run_shell`.

Jev chooses among them. It can also answer `done` (goal reached), `ask_user`, or decline the
shortlist entirely so the executor proposes the argument itself, which is how new files get
created.

## When it gets stuck

Jev reports `stuck` as a probability, and the agent treats it as a signal to change strategy rather
than a reason to stop. When `stuck` crosses the escalation bar the loop improvises:

1. Diagnose. The repeated tool calls, Jev's re-selections and its own `progress` / `goal_reached`
   scores are folded into one sentence: "Jev reported a loop (stuck p=0.91) after 4 steps: read_file
   ran 4 of the last 4, and it keeps choosing write_file instead of acting on it, while the goal score
   stayed at 4% (progress 1.8/4)." The sentence is kept short because it is rendered inside the TUI's
   notice box and again in the final block, and a diagnosis clipped mid-sentence is useless.
2. Ask what the loop is. A loop is usually a wrong approach rather than a wrong tool, so the agent
   asks Jev one more closed-set question — which of these causes explains it? The options are in
   `src/core/recovery.ts`, each one a statement about the state rather than advice:

   | Cause Jev picks | What the agent then tries |
   | --- | --- |
   | Nothing has actually been executed | `run_shell` — run the tests or the build and read the real output |
   | The code that has to change has not been found | `grep`, `glob`, `list_dir` — search the workspace instead of reopening what is open |
   | Enough has been read; the change was never written | `write_file`, `edit_file` — produce the deliverable |
   | The change is too big to land in one step | `edit_file`, `write_file` — do the smallest part that stands on its own |
   | The loop is a missing fact only you have | hand it to you, now rather than after two more rungs |

   The question rides on the state the routing call just sent, unchanged, so the server's block
   cache serves most of it; the extra call costs one round trip and close to nothing in tokens.
3. Restrict the choice set to that approach. The tactic's tools are the *only* ones on the next
   decision, in the list Jev is offered and in the state description alike — asking politely does
   not survive a confident model. The restriction lasts exactly one decision, and it overrides the
   standing exclusions: a different approach may need a tool an earlier rung gave up on.

   A tactic is spent once per run. The next recovery chooses between the causes that are left, so a
   loop that survives one approach gets a different one, never a louder version of the same.
4. Escalate steering. The tactic's instruction goes into the state as a fact. From the second round
   the state also carries the verbatim outcomes so far, and from the third it restates the goal and
   asks for the actual deliverable.
5. Re-ask. Jev decides again, with history intact.

If Jev has no reading of the loop — an unsure answer, or every cause already tried — the ladder
falls back to the subtractive version: withhold the moves that are not working and say so. That
proposes nothing, but it keeps the run moving. Re-selecting a tool is itself a signal there: a tool
Jev keeps choosing but never gets to run leaves no trace in the step history, so it is tracked
separately and withheld too; otherwise each round would withhold the same name and the ladder would
not move.

A re-ask costs Jev calls and zero steps; recoveries never consume the step budget. The ladder
escalates on each attempt and is bounded by `--max-recoveries` (default 3,
`JEFFREY_MAX_RECOVERIES`).

If the ladder is exhausted and Jev still cannot make progress, jeffrey stops improvising and hands
back to you: the approval box names what was tried and why it stalled, states the question on its
own line ("What should I do differently?"), and the run ends with the `needs-input` outcome
(`◐ needs your input`, in amber, a pause rather than a failure) and exit code 1. A question Jev asks
explicitly via `ask_user` ends the same way, so "needs a human" never looks like "crashed".

### Answering a question

When Jev asks, the approval box switches to a question prompt: the argument preview is hidden, the
title reads "the agent is asking you a question", and a text field replaces the status bar.

- Type your answer and press enter. It is handed back to Jev as steering: quoted in the next
  state, recorded in the run notes, and re-decided immediately. The answer steers the step it was
  given for, so it is applied after the recovery plan rather than being overwritten by it.
- Press enter on an empty field, or `esc`, to decline. The run ends with `needs-input` instead
  of guessing on your behalf.

In headless mode (`--print`, or any non-TTY stdout) there is nobody to type, so the question is
surfaced as a `notice` event and the run continues on a "you were asked and told it to continue"
note rather than a fabricated answer. Headless messages go through the event stream, not raw stdout,
so `--json` stays line-by-line parseable.

Related hardening: `done`, `ask_user` and `completed` are routed before the tool registry is
consulted. They are pseudo-options rather than tools, so they can never be mistaken for an unknown
tool name; a genuinely hallucinated tool name is corrected by substituting the
runner-up in Jev's own answer, and the state says so on the next pass.

## Offline mode

Both models can be mocked, so the whole loop is testable without a key or a GPU:

```bash
npm test                                           # regression suite (offline, no key)
npm run selftest                                   # end-to-end run in a temp workspace
jeffrey --jev-mock --llm-mock --print --yes "add a farewell helper"
```

- `--jev-mock` replaces System One with a deterministic scripted decider. Optional tool list:
  `--jev-mock=read_file,edit_file,run_shell`.
- `--jev-mock-script <json>` drives the same mock through a scenario, which is how the recovery
  ladder is regression-tested offline:

  ```bash
  jeffrey --print --llm-mock --jev-mock-script '{"tools":["read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file","read_file"],"stuck":0.91,"stuckFromStep":4}' "check whether src exists and report back"
  ```

  It loops on `read_file` for four steps, then escalates: each round is restricted to a different
  approach (`run_shell`, then the search tools, then the writing ones), and when those are spent it
  hands the loop to you. Add `"loopCauseConfidence":0.1` to see the subtractive fallback instead.

  Knobs: `tools` (one tool per routing call, in order), `confidence`, `stuck`, `stuckFromStep`,
  `stuckUntilCall` (stop reporting `stuck` from this call on, so the agent can be seen breaking out
  of a loop rather than only handing off), `loopCauses` (the causes to read, one per recovery — by
  default the first one still on offer), `loopCauseConfidence` (drop it below 0.35 to exercise the
  subtractive fallback), `needsUser`, `finalGoalReached`, `hallucinations` (map of routing call →
  bogus tool name) and `hallucinateFallback`.

- `--llm-mock` replaces the executor with one that emits a valid call for whatever tool Jev chose,
  synthesising arguments from the tool schema and passing Jev's settled arguments straight through.
  It tests the plumbing only and says nothing about reasoning quality.

`--cwd` must already exist; the CLI refuses to run rather than create it for you.

## Flags

| Flag | Meaning |
| --- | --- |
| `--base-url`, `--api-key`, `--model`, `--temperature`, `--max-tokens` | Executor LLM |
| `--tool-mode forced\|prompt` | Native tool calls (default) or a JSON-argument fallback |
| `--no-narrate` | Skip the executor's one-line report after each tool |
| `--decider <provider>` | Which decision model routes: `typesafe`, `laya`, `mock` |
| `--jev-url`, `--jev-key`, `--jev-model` | Endpoint, key and model for that provider |
| `-C, --cwd <dir>` | Workspace root (default: cwd) |
| `--config <path>` | Explicit config file (replaces the default lookup) |
| `--max-steps <n>` | Step ceiling, default 24 |
| `--max-recoveries <n>` | Loop recoveries before handing back to you, default 3 |
| `-y, --yes` / `--dry-run` | Auto-approve / deny mutating tools |
| `--explain` | Show probability legends and full Jev reasoning |
| `--print` / `--json` | Headless transcript / JSON event stream |
| `--init`, `--show-config`, `--list-models` | Setup and inspection |

## How a step is decided

Each step is one Jev request. The questions are answered independently and in parallel, so asking
more of them costs little; asking them in a second request would cost the whole state again:

| Question id | Type | Purpose |
| --- | --- | --- |
| `next_action` | choice | Which tool to run next (or `done` / `ask_user`). Its runner-up is the fallback |
| `goal_reached` | noul | Is the goal satisfied? |
| `criterion.<n>` | noul | Is acceptance criterion *n* met, on the evidence so far? Skipped once proven |
| `proof.<n>` | choice | Which line the last step wrote shows criterion *n* holds |
| `progress` | score | 0 to 4: how much has actually been established |
| `stuck` | noul | The agent is looping; escalate |
| `step_intent` | choice | What the next action is for: locate, inspect, change, verify, repair |
| `target_path`, `target_command` | choice | The file or command the next action works on |
| `needs_thinking` | noul | Does this step take careful reasoning? (`executorThinking: "jev"`) |
| `risk` | score | 0 to 4: how hard is this to reverse. Only when approvals are on |

One question is asked on its own, because it only means anything once the answers above are in:
`loop_cause` (choice) — which of the untried causes explains the loop, after `stuck` has fired. It
re-sends the state the routing call just sent, so the server's cache carries most of it.

When Jev settles every argument a call needs, the call runs without asking the executor at all: a
`read_file` of a file Jev picked, or the project's test command.

`Agent.run()` converts those into one of six routes (`goal-reached`, `jev-finish`, `act`,
`act-low-confidence`, `ask-user`, `stuck-escalation`), and only `act` reaches tool execution.
`stuck-escalation` feeds the recovery ladder described above rather than ending the run.

### Keeping track of the trajectory

Neither model remembers anything between calls, and both only see the last few steps. So the agent
keeps a ledger ([src/core/ledger.ts](src/core/ledger.ts)) and passes it to Jev's state and the
executor's brief on every step:

- Acceptance criteria. Before the first step the executor turns the goal into 2 to 4 checkable
  criteria. Jev scores each one every step. `goal-reached` needs all of them met (at or above
  `agent.criterionMetThreshold`, default 0.6) as well as `goal_reached` and `progress`. Jev choosing
  `done` is still final. The first open criterion is shown as the `focus`.
- Files changed, commands run, failed attempts. Built from the history by code; no model is
  involved. A command's result is flagged once files have changed since it ran, and a repeated
  failure is counted.
- Facts. The reporter can end its note with up to two `FACT:` lines. They are kept for the rest
  of the run and flagged when their file changes afterwards.
- Evidence. A criterion is proven by a line in a file. Three things can claim one: the change
  itself (a `criteria_met` argument the executor may fill in), the note after the change (a
  `MET <id>: <quote>` line), and Jev, which is asked on the next step which of the lines just written
  shows the criterion holds. Every claim is checked the same way: the quote has to be in the file
  (whitespace-insensitive; `...` elisions must match in order) and, when the criterion names files, it
  has to be one of them. A proven criterion stays met whatever Jev scores, and is re-checked every
  step. When all are proven, the run ends as `goal-reached` without asking Jev again.

A `write_file` reply may carry several calls (one per new file). They are written in the same step,
so a small app is usually one executor call.

### What costs a model call

A read, a search or a command Jev has fully specified costs no executor call, and only a failed
command is read back by a model. A change costs one executor call and one short note, and that note
sees the diff rather than the file. What an edit changed is in the history as a compact diff, so the
next step and Jev can both see it without re-reading the file.

### Benchmark

[bench/](bench) runs a suite of tasks (a greenfield app, a bug fix, two features in existing projects)
through Jeffrey and through [OpenCode](https://opencode.ai) on the same local model, and scores each run
with hidden tests the agents never see. Tokens are metered at the model server, so both are counted the
same way, thinking included.

```bash
node bench/compare.mjs --verify              # the tasks' hidden tests fail on the seed, pass on the reference
node bench/compare.mjs --runs 2              # every task, both agents
```

Method, metrics and caveats: [bench/README.md](bench/README.md). Results:
[bench/RESULTS.md](bench/RESULTS.md).

## Layout

```
src/cli.tsx          arg parsing, config layering, headless printer, Ink bootstrap
src/config.ts        config schema, defaults, file + env loading, redaction
src/types.ts         decision primitives, decisions, events, budget
src/core/decision.ts the decision-model interface: noul / choice / score questions
src/core/deciders/*  the providers: typesafe (Jev), laya (self-hosted), mock
src/core/decider.ts  question composition and answer interpretation
src/core/ledger.ts   the trajectory: criteria, changes, verifications, failures, facts
src/core/agent.ts    the loop: gate, plan arguments, approve, execute, narrate
src/core/tools.ts    tool registry, schemas, execution, diffs
src/core/llm.ts      OpenAI-compatible streaming client + offline mock
src/ui/*             Ink components, view reducer, theme
```
