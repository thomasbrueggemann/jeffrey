import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { redact, SESSIONS_DIR } from '../config.js';
import type { AgentEvent, ApprovalRequest, ApprovalResponse, Question, SystemOneResponse } from '../types.js';
import type { DecisionModel } from './decision.js';
import type { CompleteOptions, LlmClient, LlmResult } from './llm.js';

/**
 * A per-session transcript, written as JSON lines to `~/.jeffrey/sessions/<timestamp>-<id>.jsonl`.
 *
 * It exists for one job: reconstructing exactly what happened in a run after the fact. The TUI shows
 * a digest; this keeps what the digest drops — the full state and questions sent to Jev, its raw
 * answers, every executor prompt and reply, and how long each took.
 *
 * Requests are written *before* the call is made, so a hang or a crash still leaves the last thing
 * that was in flight. The file is created lazily on first write (a `--help` run leaves nothing), and
 * logging never throws: a full disk must not take the agent down, so the first write error turns the
 * log off for the rest of the session.
 */
export class SessionLog {
  readonly id = randomBytes(4).toString('hex');
  readonly path: string;
  private seq = 0;
  private callSeq = 0;
  private dead = false;
  private ready = false;

  constructor(
    private readonly dir: string = SESSIONS_DIR,
    now: Date = new Date(),
  ) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    this.path = join(dir, `${stamp}-${this.id}.jsonl`);
  }

  /** Append one record. Never throws. */
  write(type: string, data: Record<string, unknown> = {}): void {
    if (this.dead) return;
    try {
      if (!this.ready) {
        // Transcripts hold file contents and command output, so keep them private to the user.
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.ready = true;
      }
      const line = JSON.stringify({ seq: ++this.seq, ts: new Date().toISOString(), type, ...data }, replacer);
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch {
      this.dead = true;
    }
  }

  start(info: { version: string; config: Config; jevLabel: string; llmLabel: string }): void {
    this.write('session-start', {
      sessionId: this.id,
      version: info.version,
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      jev: info.jevLabel,
      llm: info.llmLabel,
      config: describeConfig(info.config),
    });
  }

  goal(goal: string): void {
    this.write('goal', { goal });
  }

  /** Agent events, minus `llm-stream`: it is cumulative, so the final text is in the `llm-response`. */
  event(event: AgentEvent): void {
    if (event.type === 'llm-stream') return;
    // A decision carries Jev's raw response, which `jev-response` already holds in full.
    if (event.type === 'decision') {
      const { raw: _raw, ...decision } = event.decision;
      this.write('event', { event: { ...event, decision } });
      return;
    }
    this.write('event', { event });
  }

  failure(error: unknown): void {
    this.write('run-error', { error: describeError(error) });
  }

  wrapApprove(
    approve: (request: ApprovalRequest) => Promise<ApprovalResponse>,
  ): (request: ApprovalRequest) => Promise<ApprovalResponse> {
    return async (request) => {
      this.write('approval-request', { request });
      const response = await approve(request);
      this.write('approval-response', { tool: request.tool, response });
      return response;
    };
  }

  wrapDecider(client: DecisionModel): DecisionModel {
    const log = this;
    return {
      label: client.label,
      provider: client.provider,
      async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const call = ++log.callSeq;
        const started = Date.now();
        log.write('jev-request', { call, state, questions });
        try {
          const response = await client.ask(state, questions);
          log.write('jev-response', { call, ms: Date.now() - started, response });
          return response;
        } catch (error) {
          log.write('jev-error', { call, ms: Date.now() - started, error: describeError(error) });
          throw error;
        }
      },
    };
  }

  wrapLlm(client: LlmClient): LlmClient {
    const log = this;
    return {
      label: client.label,
      async complete(options: CompleteOptions): Promise<LlmResult> {
        const call = ++log.callSeq;
        const started = Date.now();
        log.write('llm-request', {
          call,
          messages: options.messages,
          tools: options.tools,
          toolChoice: options.toolChoice,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
        });
        try {
          const result = await client.complete(options);
          log.write('llm-response', { call, ms: Date.now() - started, result });
          return result;
        } catch (error) {
          log.write('llm-error', { call, ms: Date.now() - started, error: describeError(error) });
          throw error;
        }
      },
    };
  }
}

/** The effective config, with every credential masked — the log must be safe to paste into an issue. */
export function describeConfig(config: Config): unknown {
  return {
    llm: {
      ...config.llm,
      apiKey: redact(config.llm.apiKey),
      headers: Object.fromEntries(Object.entries(config.llm.headers).map(([key, value]) => [key, redact(value)])),
    },
    decider: { ...config.decider, apiKey: redact(config.decider.apiKey) },
    agent: config.agent,
  };
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  return { name: 'Error', message: String(error) };
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
