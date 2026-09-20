# Decision models

jeffrey runs on two models. The *executor* is a local LLM that writes code. The *decider* never
writes text: it answers typed questions about the current state — one `choice` for the next
action, `noul`s for the gates, a `score` for progress — and the loop is routed on those
probabilities.

The decider is a plug. Which one is in use changes nothing above `DecisionModel`
([`src/core/decision.ts`](../src/core/decision.ts)): the agent, the `Decider` that composes the
questions, the UI and the session log are all provider-agnostic.

| provider | what it is | key | where it runs |
|---|---|---|---|
| `typesafe` | Jev, TypeSafe System One | yes | hosted API |
| `laya` | [Laya](https://github.com/NandhaKishorM/laya), Apache 2.0 | no | your machine, through `sidecar/laya-server.py` |
| `mock` | scripted answers for tests and `--jev-mock` | no | in process |

Pick one with `--decider <provider>`, `JEFFREY_DECIDER`, or `decider.provider` in the config
file. Each provider brings its own endpoint and model name, so switching provider is one flag:

```bash
jeffrey --decider laya "add a --json flag to the CLI"
```

## Laya

Laya is a non-autoregressive decision model: a 322M–421M encoder that answers every question in
one forward pass, with no text generation. It answers the same three primitives as System One
and returns the same response shape, which is why the client for it is thin.

It ships as a Python package with no server, so this repo carries one:
[`sidecar/laya-server.py`](../sidecar/laya-server.py), standard library only, exposing the single
endpoint jeffrey speaks.

```bash
# terminal 1 — the decider, resident so requests do not pay for a checkpoint build
uv run --python 3.12 --with laya --with torch sidecar/laya-server.py --preload typed-decisions

# terminal 2 — the agent
jeffrey --decider laya -y "fix the failing test in src/parse.py"
```

`--preload` matters. A cold checkpoint build costs seconds and the default keeps one model
resident; preloading the checkpoint you serve keeps a decision at tens of milliseconds.

Three checkpoints are available, and `--jev-model` picks between them: `router` (default; detect
the language, then choose), `english`, `multilingual`, `typed-decisions`. For a coding agent the
state is English and the questions are typed-workflow shaped, so `typed-decisions` is the
server's default when routing does not override it.

### Measured once

One real run, 2026-09-20: the `pricing-bugfix` bench task, Laya (`typed-decisions`, CPU on Apple
silicon) deciding and Qwen3.6-35B-A3B executing. Six steps, five executor calls, goal reached, and
all 12 tests pass — the task's own suite and the bench's hidden one. A decision took about 0.4 s;
the executor took the rest. That is one task, one run: it shows the loop works end to end with a
second provider, and nothing more.

### What is different from Jev

- **Context.** Laya reads 512 tokens (english) or 1024 (multilingual, typed-decisions). A
  jeffrey state is larger than that, and what gets cut is the tail: the recent history and the
  progress rubric, since the state is built stable-first with the goal at the top. Raise it with
  `--max-len` if your hardware allows — the mmBERT encoder behind `laya-multilingual` supports up
  to 8192 — and expect the answers to change when you do.
- **Options per question.** Every option label of a `choice` shares `--head-max-len` tokens.
  jeffrey caps argument questions at 12 options, which fits; a question that does not is a 400
  from the sidecar naming the question, not a silent bad answer. The one question with long
  options rather than many is `loop_cause`, the loop diagnosis (see *When it gets stuck* in the
  README): five full sentences. If it does not fit, the agent says so once and falls back to the
  subtractive ladder — the run continues, but recoveries stop proposing new approaches, so raise
  `head_max_len` if you see that notice.
- **Zero-shot quality.** Laya's own benchmarks put the base checkpoints near chance on typed
  decisions and the fine-tuned `laya-typed-decisions` above Jev's published figure. Ours is a
  fourth workflow neither was tuned on. Treat it as an experiment until you have measured it on
  your own tasks.
- **Confidence is not on the same scale.** jeffrey's thresholds (`minConfidence`, and the gates in
  `agent`) were tuned against Jev. Laya's confidence comes from its own calibration and the option
  count, and a routing answer that is clearly right can land near 0.38. Re-tune the thresholds
  before reading a low-confidence route as a bad answer.
- **Cost.** No key, no per-token bill, no network.

### Configuration

```json
{
  "decider": {
    "provider": "laya",
    "url": "http://127.0.0.1:8137/v1/systemone",
    "model": "router",
    "options": { "head_max_len": 512, "max_len": 1024 }
  }
}
```

`options` is passed through to the provider in the request body; the Laya sidecar reads
`head_max_len` and `max_len` from it, per request. The older `jev` section name is still read as
`decider`, and `TYPESAFE_API_KEY` still supplies the key for the `typesafe` provider.

## Adding a provider

1. Write a client in `src/core/deciders/` that implements `DecisionModel`: a `label`, a
   `provider`, and `ask(state, questions)` returning a System One response. `normalizeResponse`
   in `src/core/decision.ts` fills in anything the server left out.
2. Add an entry to `PROVIDERS` in [`src/core/deciders/index.ts`](../src/core/deciders/index.ts)
   with its defaults and whether it needs a key.
3. Add the name to `DeciderProvider` in [`src/config.ts`](../src/config.ts).

Nothing else changes. `test/deciders.test.ts` holds the seam: the wire shape, the defaults, and
the errors a provider is expected to report rather than swallow.

## Why you might want a second one

[`bench/RESULTS.md`](../bench/RESULTS.md) says, under *What this benchmark does not test*, that
every run measured so far had the same decision model in the loop, so the numbers say nothing
about what the decider contributes. A second provider is the cheapest way to find out: same
tools, same executor, same tasks, a different model answering "which action next".
