import type { Question, SystemOneResponse } from '../../types.js';
import type { DeciderConfig } from '../../config.js';
import {
  backoffDelay,
  normalizeResponse,
  safeText,
  shortUrl,
  sleep,
  type DecisionModel,
  type DecisionModelInfo,
  type DecisionUsage,
} from '../decision.js';

/** TypeSafe System One — the hosted decision model jeffrey was built against. */
export class TypeSafeClient implements DecisionModel {
  readonly provider = 'typesafe';
  readonly label: string;
  readonly usage: DecisionUsage = { calls: 0, inputTokens: 0 };

  constructor(private readonly config: DeciderConfig) {
    this.label = `${config.model} · ${shortUrl(config.url)}`;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        'No TypeSafe API key. Set TYPESAFE_API_KEY, or add decider.apiKey to jeffrey.config.json. ' +
          'Get a key at https://console.typesafe.ai/settings/keys',
      );
    }

    const body = JSON.stringify({ state, model: this.config.model, questions });
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      // 429 and 529 both mean "come back later", so back off rather than hammering.
      if (attempt > 0) await sleep(backoffDelay(attempt));

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
        return normalizeResponse(parsed, questions);
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

export async function listTypeSafeModels(config: DeciderConfig): Promise<DecisionModelInfo[]> {
  const url = config.url.replace(/\/v1\/systemone$/, '/v1/models');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`Could not list models: ${response.status}`);
  const body = (await response.json()) as { models: DecisionModelInfo[] };
  return body.models;
}
