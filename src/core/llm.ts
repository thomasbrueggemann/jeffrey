import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LlmConfig } from '../config.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens the server reused from its prefix cache, when it reports them. */
  cachedTokens?: number;
}

export interface LlmResult {
  content: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  finishReason: string;
}

export interface CompleteOptions {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  /** Called with each incremental token so the TUI can render as it arrives. */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  /** Merged into this request's body after the config's `extraBody`. */
  extraBody?: Record<string, unknown>;
}

export interface LlmClient {
  readonly label: string;
  complete(options: CompleteOptions): Promise<LlmResult>;
}

/**
 * OpenAI-compatible chat-completions client.
 *
 * Every local runtime worth using (Ollama, llama.cpp's server, LM Studio, vLLM, text-generation-webui)
 * speaks this shape, so one client covers all of them. Streaming is on by default because the whole
 * point of the TUI is watching the model write.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly label: string;

  constructor(private readonly config: LlmConfig) {
    this.label = `${config.model} · ${shortUrl(config.baseUrl)}`;
  }

  async complete(options: CompleteOptions): Promise<LlmResult> {
    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      ...options.extraBody,
      model: this.config.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
    };
    if (options.tools?.length) {
      body['tools'] = options.tools;
      body['tool_choice'] = options.toolChoice ?? 'auto';
    }

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey && this.config.apiKey !== 'not-needed'
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {}),
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `LLM ${response.status} from ${this.config.baseUrl}/chat/completions: ${detail.slice(0, 500)}`,
      );
    }

    return readStream(response.body, options.onToken);
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
): Promise<LlmResult> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = '';
  let usage: LlmUsage = { promptTokens: 0, completionTokens: 0 };
  const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === 'string' && delta.content.length) {
      content += delta.content;
      onToken?.(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call.index === 'number' ? call.index : 0;
        const existing = toolAccumulator.get(index) ?? { id: '', name: '', args: '' };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name += call.function.name;
        if (call.function?.arguments) existing.args += call.function.arguments;
        toolAccumulator.set(index, existing);
      }
    }

    const reason = chunk.choices?.[0]?.finish_reason;
    if (reason) finishReason = reason;
  };

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) handleLine(buffer);

  const toolCalls: ToolCall[] = [...toolAccumulator.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value], index) => ({
      id: value.id || `call_${index}`,
      type: 'function' as const,
      function: { name: value.name, arguments: value.args || '{}' },
    }))
    .filter((call) => call.function.name);

  return { content, toolCalls, usage, finishReason };
}

/* ------------------------------------------------------------------ mock */

/**
 * Offline executor used by `--llm-mock` and the self-test. It does not reason; it emits a
 * syntactically valid call for whatever tool the loop asked for, so the plumbing around it
 * (Jev routing, approval, observation formatting) can be exercised without a GPU.
 *
 * Arguments are synthesised from the tool schema the agent embeds in the system prompt, and any
 * argument the decider already settled is copied through verbatim — which makes the mock a useful
 * check that Jev's choices actually survive all the way into the tool call.
 */
export class MockLlmClient implements LlmClient {
  readonly label = 'mock-executor';
  private counter = 0;

  constructor(private readonly script: string[] = []) {}

  async complete(options: CompleteOptions): Promise<LlmResult> {
    const last = [...options.messages].reverse().find((m) => m.role === 'tool');
    const users = options.messages.filter((m) => m.role === 'user');
    const brief = users.at(-1)?.content ?? '';
    const planned = this.script[this.counter] ?? '';
    this.counter += 1;

    const usage = { promptTokens: 0, completionTokens: 0 };

    if (last) {
      const content = `Mock executor saw ${last.name ?? 'a tool'} return. Summarising: ${truncate(last.content ?? '', 160)}`;
      await this.stream(content, options);
      return { content, toolCalls: [], usage, finishReason: 'stop' };
    }

    const system = options.messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('acceptance criteria that define "done"')) {
      const goal = /^Goal: (.*)$/m.exec(brief)?.[1] ?? 'the goal';
      const content = `1. The change the goal asks for is in place: ${goal}\n2. A command or file read shows the change working`;
      await this.stream(content, options);
      return { content, toolCalls: [], usage, finishReason: 'stop' };
    }
    const toolName = /Call this tool now:\s*(\w+)/.exec(brief)?.[1];
    const schema =
      (options.tools?.[0]?.function.parameters as MockSchema | undefined) ??
      extractTrailingJson(options.messages.at(-1)?.content ?? '') ??
      extractTrailingJson(system);
    const workspace = users.map((m) => /^Workspace: (\/.*)$/m.exec(m.content ?? '')?.[1]).find(Boolean) ?? process.cwd();

