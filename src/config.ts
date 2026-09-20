import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROVIDERS, isProvider } from './core/deciders/index.js';

export interface LlmConfig {
  /** OpenAI-compatible base URL. `http://localhost:11434/v1`, `http://127.0.0.1:8080/v1`, ... */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /**
   * Budget for the short calls — the per-step note and the acceptance criteria. They are a few
   * sentences, but a thinking model can spiral on them: with the executor's budget, one note took
   * seven minutes and 32k tokens. Cut off here, the note falls back to a plain result line.
   */
  noteMaxTokens: number;
  /**
   * Merged, after `extraBody`, into the quick calls: the per-step note, the criteria, and executor
   * retries. A first attempt at code benefits from a thinking model's thinking; a three-sentence note
   * or "copy old_string exactly" does not — a thinking retry of one edit once ran for eight minutes.
   * (`noteExtraBody`, its earlier name, is still read.)
   */
  quickExtraBody?: Record<string, unknown>;
  /**
   * With `quickExtraBody` set, a first executor attempt gets this many tokens to think in, on top of
   * an estimate of its answer, instead of the whole `maxTokens`. Successful edits used 3.5–5k in total,
   * answer included; runaways used everything they were given (32k over eight minutes). Cut off, the
   * call is retried without thinking at full budget — which in the benchmark then succeeded.
   */
  thinkingAllowance: number;
  /**
   * When the executor thinks, with `quickExtraBody` set. `always`: every first attempt thinks.
   * `after-failure`: a first attempt skips thinking unless the last step failed or Jev calls the step
   * a repair, and a rejected quick attempt is retried with thinking. `jev`: Jev answers whether the
   * step needs careful reasoning, with the same retry. Thinking is most of the
   * executor's time, and most calls (the plain edit the brief already spells out) do not need it.
   */
  executorThinking: 'always' | 'after-failure' | 'jev';
  /** Extra headers, e.g. for a gateway that needs routing metadata. */
  headers: Record<string, string>;
  /** Milliseconds before an LLM request is aborted. */
  timeoutMs: number;
  /**
   * Characters of workspace context (file contents, recent tool output) the executor brief may
   * carry. Size it to the model's window: roughly 3–4 characters per token, and leave room for the
   * answer — a whole rewritten file comes back through `maxTokens`.
   */
  contextChars: number;
  /** Use the provider's mock executor instead of a real HTTP call. */
  mock: boolean;
  /**
   * Merged into every chat-completions request body, for runtime-specific switches. Qwen3 on a local
   * server thinks before every answer by default, and the hidden thinking is billed against
   * `maxTokens`; `{"chat_template_kwargs": {"enable_thinking": false}}` turns that off.
   */
  extraBody?: Record<string, unknown>;
}

/**
 * Which decision model routes the loop. `typesafe` is Jev, the hosted System One API; `laya` is
 * the Apache-2.0 model you host yourself through `sidecar/laya-server.py`; `mock` is the scripted
 * stand-in. The providers live in `src/core/deciders/`.
 */
export type DeciderProvider = 'typesafe' | 'laya' | 'mock';

export interface DeciderConfig {
  provider: DeciderProvider;
  /** Full endpoint, not a base URL: a System One request is a single POST target. */
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Retries on 429 / 529 / 5xx with exponential backoff. */
  maxRetries: number;
  /** Use the deterministic offline stand-in instead of a real server. */
  mock: boolean;
  /**
   * Merged into the request body, for provider-specific switches. The Laya sidecar reads
   * `head_max_len` and `max_len` from here, which is how a question with many options is given
   * enough room for its labels.
   */
  options?: Record<string, unknown>;
}

/** The previous name for {@link DeciderConfig}, kept so older configs and imports still resolve. */
export type JevConfig = DeciderConfig;

export interface AgentConfig {
  workspace: string;
  maxSteps: number;
  /** Below this confidence, Jev's pick is treated as a coin flip and re-routed. */
  minConfidence: number;
  /** At or above this probability, the goal counts as reached. */
  goalReachedThreshold: number;
  /** Progress score (0..4) that must accompany a goal-reached verdict. */
  minProgressScore: number;
  /** At or above this probability, an acceptance criterion counts as met. */
  criterionMetThreshold: number;
  /** At or above this probability, the agent stops and asks the user. */
  needsInputThreshold: number;
  /** At or above this probability, the loop is considered unproductive. */
  stuckThreshold: number;
  /**
   * Consecutive loop recoveries attempted before the agent hands back. The last rung of the
   * ladder always hands off to the user, so a value of 1 means "ask immediately".
   */
  maxRecoveries: number;
  /** Skip every approval prompt. */
  autoApprove: boolean;
  /**
   * The project's test command, run before finishing and once before the first step (unattended).
   * Unset: detected from the project (npm/pnpm/yarn, cargo, go, pytest, maven, gradle, dotnet, mix,
   * rspec, `make test`). `false`: never run tests automatically.
   */
  testCommand?: string | false;
  /** Permit reads and writes outside the workspace root. */
  allowOutsideWorkspace: boolean;
  /** Truncate observations fed back into Jev's state. */
  maxObservationChars: number;
  /** Bash timeout. */
  bashTimeoutMs: number;
  /** Persist transcripts under ~/.jeffrey/sessions. */
  saveSessions: boolean;
}

