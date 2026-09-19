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
import type { JevConfig } from '../config.js';

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

/* ------------------------------------------------------------------ client */

export interface JevClient {
  readonly label: string;
  ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse>;
}

export interface JevUsage {
  calls: number;
  inputTokens: number;
}

export class TypeSafeClient implements JevClient {
  readonly label: string;
  readonly usage: JevUsage = { calls: 0, inputTokens: 0 };

  constructor(private readonly config: JevConfig) {
    this.label = `${config.model} · ${shortUrl(config.url)}`;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        'No TypeSafe API key. Set TYPESAFE_API_KEY, or add jev.apiKey to jeffrey.config.json. ' +
          'Get a key at https://console.typesafe.ai/settings/keys',
      );
    }

    const body = JSON.stringify({ state, model: this.config.model, questions });
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        // 429 and 529 both mean "come back later", so back off rather than hammering.
        const delay = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 200;
        await sleep(delay);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await fetch(this.config.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        });

        if (response.status === 429 || response.status === 529 || response.status >= 500) {
          lastError = new Error(`TypeSafe responded ${response.status}`);
          continue;
        }
        if (!response.ok) {
          const detail = await safeText(response);
          throw new Error(`TypeSafe responded ${response.status}: ${detail}`);
        }

        const parsed = (await response.json()) as SystemOneResponse;
        this.usage.calls += 1;
        this.usage.inputTokens += parsed.usage?.input_tokens ?? 0;
        return parsed;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`TypeSafe request timed out after ${this.config.timeoutMs}ms`);
          continue;
        }
        // A 4xx that is not a rate limit is a bug in the request, not a transient fault.
        if (error instanceof Error && /responded 4/.test(error.message)) throw error;
        lastError = error as Error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(
      `TypeSafe request failed after ${this.config.maxRetries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
  }
}

export async function listModels(config: JevConfig): Promise<Array<{ name: string; description: string; release_date: string }>> {
  const url = config.url.replace(/\/v1\/systemone$/, '/v1/models');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`Could not list models: ${response.status}`);
  const body = (await response.json()) as { models: Array<{ name: string; description: string; release_date: string }> };
  return body.models;
}

/* ------------------------------------------------------------------ helpers */

function shortUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return '(no body)';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