    if (toolName && schema) {
      const args = synthesise(schema, settledFrom(brief), toolName, workspace);
      const reasoning = `Mock executor filling in ${toolName}: ${Object.keys(args).join(', ') || 'no arguments'}`;
      await this.stream(reasoning, options);

      if (options.tools?.length) {
        return {
          content: '',
          toolCalls: [
            { id: `mock-${this.counter}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } },
          ],
          usage,
          finishReason: 'tool_calls',
        };
      }
      return {
        content: JSON.stringify({ arguments: args }),
        toolCalls: [],
        usage,
        finishReason: 'stop',
      };
    }

    const content = planned || `Mock executor reasoning about: ${truncate(brief, 160)}`;
    await this.stream(content, options);
    return { content, toolCalls: [], usage, finishReason: 'stop' };
  }

  /** `onToken` receives deltas, matching the streaming OpenAI client. */
  private async stream(content: string, options: CompleteOptions): Promise<void> {
    for (const token of content.match(/\s*\S+/g) ?? []) {
      options.onToken?.(token);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  }
}

interface MockSchema {
  required?: string[];
  properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
}

/** The schema the agent appends to the executor system prompt is the last JSON object in it. */
function extractTrailingJson(text: string): MockSchema | undefined {
  const start = text.lastIndexOf('\n{');
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start)) as MockSchema;
  } catch {
    return undefined;
  }
}

/** `  path = "src/x.ts"` lines from the decider-settled guidance block. */
function settledFrom(brief: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of brief.split('\n')) {
    const match = /^\s*(\w+) = (.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    try {
      out[key] = JSON.parse(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

function synthesise(
  schema: MockSchema,
  settled: Record<string, unknown>,
  toolName: string,
  workspace: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...settled };
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (args[name] !== undefined) continue;
    const property = properties[name] ?? {};
    if (property.default !== undefined) {
      args[name] = property.default;
      continue;
    }
    args[name] = mockValue(name, property.type, toolName, workspace);
  }
  if (toolName === 'edit_file' || toolName === 'multi_edit') {
    const target = mockEditPair(typeof args['path'] === 'string' ? resolve(workspace, args['path']) : undefined);
    if (target) {
      if (args['old_string'] === undefined) args['old_string'] = target.old;
      if (args['new_string'] === undefined) args['new_string'] = target.next;
    }
  }
  return args;
}

/** An edit the tool will actually accept: the real first line of the target file, and a change to it. */
function mockEditPair(path: string | undefined): { old: string; next: string } | undefined {
  if (!path) return undefined;
  try {
    const text = readFileSync(path, 'utf8');
    const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
    if (!line) return undefined;
    return { old: line, next: `${line} // mock edit` };
  } catch {
    return undefined;
  }
}

function mockValue(name: string, type: string | undefined, toolName: string, workspace: string): unknown {
  const lower = name.toLowerCase();
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'array') return [];
  if (lower.includes('command')) return 'echo mock-executor-ran';
  if (lower.includes('content')) return '# Mock\n\nContent written by the mock executor.\n';
  if (lower.includes('pattern')) return 'mock';
  if (lower.includes('old_string') || lower.includes('old')) return 'export const greet = (name) => `hi ${name}`;';
  if (lower.includes('new_string') || lower.includes('new')) return 'export const greet = (name) => `hello ${name}`;';
  if (lower.includes('dir') || lower.includes('path') || lower.includes('file')) return mockPath(toolName, workspace);
  return 'mock';
}

/** A file for file tools, a directory for `list_dir` — so a mock run does not fail on its own args. */
function mockPath(toolName: string, workspace: string): string {
  const wantsDir = toolName === 'list_dir';
  try {
    const entries = readdirSync(workspace, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
    if (wantsDir) return dirs[0]?.name ?? '.';
    if (files.some((entry) => entry.name === 'package.json')) return 'package.json';
    return files[0]?.name ?? dirs[0]?.name ?? '.';
  } catch {
    return '.';
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function shortUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function createLlmClient(config: LlmConfig): LlmClient {
  return config.mock ? new MockLlmClient() : new OpenAiCompatibleClient(config);
}
