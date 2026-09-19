/**
 * Shared types for jeffrey.
 *
 * Two models are in play, and the split is deliberate:
 *
 *   - **Jev** (TypeSafe System One) is the *decider*. It never writes text. It answers typed
 *     questions about the current state and returns calibrated probabilities.
 *   - **The LLM** is the *executor*. It never decides what to do next. It only fills in the
 *     arguments for the tool Jev selected — which is where code edits actually happen.
 */

/* ------------------------------------------------------------------ TypeSafe primitives */

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  state: unknown;
  model: string;
  questions: Record<string, Question>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/* ------------------------------------------------------------------ agent */

export interface ToolCallRecord {
  step: number;
  /** What Jev chose, before the LLM turned it into arguments. */
  jevChose: string;
  tool: string;
  args: unknown;
  ok: boolean;
  observation: string;
}

export interface JevDecision {
  /** The tool Jev selected as the single best next action. */
  tool: string;
  /** Jev's probability for each candidate tool. */
  probabilities: Record<string, number>;
  /** How sure Jev is about the pick. Low confidence is a routing signal, not noise. */
  confidence: number;
  /** Probability that the goal is already achieved. */
  goalReached: number;
  /** Probability-weighted progress across the rubric levels. */
  progress: number;
  progressLegend: Record<string, string>;
  /** Probability the agent is looping without making real progress. */
  stuck: number;
  /** Probability that only the user can unblock the next step. */
  needsUserInput: number;
  /** Probability-weighted risk of the next action. */
  risk: number;
  riskLegend: Record<string, string>;
  /** Second-best action, used as a fallback when the top pick fails. */
  fallbackTool: string;
  /** Per-tool relevance probabilities (speculative fan-out, shown in verbose mode). */
  toolRelevance: Record<string, number>;
  /** Which code path in `agent.ts` produced the outcome. */
  route: DecisionRoute;
  /** Raw response, kept for `--explain`. */
  raw: SystemOneResponse;
}

export type DecisionRoute =
  | 'goal-reached'
  | 'jev-finish'
  | 'act'
  | 'act-low-confidence'
  | 'ask-user'
  | 'stuck-escalation';

export interface StepRecord {
  step: number;
  decision: JevDecision;
  tool: string;
  args: unknown;
  ok: boolean;
  observation: string;
}

export type ApprovalChoice = 'allow' | 'allow-always' | 'deny';

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  /** What the tool is about to change, rendered as a preview in the UI. */
  preview?: string;
  risk: number;
  reason: string;
}

export interface Budget {
  jevCalls: number;
  jevInputTokens: number;
  llmCalls: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  steps: number;
}

export type DoneReason =
  | 'goal-reached'
  | 'finished'
  | 'max-steps'
  | 'aborted'
  | 'error'
  | 'stuck'
  | 'needs-input';

export type AgentEvent =
  | { type: 'phase'; phase: 'deciding' | 'planning' | 'executing' | 'verifying' }
  | { type: 'decision'; step: number; decision: JevDecision }
  | { type: 'llm-stream'; channel: 'reasoning' | 'narration'; text: string }
  | { type: 'llm-context'; paths: string[]; why: string }
  | { type: 'tool-call'; step: number; tool: string; args: unknown; fromFallback: boolean }
  | { type: 'observation'; step: number; tool: string; ok: boolean; output: string; summary: string; diff?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'budget'; budget: Budget }
  | {
      type: 'done';
      reason: DoneReason;
      summary: string;
      decision?: JevDecision;
      steps: number;
      budget: Budget;
    };