export interface Config {
  llm: LlmConfig;
  decider: DeciderConfig;
  agent: AgentConfig;
}

export const DEFAULT_CONFIG: Config = {
  llm: {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'not-needed',
    model: 'qwen2.5-coder:7b',
    temperature: 0.1,
    maxTokens: 4096,
    noteMaxTokens: 4096,
    thinkingAllowance: 2048,
    executorThinking: 'jev',
    headers: {},
    timeoutMs: 300_000,
    contextChars: 24_000,
    mock: false,
  },
  decider: {
    provider: 'typesafe',
    url: 'https://api.typesafe.ai/v1/systemone',
    apiKey: '',
    model: 'jev-latest',
    timeoutMs: 60_000,
    maxRetries: 3,
    mock: false,
  },
  agent: {
    workspace: process.cwd(),
    maxSteps: 24,
    minConfidence: 0.45,
    goalReachedThreshold: 0.5,
    minProgressScore: 3.5,
    criterionMetThreshold: 0.6,
    needsInputThreshold: 0.6,
    stuckThreshold: 0.7,
    maxRecoveries: 3,
    autoApprove: false,
    allowOutsideWorkspace: false,
    maxObservationChars: 4000,
    bashTimeoutMs: 120_000,
    saveSessions: true,
  },
};

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** A config layer. `jev` is what the `decider` section used to be called, and is still read. */
type ConfigLayer = DeepPartial<Config> & { jev?: Partial<DeciderConfig> };

export const GLOBAL_CONFIG_PATH = join(homedir(), '.jeffrey', 'config.json');
export const SESSIONS_DIR = join(homedir(), '.jeffrey', 'sessions');
export const PROJECT_CONFIG_NAME = 'jeffrey.config.json';

