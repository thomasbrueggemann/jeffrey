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
    "model": "qwen2.5-coder:7b",
    "temperature": 0.1,
    "maxTokens": 4096
  },
  "jev": {
    "url": "https://api.typesafe.ai/v1/systemone",
    "apiKey": "",                            // or export TYPESAFE_API_KEY
    "model": "jev-latest"
  },
  "agent": { "maxSteps": 24, "autoApprove": false }
}
```

Config is layered, later wins:

`defaults` → `~/.jeffrey/config.json` → `./jeffrey.config.json` → environment → CLI flags.

Environment variables: `JEFFREY_LLM_BASE_URL`, `JEFFREY_LLM_API_KEY`, `JEFFREY_LLM_MODEL`,
`TYPESAFE_API_KEY` (or `JEFFREY_JEV_API_KEY`), `JEFFREY_MAX_STEPS`, `JEFFREY_AUTO_APPROVE`.

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
Jev's confidence and score meters, inline diffs, a status bar, `esc` to abort a run, `ctrl-c` to
quit, and a prompt that stays open for the next goal.

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

## Offline mode

Both models can be mocked, so the whole loop is testable without a key or a GPU:

```bash
npm run selftest                                   # runs in a temp workspace
jeffrey --jev-mock --llm-mock --print --yes "add a farewell helper"
```

- `--jev-mock` replaces System One with a deterministic scripted decider. Optional tool list:
  `--jev-mock=read_file,edit_file,run_shell`.
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
| `progress` | score | 0–4: how much has actually been established |
| `stuck` | noul | The agent is looping; escalate |
| `needs_user` | noul | Requires human input; stop and ask |
| `risk` | score | 0–4: how hard is this to reverse |
| `<tool>.<arg>` | choice / noul | Which value for an argument with a closed set |

`Agent.run()` converts those into one of six routes — `goal-reached`, `jev-finish`, `act`,
`act-low-confidence`, `ask-user`, `stuck-escalation` — and only `act` reaches tool execution.

## Layout

```
src/cli.tsx          arg parsing, config layering, headless printer, Ink bootstrap
src/config.ts        config schema, defaults, file + env loading, redaction
src/types.ts         Jev primitives, decisions, events, budget
src/core/jev.ts      System One client: noul / choice / score questions, retries
src/core/decider.ts  question composition and answer interpretation
src/core/agent.ts    the loop: gate, plan arguments, approve, execute, narrate
src/core/tools.ts    tool registry, schemas, execution, diffs
src/core/llm.ts      OpenAI-compatible streaming client + offline mock
src/core/mock-jev.ts offline scripted decider
src/ui/*             Ink components, view reducer, theme
```
