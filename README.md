# jeffrey

A coding-agent CLI with **two models and a clear division of labour**:

- **Jev** ([TypeSafe System One](https://docs.typesafe.ai/introduction)) is the decider. It never
  writes prose or code — it only answers closed questions. Every step it picks the next tool,
  scores how much progress was made, estimates risk, and tells us whether the goal is reached.
- **Your LLM** (any OpenAI-compatible server, local by default) is the executor. It fills in the
  tool arguments — the actual code — for whatever tool Jev chose.

The loop is: `Jev → tool → Jev → tool → …` until Jev scores the goal as reached, or escalates.

```
            goal
             │
             ▼
   ┌───────────────────┐   questions: which tool? relevant? scores
   │   Jev (System One)│◀──────────────────────────────────────────┐
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
npm install
npm run build
node bin/jeffrey.js --help      # or: npm link && jeffrey --help
```

Requires Node >= 22 (Ink 7).

## Configure

Point it at your local model and give it a TypeSafe key:

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
    "maxTokens": 4096
  },
  "jev": {
    "url": "https://api.typesafe.ai/v1/systemone",
    "apiKey": "",                            // or export TYPESAFE_API_KEY
    "model": "jev-latest"
  },
  "agent": { "maxSteps": 24, "maxRecoveries": 3, "autoApprove": false }
}
```

Config is layered, later wins:

`defaults` → `~/.jeffrey/config.json` → `./jeffrey.config.json` → environment → CLI flags.

Environment variables: `JEFFREY_LLM_BASE_URL`, `JEFFREY_LLM_API_KEY`, `JEFFREY_LLM_MODEL`,
`TYPESAFE_API_KEY` (or `JEFFREY_JEV_API_KEY`), `JEFFREY_MAX_STEPS`, `JEFFREY_MAX_RECOVERIES`,
`JEFFREY_AUTO_APPROVE`.

Check what it actually resolved to before blaming the model:

```bash
jeffrey --show-config     # effective config, secrets redacted
jeffrey --list-models     # System One models available to your key
```

## Use

```bash
jeffrey "add retry with backoff to the http client"     # TUI, runs immediately
jeffrey                                                 # TUI, type the goal
jeffrey --print "fix the failing test"                  # headless transcript
cat task.txt | jeffrey --json                           # one JSON event per line
```

The TUI behaves like Claude Code / opencode: frozen step history that scrolls, a live step with
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

Jev chooses among them; it can also answer `done` (goal reached), `ask_user`, or decline the
shortlist entirely so the executor proposes the argument itself — which is how new files get
created.

## When it gets stuck

Jev reports `stuck` as a probability, and the agent treats it as a signal to change strategy — not
as a reason to die. When `stuck` crosses the escalation bar the loop **improvises**:

1. **Diagnose.** The repeated tool calls, Jev's re-selections and its own `progress` / `goal_reached`
   scores are folded into one sentence — "Jev reported a loop (stuck p=0.91) after 4 steps: read_file
   ran 4 of the last 4, and it keeps choosing write_file instead of acting on it, while the goal score
   stayed at 4% (progress 1.8/4)." It is deliberately compact: it is rendered inside the TUI's notice
   box and again in the final block, and a diagnosis that gets clipped mid-sentence is worthless.
2. **Withhold the tool.** The moves that are not working are removed from the shortlist, both from
   the list Jev is offered and from the state description, so a confident model cannot pick them
   again. Asking politely does not survive a confident model. Re-selecting a tool is itself a signal:
   a tool Jev keeps choosing but never gets to run leaves no trace in the step history, so it is
   tracked separately and withheld too — otherwise each round would withhold the same name and the
   ladder would not move.
3. **Escalate steering.** A directive is added to the state: avoid what already failed, try another
   tool, and make the next call different in kind. From the second round the state also carries the
   verbatim outcomes so far, and from the third it restates the goal and asks for the actual
   deliverable.
4. **Re-ask.** Jev decides again, with history intact.

A re-ask costs **2 Jev calls and zero steps** — recoveries never burn your step budget. The ladder
escalates on each attempt (each round withholds more, and the steering gets blunter) and is bounded
by `--max-recoveries` (default 3, `JEFFREY_MAX_RECOVERIES`).

If the ladder is exhausted and Jev still cannot make progress, jeffrey stops improvising and
**hands back to you**: the approval box names what was tried and why it stalled, states the question
on its own line ("What should I do differently?"), and the run ends with the `needs-input` outcome
(`◐ needs your input`, amber — a pause, not a failure) and exit code 1. A question Jev asks
explicitly via `ask_user` ends the same way, so "needs a human" never looks like "crashed".

### Answering a question

When Jev asks, the approval box switches to a question prompt: the argument preview is hidden, the
title reads "the agent is asking you a question", and a text field replaces the status bar.

- **Type your answer and press enter.** It is handed back to Jev as steering — quoted in the next
  state, recorded in the run notes, and re-decided immediately. The answer steers *the step it was
  given for*, so it is applied after the recovery plan rather than being overwritten by it.
- **Press enter on an empty field, or `esc`, to decline.** The run ends with `needs-input` instead
  of guessing on your behalf.

In headless mode (`--print`, or any non-TTY stdout) there is nobody to type, so the question is
surfaced as a `notice` event and the run continues on a "you were asked and told it to continue"
note rather than a fabricated answer. Headless messages go through the event stream, not raw stdout,
so `--json` stays line-by-line parseable.

Related hardening: `done`, `ask_user` and `completed` are routed **before** the tool registry is
consulted. They are pseudo-options, not tools, so they can never be mistaken for an unknown tool
name; a genuinely hallucinated tool name is corrected by substituting Jev's `fallback_action`
runner-up, and the state says so on the next pass.

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

  It loops on `read_file` for four steps, then escalates: each round withholds one more tool
  (`write_file`, then `edit_file`, `list_dir`, `glob`) and ends by handing the loop to you.

  Knobs: `tools` (one tool per routing call, in order), `confidence`, `stuck`, `stuckFromStep`,
  `stuckUntilCall` (stop reporting `stuck` from this call on, so the agent can be seen breaking out
  of a loop rather than only handing off), `needsUser`, `finalGoalReached`, `hallucinations` (map of
  routing call → bogus tool name) and `hallucinateFallback`.

- `--llm-mock` replaces the executor with one that emits a valid call for whatever tool Jev chose,
  synthesising arguments from the tool schema and passing Jev's settled arguments straight through.
  It is a plumbing check, not a reasoning check.

`--cwd` must already exist; the CLI refuses to run rather than create it for you.

## Flags

| Flag | Meaning |
| --- | --- |
| `--base-url`, `--api-key`, `--model`, `--temperature`, `--max-tokens` | Executor LLM |
| `--tool-mode forced\|prompt` | Native tool calls (default) or a JSON-argument fallback |
| `--no-narrate` | Skip the executor's one-line report after each tool |
| `--jev-url`, `--jev-key`, `--jev-model` | Decider |
| `-C, --cwd <dir>` | Workspace root (default: cwd) |
| `--config <path>` | Explicit config file (replaces the default lookup) |
| `--max-steps <n>` | Step ceiling, default 24 |
| `--max-recoveries <n>` | Loop recoveries before handing back to you, default 3 |
| `-y, --yes` / `--dry-run` | Auto-approve / deny mutating tools |
| `--explain` | Show probability legends and full Jev reasoning |
| `--print` / `--json` | Headless transcript / JSON event stream |
| `--init`, `--show-config`, `--list-models` | Setup and inspection |

## How a step is decided

Each step the decider asks Jev a batch of questions in one request:

| Question id | Type | Purpose |
| --- | --- | --- |
| `next_action` | choice | Which tool to run next (or `done` / `ask_user`) |
| `fallback_action` | choice | Second choice if the first turns out unusable |
| `relevant.<tool>` | noul | Probability each tool is relevant, used to keep the shortlist small |
| `goal_reached` | noul | Is the goal satisfied? |
| `criterion.<n>` | noul | Is acceptance criterion *n* met, on the evidence so far? |
| `progress` | score | 0–4: how much has actually been established |
| `stuck` | noul | The agent is looping; escalate |
| `needs_user` | noul | Requires human input; stop and ask |
| `risk` | score | 0–4: how hard is this to reverse |
| `<tool>.<arg>` | choice / noul | Which value for an argument with a closed set |

`Agent.run()` converts those into one of six routes — `goal-reached`, `jev-finish`, `act`,
`act-low-confidence`, `ask-user`, `stuck-escalation` — and only `act` reaches tool execution.
`stuck-escalation` feeds the recovery ladder described above rather than ending the run.

### Keeping track of the trajectory

Neither model remembers anything between calls, and both only see the last few steps. So the agent
keeps a **ledger** ([src/core/ledger.ts](src/core/ledger.ts)) and passes it to Jev's state and the
executor's brief on every step:

- **Acceptance criteria.** Before the first step the executor turns the goal into 2–5 checkable
  criteria. Jev scores each one every step. `goal-reached` needs all of them met (at or above
  `agent.criterionMetThreshold`, default 0.6) as well as `goal_reached` and `progress`. Jev choosing
  `done` is still final. The first open criterion is shown as the `focus`.
- **Files changed, commands run, failed attempts.** Built from the history by code, not by a model.
  A command's result is flagged once files have changed since it ran, and a repeated failure is counted.
- **Facts.** The reporter can end its note with up to two `FACT:` lines. They are kept for the rest
  of the run and flagged when their file changes afterwards.

## Layout

```
src/cli.tsx          arg parsing, config layering, headless printer, Ink bootstrap
src/config.ts        config schema, defaults, file + env loading, redaction
src/types.ts         Jev primitives, decisions, events, budget
src/core/jev.ts      System One client: noul / choice / score questions, retries
src/core/decider.ts  question composition and answer interpretation
src/core/ledger.ts   the trajectory: criteria, changes, verifications, failures, facts
src/core/agent.ts    the loop: gate, plan arguments, approve, execute, narrate
src/core/tools.ts    tool registry, schemas, execution, diffs
src/core/llm.ts      OpenAI-compatible streaming client + offline mock
src/core/mock-jev.ts offline scripted decider
src/ui/*             Ink components, view reducer, theme
```