function readJson(path: string): ConfigLayer | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConfigLayer;
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${(error as Error).message}`);
  }
}

function fromEnv(env: NodeJS.ProcessEnv): ConfigLayer {
  const llm: Partial<LlmConfig> = {};
  const decider: Partial<DeciderConfig> = {};
  const agent: Partial<AgentConfig> = {};

  const str = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);
  const num = (value: string | undefined) => {
    const v = str(value);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const bool = (value: string | undefined) => {
    const v = str(value)?.toLowerCase();
    if (v === undefined) return undefined;
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  };

  const baseUrl = str(env['JEFFREY_LLM_BASE_URL']);
  if (baseUrl) llm.baseUrl = baseUrl;
  const llmKey = str(env['JEFFREY_LLM_API_KEY']);
  if (llmKey) llm.apiKey = llmKey;
  const llmModel = str(env['JEFFREY_LLM_MODEL']);
  if (llmModel) llm.model = llmModel;
  const llmTemp = num(env['JEFFREY_LLM_TEMPERATURE']);
  if (llmTemp !== undefined) llm.temperature = llmTemp;
  const llmMax = num(env['JEFFREY_LLM_MAX_TOKENS']);
  if (llmMax !== undefined) llm.maxTokens = llmMax;
  const llmContext = num(env['JEFFREY_LLM_CONTEXT_CHARS']);
  if (llmContext !== undefined) llm.contextChars = llmContext;
  const llmMock = bool(env['JEFFREY_LLM_MOCK']);
  if (llmMock !== undefined) llm.mock = llmMock;

  // The JEFFREY_JEV_* names predate the second provider and still work.
  const provider = str(env['JEFFREY_DECIDER']) ?? str(env['JEFFREY_DECIDER_PROVIDER']);
  if (provider) {
    if (!isProvider(provider)) throw new Error(`Unknown decider provider: ${provider}`);
    decider.provider = provider;
  }
  const deciderKey =
    str(env['JEFFREY_DECIDER_API_KEY']) ?? str(env['TYPESAFE_API_KEY']) ?? str(env['JEFFREY_JEV_API_KEY']);
  if (deciderKey) decider.apiKey = deciderKey;
  const deciderUrl = str(env['JEFFREY_DECIDER_URL']) ?? str(env['JEFFREY_JEV_URL']);
  if (deciderUrl) decider.url = deciderUrl;
  const deciderModel = str(env['JEFFREY_DECIDER_MODEL']) ?? str(env['JEFFREY_JEV_MODEL']);
  if (deciderModel) decider.model = deciderModel;
  const deciderMock = bool(env['JEFFREY_DECIDER_MOCK']) ?? bool(env['JEFFREY_JEV_MOCK']);
  if (deciderMock !== undefined) decider.mock = deciderMock;

  const maxSteps = num(env['JEFFREY_MAX_STEPS']);
  if (maxSteps !== undefined) agent.maxSteps = maxSteps;
  const maxRecoveries = num(env['JEFFREY_MAX_RECOVERIES']);
  if (maxRecoveries !== undefined) agent.maxRecoveries = maxRecoveries;
  const yolo = bool(env['JEFFREY_AUTO_APPROVE']);
  if (yolo !== undefined) agent.autoApprove = yolo;
  const saveSessions = bool(env['JEFFREY_SAVE_SESSIONS']);
  if (saveSessions !== undefined) agent.saveSessions = saveSessions;

  return { llm, decider, agent };
}

export interface ConfigOverrides extends DeepPartial<Config> {
  /** Path to an explicit config file, replacing the project/global lookup. */
  configPath?: string;
  /** Legacy name for `decider`. */
  jev?: Partial<DeciderConfig>;
}

export interface LoadedConfig {
  config: Config;
  /** Files that actually contributed values, in increasing precedence. */
  sources: string[];
}

export function loadConfig(overrides: ConfigOverrides = {}, env = process.env): LoadedConfig {
  const sources: string[] = [];
  const layers: ConfigLayer[] = [DEFAULT_CONFIG as ConfigLayer];

  if (overrides.configPath) {
    const explicit = readJson(resolve(overrides.configPath));
    if (!explicit) throw new Error(`Config file not found: ${overrides.configPath}`);
    layers.push(explicit);
    sources.push(resolve(overrides.configPath));
  } else {
    const global = readJson(GLOBAL_CONFIG_PATH);
    if (global) {
      // The workspace is where jeffrey was started. A global value would pin every run to one
      // directory — `--init` used to write the cwd it ran in, which sent every later run there.
      if (global.agent) delete global.agent.workspace;
      layers.push(global);
      sources.push(GLOBAL_CONFIG_PATH);
    }
    const project = readJson(join(process.cwd(), PROJECT_CONFIG_NAME));
    if (project) {
      layers.push(project);
      sources.push(join(process.cwd(), PROJECT_CONFIG_NAME));
    }
  }

  const fromEnvironment = fromEnv(env);
  if (Object.keys(fromEnvironment.llm ?? {}).length) sources.push('environment');
  layers.push(fromEnvironment);
  layers.push(overrides);

  const merged: Config = {
    llm: { ...DEFAULT_CONFIG.llm },
    decider: { ...DEFAULT_CONFIG.decider },
    agent: { ...DEFAULT_CONFIG.agent },
  };
  // Which decider values a layer actually named, so switching provider can fill in the rest: a
  // laya run must not keep pointing at the TypeSafe endpoint just because that is the default.
  const named = new Set<string>();
  for (const layer of layers) {
    if (layer.llm) Object.assign(merged.llm, layer.llm);
    const decider = { ...(layer.jev ?? {}), ...(layer.decider ?? {}) };
    if (layer !== layers[0]) for (const key of Object.keys(decider)) named.add(key);
    Object.assign(merged.decider, decider);
    if (layer.agent) Object.assign(merged.agent, layer.agent);
  }

  if (!isProvider(merged.decider.provider)) {
    throw new Error(
      `Unknown decider provider: ${merged.decider.provider}. Known: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  for (const [key, value] of Object.entries(PROVIDERS[merged.decider.provider].defaults)) {
    if (!named.has(key)) (merged.decider as unknown as Record<string, unknown>)[key] = value;
  }

  merged.agent.workspace = resolve(merged.agent.workspace);
  const legacy = (merged.llm as { noteExtraBody?: Record<string, unknown> }).noteExtraBody;
  if (legacy && !merged.llm.quickExtraBody) merged.llm.quickExtraBody = legacy;
  delete (merged.llm as { noteExtraBody?: unknown }).noteExtraBody;
  merged.llm.baseUrl = normalizeBaseUrl(merged.llm.baseUrl);

  return { config: merged, sources };
}

/** Accept `host`, `host/v1`, or a full `.../chat/completions` URL and return the base. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/chat\/completions$/, '');
  return url;
}

/** Redact anything that looks like a credential before it reaches the screen or a log file. */
export function redact(secret: string): string {
  if (!secret) return '(unset)';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-3)}`;
}

export function configPaths(): { global: string; project: string } {
  return {
    global: GLOBAL_CONFIG_PATH,
    project: join(process.cwd(), PROJECT_CONFIG_NAME),
  };
}

/** Write a starter config so `jeffrey --init` has something to point at. */
export function writeStarterConfig(path: string, config: Config): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const { workspace: _workspace, ...agent } = config.agent;
  writeFileSync(path, `${JSON.stringify({ ...config, agent }, null, 2)}\n`, 'utf8');
}
