import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LlmConfig {
  /** OpenAI-compatible base URL. `http://localhost:11434/v1`, `http://127.0.0.1:8080/v1`, ... */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** Extra headers, e.g. for a gateway that needs routing metadata. */
  headers: Record<string, string>;
  /** Milliseconds before an LLM request is aborted. */
  timeoutMs: number;
  /** Use the provider's mock executor instead of a real HTTP call. */
  mock: boolean;
}

export interface JevConfig {
  /** Full endpoint, not a base URL: the System One endpoint is a single POST target. */
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Retries on 429 / 529 / 5xx with exponential backoff. */
  maxRetries: number;
  /** Use the deterministic offline stand-in instead of the real API. */
  mock: boolean;
}

export interface AgentConfig {
  workspace: string;
  maxSteps: number;
  /** Below this confidence, Jev's pick is treated as a coin flip and re-routed. */
  minConfidence: number;
  /** At or above this probability, the goal counts as reached. */
  goalReachedThreshold: number;
  /** Progress score (0..4) that must accompany a goal-reached verdict. */
  minProgressScore: number;
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
  jev: JevConfig;
  agent: AgentConfig;
}

export const DEFAULT_CONFIG: Config = {
  llm: {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'not-needed',
    model: 'qwen2.5-coder:7b',
    temperature: 0.1,
    maxTokens: 4096,
    headers: {},
    timeoutMs: 300_000,
    mock: false,
  },
  jev: {
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

export const GLOBAL_CONFIG_PATH = join(homedir(), '.jeffrey', 'config.json');
export const PROJECT_CONFIG_NAME = 'jeffrey.config.json';

function readJson(path: string): DeepPartial<Config> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DeepPartial<Config>;
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${(error as Error).message}`);
  }
}

function fromEnv(env: NodeJS.ProcessEnv): DeepPartial<Config> {
  const llm: Partial<LlmConfig> = {};
  const jev: Partial<JevConfig> = {};
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
  const llmMock = bool(env['JEFFREY_LLM_MOCK']);
  if (llmMock !== undefined) llm.mock = llmMock;

  const jevKey = str(env['TYPESAFE_API_KEY']) ?? str(env['JEFFREY_JEV_API_KEY']);
  if (jevKey) jev.apiKey = jevKey;
  const jevUrl = str(env['JEFFREY_JEV_URL']);
  if (jevUrl) jev.url = jevUrl;
  const jevModel = str(env['JEFFREY_JEV_MODEL']);
  if (jevModel) jev.model = jevModel;
  const jevMock = bool(env['JEFFREY_JEV_MOCK']);
  if (jevMock !== undefined) jev.mock = jevMock;

  const maxSteps = num(env['JEFFREY_MAX_STEPS']);
  if (maxSteps !== undefined) agent.maxSteps = maxSteps;
  const maxRecoveries = num(env['JEFFREY_MAX_RECOVERIES']);
  if (maxRecoveries !== undefined) agent.maxRecoveries = maxRecoveries;
  const yolo = bool(env['JEFFREY_AUTO_APPROVE']);
  if (yolo !== undefined) agent.autoApprove = yolo;

  return { llm, jev, agent };
}

export interface ConfigOverrides extends DeepPartial<Config> {
  /** Path to an explicit config file, replacing the project/global lookup. */
  configPath?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Files that actually contributed values, in increasing precedence. */
  sources: string[];
}

export function loadConfig(overrides: ConfigOverrides = {}, env = process.env): LoadedConfig {
  const sources: string[] = [];
  const layers: DeepPartial<Config>[] = [DEFAULT_CONFIG as DeepPartial<Config>];

  if (overrides.configPath) {
    const explicit = readJson(resolve(overrides.configPath));
    if (!explicit) throw new Error(`Config file not found: ${overrides.configPath}`);
    layers.push(explicit);
    sources.push(resolve(overrides.configPath));
  } else {
    const global = readJson(GLOBAL_CONFIG_PATH);
    if (global) {
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
    jev: { ...DEFAULT_CONFIG.jev },
    agent: { ...DEFAULT_CONFIG.agent },
  };
  for (const layer of layers) {
    if (layer.llm) Object.assign(merged.llm, layer.llm);
    if (layer.jev) Object.assign(merged.jev, layer.jev);
    if (layer.agent) Object.assign(merged.agent, layer.agent);
  }

  merged.agent.workspace = resolve(merged.agent.workspace);
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
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
