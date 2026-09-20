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

/**
 * Laya — an Apache-2.0 decision model you host yourself (https://github.com/NandhaKishorM/laya).
 *
 * It answers the same three primitives as System One and returns the same response shape, so the
 * only thing this client does differently is talk to a local sidecar: `sidecar/laya-server.py`
 * wraps the Python package in the one endpoint jeffrey needs. No key, no network, no per-token
 * cost — and a much smaller context window, which is the trade (see `docs/deciders.md`).
 */
export class LayaClient implements DecisionModel {
  readonly provider = 'laya';
  readonly label: string;
  readonly usage: DecisionUsage = { calls: 0, inputTokens: 0 };

  constructor(private readonly config: DeciderConfig) {
    this.label = `laya:${config.model} · ${shortUrl(config.url)}`;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
    const body = JSON.stringify({
      state,
      model: this.config.model,
      questions,
      ...(this.config.options ?? {}),
    });
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await fetch(this.config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body,
          signal: controller.signal,
        });

        if (response.status >= 500) {
          lastError = new Error(`Laya server responded ${response.status}: ${await safeText(response)}`);
          continue;
        }
        if (!response.ok) {
          // A 4xx here is a question the model cannot represent — too many options for the head
          // budget, an unknown checkpoint — and the server's own text says which.
          throw new Error(`Laya server responded ${response.status}: ${await safeText(response)}`);
        }

        const parsed = (await response.json()) as SystemOneResponse;
        this.usage.calls += 1;
        this.usage.inputTokens += parsed.usage?.input_tokens ?? 0;
        return normalizeResponse(parsed, questions);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(
            `Laya request timed out after ${this.config.timeoutMs}ms. A cold checkpoint build takes ` +
              'seconds; start the server with --preload so it is resident.',
          );
          continue;
        }
        if (isRefused(error)) throw new Error(notRunning(this.config.url));
        if (error instanceof Error && /responded 4/.test(error.message)) throw error;
        lastError = error as Error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(
      `Laya request failed after ${this.config.maxRetries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
  }
}

export async function listLayaModels(config: DeciderConfig): Promise<DecisionModelInfo[]> {
  const url = config.url.replace(/\/v1\/systemone$/, '/v1/models');
  try {
    const response = await fetch(url, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    if (!response.ok) throw new Error(`Could not list models: ${response.status}`);
    const body = (await response.json()) as { models: DecisionModelInfo[] };
    return body.models;
  } catch (error) {
    if (isRefused(error)) throw new Error(notRunning(url));
    throw error;
  }
}

const DEAD = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Node reports a dead port as a bare `fetch failed`, with the real code one or two levels down:
 * under `cause`, and under `cause.errors` when both IPv4 and IPv6 were tried.
 */
function isRefused(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const node = error as { code?: string; cause?: unknown; errors?: unknown[] };
  if (node.code && DEAD.has(node.code)) return true;
  if (Array.isArray(node.errors) && node.errors.some((inner) => isRefused(inner, depth + 1))) return true;
  return isRefused(node.cause, depth + 1);
}

function notRunning(url: string): string {
  return (
    `No Laya server at ${url}. Start one from this repo:\n` +
    '  uv run --python 3.12 --with laya --with torch sidecar/laya-server.py --preload typed-decisions\n' +
    'or, with laya already installed: python3 sidecar/laya-server.py --preload typed-decisions'
  );
}
