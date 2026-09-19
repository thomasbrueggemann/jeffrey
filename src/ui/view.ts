import type { AgentEvent, Budget, DoneReason, JevDecision } from '../types.js';

export type Phase = 'idle' | 'deciding' | 'planning' | 'executing' | 'verifying' | 'approving';

export interface StepView {
  step: number;
  phase: Phase;
  decision?: JevDecision;
  tool?: string;
  args?: Record<string, unknown>;
  fromFallback?: boolean;
  /** Free text the executor streamed while composing the tool call. */
  reasoning: string;
  /** Files the executor asked to see before answering (context expansion). */
  context?: { paths: string[]; why: string };
  /** The executor's short report after the tool ran. */
  narration: string;
  observation?: { ok: boolean; output: string; summary: string; diff?: string };
  /** Calls that ran earlier in this step, when one reply brought several (e.g. a new app's files). */
  earlier?: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; summary: string }>;
}

export type Block =
  | { key: string; kind: 'goal'; text: string }
  | { key: string; kind: 'step'; view: StepView }
  | { key: string; kind: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  /** A snapshot of the acceptance criteria, appended whenever one changes. */
  | { key: string; kind: 'criteria'; step: number; criteria: Array<{ id: number; text: string; met: boolean }>; changed: number[] }
  | {
      key: string;
      kind: 'final';
      reason: DoneReason;
      summary: string;
      steps: number;
      budget: Budget;
      decision?: JevDecision;
    };

export interface ViewState {
  blocks: Block[];
  live: StepView | null;
  budget: Budget;
  phase: Phase;
  seq: number;
}

export const EMPTY_BUDGET: Budget = {
  jevCalls: 0,
  jevInputTokens: 0,
  llmCalls: 0,
  llmPromptTokens: 0,
  llmCompletionTokens: 0,
  steps: 0,
};

export function initialState(): ViewState {
  return { blocks: [], live: null, budget: EMPTY_BUDGET, phase: 'idle', seq: 0 };
}

export function reduce(state: ViewState, action: Action): ViewState {
  if (action.type === 'goal') {
    return {
      ...state,
      blocks: [...state.blocks, { key: `g${state.seq}`, kind: 'goal', text: action.text }],
      seq: state.seq + 1,
      live: null,
      phase: 'deciding',
    };
  }

  const event = action;
  const next: ViewState = { ...state, blocks: state.blocks, live: state.live };

  switch (event.type) {
    case 'phase': {
      next.phase = event.phase;
      if (next.live) next.live = { ...next.live, phase: event.phase };
      return next;
    }

    case 'decision': {
      // A new decision always opens a fresh step block and freezes the previous one.
      if (next.live) next.blocks = [...next.blocks, freeze(next.live, next)];
      next.live = { step: event.step, phase: 'deciding', reasoning: '', narration: '', decision: event.decision };
      return next;
    }

    case 'llm-stream': {
      if (!next.live) return next;
      next.live =
        event.channel === 'reasoning'
          ? { ...next.live, reasoning: event.text }
          : { ...next.live, narration: event.text };
      return next;
    }

    case 'llm-context': {
      if (!next.live) return next;
      next.live = { ...next.live, context: { paths: event.paths, why: event.why } };
      return next;
    }

    case 'tool-call': {
      if (!next.live) return next;
      // A second call in the same step: keep the finished one as a line instead of overwriting it.
      const done = next.live.tool && next.live.observation ? next.live : undefined;
      next.live = {
        ...next.live,
        ...(done
          ? {
              earlier: [
                ...(done.earlier ?? []),
                { tool: done.tool!, args: done.args ?? {}, ok: done.observation!.ok, summary: done.observation!.summary },
              ],
              observation: undefined,
            }
          : {}),
        tool: event.tool,
        args: (event.args ?? {}) as Record<string, unknown>,
        fromFallback: event.fromFallback,
        phase: 'executing',
      };
      return next;
    }

    case 'observation': {
      if (!next.live) return next;
      next.live = {
        ...next.live,
        phase: 'verifying',
        observation: {
          ok: event.ok,
          output: event.output,
          summary: event.summary,
          ...(event.diff ? { diff: event.diff } : {}),
        },
      };
      return next;
    }

    case 'notice': {
      next.blocks = [...next.blocks, { key: `n${next.seq}`, kind: 'notice', level: event.level, message: event.message }];
      next.seq += 1;
      return next;
    }

    case 'budget':
      next.budget = event.budget;
      return next;

    case 'criteria': {
      // Frozen blocks cannot be updated in place, so each change appends a fresh snapshot.
      next.blocks = [
        ...next.blocks,
        { key: `c${next.seq}`, kind: 'criteria', step: event.step, criteria: event.criteria, changed: event.changed },
      ];
      next.seq += 1;
      return next;
    }

    case 'done': {
      if (next.live) {
        next.blocks = [...next.blocks, freeze(next.live, next)];
        next.live = null;
      }
      next.blocks = [
        ...next.blocks,
        {
          key: `f${next.seq}`,
          kind: 'final',
          reason: event.reason,
          summary: event.summary,
          steps: event.steps,
          budget: event.budget,
          ...(event.decision ? { decision: event.decision } : {}),
        },
      ];
      next.seq += 1;
      next.phase = 'idle';
      next.budget = event.budget;
      return next;
    }
  }
}

function freeze(view: StepView, state: ViewState): Block {
  return { key: `s${view.step}-${state.seq}`, kind: 'step', view: { ...view, phase: 'idle' } };
}

export type Action = AgentEvent | { type: 'goal'; text: string };
