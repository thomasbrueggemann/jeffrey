import type { Answer, Question, SystemOneResponse } from '../types.js';
import type { JevClient } from './jev.js';

/**
 * Deterministic stand-in for System One, used by `--jev-mock` and the offline self-test.
 *
 * It answers the exact questions `Decider` composes, so the whole routing path — relevance
 * screen, tool choice, argument choices, goal scoring — is exercised without an API key.
 * It is a test double, not an approximation of Jev: the point is to prove the plumbing.
 */
export interface MockScript {
  /** Tool names to route to, one per step, in order. */
  tools: string[];
  /** Probability reported for "goal reached" once the script is exhausted. */
  finalGoalReached?: number;
  /**
   * Probability reported for "goal reached" while the script still has tools left. Defaults to 0.04.
   * Raise it to exercise the goal-reached route on an early step.
   */
  goalReached?: number;
  /** Probability reported for "stuck" from `stuckFromStep` onward. */
  stuck?: number;
  stuckFromStep?: number;
  /**
   * Last routing call (0-based, counting re-asks) that still reports `stuck` as true. Lets a script
   * model the thing the recovery ladder is for: a loop that the agent breaks out of. Without it,
   * `stuck` stays true until the run ends, which only exercises the hand-off.
   */
  stuckUntilCall?: number;
  /** Force a specific confidence for the routing answer. */
  confidence?: number;
  /** Probability reported for `needs_user`, so routing around a low-probability question is testable. */
  needsUser?: number;
  /**
   * Tool names Jev "names" on a routing call even though they were never offered — the free-form
   * hallucination the agent's tool-correction path exists for. Keyed by routing call, counting
   * re-asks, and applied to `next_action` only unless `hallucinateFallback` is set.
   */
  hallucinations?: Record<number, string>;
  /** Extend the hallucination to `fallback_action`, leaving the agent no real runner-up to use. */
  hallucinateFallback?: boolean;
  /**
   * Probability reported for every acceptance criterion. Defaults to tracking `goal_reached`, so a
   * script that ends in a finished goal also ends with every criterion met.
   */
  criteriaMet?: number;
  /** Answer every argument question with the "executor decides" escape hatch, settling nothing. */
  leaveArgsToExecutor?: boolean;
}

export class MockJevClient implements JevClient {
  readonly label = 'mock-jev';
  readonly seenStates: unknown[] = [];
  private routingCalls = 0;

  constructor(private readonly script: MockScript = { tools: [] }) {}

  async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    this.seenStates.push(state);
    const answers: Record<string, Answer> = {};
    const isRoutingCall = 'next_action' in questions;
    const step = isRoutingCall ? this.routingCalls : this.routingCalls - 1;
    if (isRoutingCall) this.routingCalls += 1;

    const planned = this.script.tools[step];
    const exhausted = step >= this.script.tools.length;
    const confidence = this.script.confidence ?? 0.82;

    for (const [id, question] of Object.entries(questions)) {
      switch (question.type) {
        case 'noul':
          answers[id] = { type: 'noul', noul: this.noulFor(id, step, exhausted) };
          break;
        case 'score':
          answers[id] = {
            type: 'score',
            score: this.scoreFor(id, step),
            legend: legend(question.criteria),
            probabilities: {},
            confidence,
          };
          break;
        case 'choice':
          answers[id] = {
            type: 'choice',
            choice: this.choiceFor(id, question.criteria, planned, exhausted, step),
            probabilities: {},
            confidence,
          };
          break;
      }
    }

    return {
      model: 'mock-jev-0.0.0',
      answers,
      usage: { input_tokens: 400, output_tokens: 60 },
    };
  }

  private noulFor(id: string, step: number, exhausted: boolean): number {
    if (id === 'goal_reached') {
      return exhausted ? (this.script.finalGoalReached ?? 0.94) : (this.script.goalReached ?? 0.04);
    }
    if (id === 'stuck') {
      if (this.script.stuck !== undefined && step >= (this.script.stuckFromStep ?? 0)) {
        // `step` for a re-ask is still the step that triggered it, so bound on routing calls:
        // the recovery's own re-ask is one call later and can see the loop has been addressed.
        if (step <= (this.script.stuckUntilCall ?? Infinity)) return this.script.stuck;
      }
      return 0.05;
    }
    if (id === 'needs_user') return this.script.needsUser ?? 0.03;
    if (id.startsWith('criterion.')) {
      return this.script.criteriaMet ?? this.noulFor('goal_reached', step, exhausted);
    }
    if (id.endsWith('?')) return 0.15;
    if (id.startsWith('relevant.')) {
      return id.slice('relevant.'.length) === this.script.tools[step] ? 0.9 : 0.2;
    }
    return 0.2;
  }

  private scoreFor(id: string, step: number): number {
    if (id === 'progress') {
      const total = Math.max(1, this.script.tools.length);
      return Math.min(4, 0.4 + (4 - 0.4) * (step / total));
    }
    if (id === 'risk') return 1.2;
    return 1;
  }

  private choiceFor(
    id: string,
    criteria: Record<string, string | null>,
    planned: string | undefined,
    exhausted: boolean,
    step: number,
  ): string {
    const options = Object.keys(criteria);
    const hallucinated = this.script.hallucinations?.[step];
    if (id === 'next_action') {
      // A name outside the option set is a thing a real model does; the open-ended `choice`
      // contract does not forbid it, and the agent has to cope.
      if (hallucinated) return hallucinated;
      if (exhausted || !planned) return options.includes('done') ? 'done' : (options[0] ?? '');
      return options.includes(planned) ? planned : (options[0] ?? '');
    }
    if (id === 'fallback_action') {
      if (hallucinated && this.script.hallucinateFallback) return hallucinated;
      const preferred = options.find((option) => option !== planned && option !== 'done');
      return preferred ?? options[0] ?? '';
    }
    if (id === 'step_intent') return intentFor(planned, step) ?? options[0] ?? '';
    // Argument questions: take the first real option, skipping the "executor decides" escape hatch.
    const escape = options.find((option) => option.startsWith('the executor should decide'));
    if (this.script.leaveArgsToExecutor && escape) return escape;
    const real = options.filter((option) => option !== escape);
    return real[0] ?? options[0] ?? '';
  }
}

/** A plausible purpose for the scripted tool, so the executor brief carries a realistic intent. */
function intentFor(tool: string | undefined, step: number): string | undefined {
  if (tool === 'edit_file' || tool === 'write_file') return 'change';
  if (tool === 'run_shell') return 'verify';
  if (tool === 'read_file') return step === 0 ? 'locate' : 'inspect';
  return tool ? 'locate' : undefined;
}

function legend(levels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  levels.forEach((level, index) => {
    out[String(index)] = level;
  });
  return out;
}
