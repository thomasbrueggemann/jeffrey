import type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  SystemOneResponse,
} from '../types.js';

/* ------------------------------------------------------------------ question builders */

/**
 * A yes/no question. Returns a single probability and nothing else — there is no confidence
 * field on a noul answer, so thresholds on it are read directly.
 */
export function noul(
  instructions: string,
  criteria?: { true?: string; false?: string },
): NoulQuestion {
  const q: NoulQuestion = { type: 'noul', instructions };
  if (criteria) q.criteria = criteria;
  return q;
}

/** Pick one option out of a closed set. Returns the option plus the full distribution. */
export function choice(
  instructions: string,
  criteria: Record<string, string | null>,
): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

/** Rate the state against ordered levels. Returns a probability-weighted value between levels. */
export function score(instructions: string, criteria: string[]): ScoreQuestion {
  if (criteria.length < 2) {
    throw new Error('A score question needs at least two levels');
  }
  return { type: 'score', instructions, criteria };
}

/* ------------------------------------------------------------------ answer narrowing */

export function asChoice(answer: Answer | undefined): ChoiceAnswer | undefined {
  return answer && answer.type === 'choice' ? answer : undefined;
}

export function asNoul(answer: Answer | undefined): NoulAnswer | undefined {
  return answer && answer.type === 'noul' ? answer : undefined;
}

export function asScore(answer: Answer | undefined): ScoreAnswer | undefined {
  return answer && answer.type === 'score' ? answer : undefined;
}

/** Pull a noul value out of a response, defaulting to 0 so a missing answer never reads as "yes". */
export function noulValue(response: SystemOneResponse, id: string): number {
  return asNoul(response.answers[id])?.noul ?? 0;
}

export function choiceValue(response: SystemOneResponse, id: string): string {
  return asChoice(response.answers[id])?.choice ?? '';
}

export function scoreValue(response: SystemOneResponse, id: string): number {
  return asScore(response.answers[id])?.score ?? 0;
}

/* ------------------------------------------------------------------ the decision model */

/**
 * A decision model: it answers typed questions about a state and returns calibrated
 * probabilities. Jev (TypeSafe System One) is one; a locally hosted Laya is another. Everything
 * above this interface — `Decider`, the agent loop, the UI — is provider-agnostic, and the
 * providers live in `deciders/`.
 */
export interface DecisionModel {
  /** What to show in the header and the session log: model plus where it runs. */
  readonly label: string;
  /** Which provider built this client, for logs and error messages. */
  readonly provider: string;
  ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse>;
}

/** Per-run accounting. Providers that bill by token report them; local ones report what they read. */
export interface DecisionUsage {
  calls: number;
  inputTokens: number;
}

/** A model a provider offers, as `--list-models` prints it. */
export interface DecisionModelInfo {
  name: string;
  description: string;
  release_date: string;
}

/* ------------------------------------------------------------------ shared client helpers */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Back-off for "come back later" responses, shared by every HTTP-backed provider. */
export function backoffDelay(attempt: number): number {
  return Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 200;
}

export async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return '(no body)';
  }
}

export function shortUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Fill in what a provider left out. Laya answers in the same shape as System One, but a
 * hand-rolled server behind the same endpoint may not, and a missing `type` would silently read
 * as "no answer" everywhere the narrowing helpers are used.
 */
export function normalizeResponse(
  raw: SystemOneResponse,
  questions: Record<string, Question>,
): SystemOneResponse {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers?.[id] as (Partial<Answer> & Record<string, unknown>) | undefined;
    if (!answer) continue;
    const typed = (answer.type ? answer : { ...answer, type: question.type }) as Answer;
    if (typed.type === 'score' && !typed.legend && question.type === 'score') {
      typed.legend = Object.fromEntries(question.criteria.map((level, index) => [String(index), level]));
    }
    answers[id] = typed;
  }
  return { ...raw, answers };
}
