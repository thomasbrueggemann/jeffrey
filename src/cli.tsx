#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import React from 'react';
import { render } from 'ink';
import {
  configPaths,
  loadConfig,
  redact,
  writeStarterConfig,
  DEFAULT_CONFIG,
  type Config,
  type ConfigOverrides,
} from './config.js';
import { createLlmClient } from './core/llm.js';
import type { DecisionModel } from './core/decision.js';
import {
  PROVIDERS,
  createDecisionModel,
  isProvider,
  listDecisionModels,
  MockDecider,
  type MockScript,
} from './core/deciders/index.js';
import { Agent, type ToolMode } from './core/agent.js';
import { SessionLog } from './core/session-log.js';
import { App, type Runner } from './ui/App.js';
import { setDeciderName } from './ui/components.js';
import type { AgentEvent, ApprovalRequest, ApprovalResponse, Budget, JevDecision } from './types.js';

const VERSION = readVersion();
export const DEFAULT_MOCK_TOOLS = ['list_dir', 'read_file', 'write_file', 'run_shell'];

interface Flags {
  goal: string;
  cwd?: string;
  configPath?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  decider?: string;
  jevUrl?: string;
  jevKey?: string;
  jevModel?: string;
  maxSteps?: number;
  maxRecoveries?: number;
  yes: boolean;
  explain: boolean;
  narrate: boolean;
  toolMode: ToolMode;
  print: boolean;
  json: boolean;
  dryRun: boolean;
  jevMock?: string[];
  jevMockScript?: MockScript;
  llmMock: boolean;
  init: boolean;
  showConfig: boolean;
  listModels: boolean;
  help: boolean;
  version: boolean;
}

const HELP = `
  jeffrey — a decision model decides, a local LLM writes the code.

  Usage
    $ jeffrey [goal] [options]

    Goal is optional. Without it the TUI opens and you type one; with it the run
    starts immediately. Piping stdin or passing --print runs headless.

  Decider (which model picks the next action)
    --decider <provider>     typesafe (Jev, hosted) | laya (self-hosted) | mock
                                                           [JEFFREY_DECIDER]
    --jev-url <url>          Endpoint for the chosen provider  [JEFFREY_DECIDER_URL]
    --jev-key <key>          API key, when the provider needs one
                                                           [TYPESAFE_API_KEY]
    --jev-model <name>       Model name, e.g. jev-latest or, for laya, router
    --jev-mock[=a,b,c]       Offline scripted decider, no server needed
    --jev-mock-script <json> Full MockScript, e.g. '{"tools":["read_file"],
                             "stuck":0.91,"stuckFromStep":4}' to replay a loop

    Laya runs beside jeffrey, not in it: start sidecar/laya-server.py first.
    See docs/deciders.md.

  Executor (any OpenAI-compatible server)
    --base-url <url>         e.g. http://localhost:11434/v1  [JEFFREY_LLM_BASE_URL]
    --api-key <key>          Sentinel is fine for local servers
    --model <name>           e.g. qwen2.5-coder:7b
    --temperature <n>        Default 0.1
    --max-tokens <n>
    --tool-mode <forced|prompt>
                             forced = native tool calls, prompt = JSON fallback
    --no-narrate             Skip the executor's one-line report after each tool

  Agent
    -C, --cwd <dir>          Workspace root (default: current directory)
    --config <path>          Explicit config file
    --max-steps <n>          Step ceiling, default 24
    --max-recoveries <n>     Loop recoveries before handing back to you, default 3
    -y, --yes                Auto-approve every mutating tool
    --dry-run                Deny every mutating tool (also denies in --print mode)
    --explain                Show probability legends and the full decision

  Output
    --print                  Headless transcript on stdout, no TUI
    --json                   One JSON object per event (implies --print)

  In the TUI
    /exit                    Leave the session (also /quit, /q)
    ctrl-c                   Leave, or abort the running step
    esc                      Abort the running step

  Setup
    --init                   Write a starter config to ~/.jeffrey/config.json
    --show-config            Print the effective config with secrets redacted
    --list-models            List the models the chosen provider offers
    -h, --help
    -v, --version

  Config is layered: defaults < ~/.jeffrey/config.json < ./jeffrey.config.json
  < environment < flags. Keys: llm / decider / agent, same names as the flags.
  The old section name "jev" is still read.
`;

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ argument parsing */

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    goal: '',
    yes: false,
    explain: false,
    narrate: true,
    toolMode: 'forced',
    print: false,
    json: false,
    dryRun: false,
    llmMock: false,
    init: false,
    showConfig: false,
    listModels: false,
    help: false,
    version: false,
  };
  const goal: string[] = [];

  const need = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) fail(`${name} needs a value`);
    return value;
  };
  const number = (raw: string, name: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value)) fail(`${name} must be a number, got ${raw}`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    const [flag, inline] = raw.startsWith('--') && raw.includes('=') ? splitOnce(raw, '=') : [raw, undefined];
    const value = (name: string): string => inline ?? need(i++, name);

    switch (flag) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-v':
      case '--version':
        flags.version = true;
        break;
      case '-C':
      case '--cwd':
      case '--workspace':
        flags.cwd = value(flag);
        break;
      case '--config':
        flags.configPath = value(flag);
        break;
      case '--base-url':
        flags.baseUrl = value(flag);
        break;
      case '--api-key':
        flags.apiKey = value(flag);
        break;
      case '--model':
        flags.model = value(flag);
        break;
      case '--temperature':
        flags.temperature = number(value(flag), flag);
        break;
      case '--max-tokens':
        flags.maxTokens = number(value(flag), flag);
        break;
      case '--decider':
      case '--decider-provider':
        flags.decider = value(flag);
        break;
      case '--jev-url':
        flags.jevUrl = value(flag);
        break;
      case '--jev-key':
        flags.jevKey = value(flag);
        break;
      case '--jev-model':
        flags.jevModel = value(flag);
        break;
      case '--max-steps':
        flags.maxSteps = number(value(flag), flag);
        break;
      case '--max-recoveries':
        flags.maxRecoveries = number(value(flag), flag);
        break;
      case '--tool-mode': {
        const mode = value(flag);
        if (mode !== 'forced' && mode !== 'prompt') fail('--tool-mode must be forced or prompt');
        flags.toolMode = mode;
        break;
      }
      case '-y':
      case '--yes':
      case '--auto-approve':
        flags.yes = true;
        break;
      case '--no-narrate':
        flags.narrate = false;
        break;
      case '--explain':
        flags.explain = true;
        break;
      case '--print':
        flags.print = true;
        break;
      case '--json':
        flags.json = true;
        flags.print = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--llm-mock':
        flags.llmMock = true;
        break;
      case '--jev-mock': {
        // Inline only, per the documented `--jev-mock[=a,b,c]`. A space-separated value would eat
        // the goal, which reads as "no goal given" rather than as a parse error.
        flags.jevMock = inline ? inline.split(',').map((name) => name.trim()).filter(Boolean) : DEFAULT_MOCK_TOOLS;
        break;
      }
      case '--jev-mock-script': {
        const json = inline === undefined && argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i] : inline;
        if (!json) fail('--jev-mock-script needs a JSON object');
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (error) {
          fail(`--jev-mock-script is not valid JSON: ${(error as Error).message}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail('--jev-mock-script must be a JSON object, e.g. \'{"tools":["read_file"],"stuck":0.91}\'');
        }
        flags.jevMockScript = parsed as MockScript;
        break;
      }
      case '--init':
        flags.init = true;
        break;
      case '--show-config':
        flags.showConfig = true;
        break;
      case '--list-models':
        flags.listModels = true;
        break;
      default:
        if (raw.startsWith('-') && raw !== '-') fail(`unknown flag ${raw} (try --help)`);
        goal.push(raw);
    }
  }

  if (flags.cwd) {
    const target = resolve(flags.cwd);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      fail(`--cwd ${flags.cwd} is not a directory`);
    }
    process.chdir(target);
    // Resolved once, before the chdir: resolving a relative --cwd again afterwards lands elsewhere.
    flags.cwd = target;
  }
  flags.goal = goal.join(' ').trim();
  return flags;
}

function splitOnce(input: string, separator: string): [string, string] {
  const index = input.indexOf(separator);
  return [input.slice(0, index), input.slice(index + separator.length)];
}

/* ------------------------------------------------------------------ wiring */

export interface Session {
  config: Config;
  jevLabel: string;
  /** Short name of the decision model in use — JEV, LAYA — for the header and the step panel. */
  deciderName: string;
  llmLabel: string;
  runner: Runner;
  mockJev?: MockDecider;
  /** The transcript for this session, or undefined when `agent.saveSessions` is off. */
  log?: SessionLog;
}

function deciderOverrides(flags: Flags): ConfigOverrides {
  const decider: ConfigOverrides['decider'] = {};
  if (flags.decider) {
    if (!isProvider(flags.decider)) {
      fail(`unknown --decider ${flags.decider}. Known: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    decider.provider = flags.decider;
  }
  if (flags.jevUrl) decider.url = flags.jevUrl;
  if (flags.jevKey) decider.apiKey = flags.jevKey;
  if (flags.jevModel) decider.model = flags.jevModel;
  if (flags.jevMock || flags.jevMockScript) decider.mock = true;
  return { decider };
}

/** Every flag that can move a config value, in one place — `--show-config` must not lie about the run. */
export function configOverrides(flags: Flags): ConfigOverrides {
  const overrides: ConfigOverrides = deciderOverrides(flags);
  if (flags.configPath) overrides.configPath = flags.configPath;

  const llm: ConfigOverrides['llm'] = {};
  if (flags.baseUrl) llm.baseUrl = flags.baseUrl;
  if (flags.apiKey) llm.apiKey = flags.apiKey;
  if (flags.model) llm.model = flags.model;
  if (flags.temperature !== undefined) llm.temperature = flags.temperature;
  if (flags.maxTokens !== undefined) llm.maxTokens = flags.maxTokens;
  if (flags.llmMock) llm.mock = true;
  if (Object.keys(llm).length) overrides.llm = llm;

  const agent: ConfigOverrides['agent'] = {};
  if (flags.cwd) agent.workspace = flags.cwd;
  if (flags.maxSteps !== undefined) agent.maxSteps = flags.maxSteps;
  if (flags.maxRecoveries !== undefined) agent.maxRecoveries = flags.maxRecoveries;
  if (flags.yes) agent.autoApprove = true;
  if (Object.keys(agent).length) overrides.agent = agent;

  return overrides;
}

export function buildSession(flags: Flags): Session {
  const overrides = configOverrides(flags);

  const { config } = loadConfig(overrides);

  const script: MockScript = flags.jevMockScript ?? { tools: flags.jevMock ?? DEFAULT_MOCK_TOOLS };
  const useMock = Boolean(flags.jevMockScript || flags.jevMock);
  const mockJev = useMock ? new MockDecider(script) : undefined;
  const log = config.agent.saveSessions ? new SessionLog() : undefined;
  const rawJev: DecisionModel = mockJev ?? createDecisionModel(config.decider);
  const jev = log ? log.wrapDecider(rawJev) : rawJev;
  const llmLabel = config.llm.mock
    ? 'mock-executor'
    : `${config.llm.model} · ${config.llm.baseUrl.replace(/^https?:\/\//, '')}`;
  log?.start({ version: VERSION, config, jevLabel: jev.label, llmLabel });

  const runner: Runner = async (goal, options) => {
    log?.goal(goal);
    const llm = createLlmClient(config.llm);
    const agent = new Agent({
      goal,
      config,
      llm: log ? log.wrapLlm(llm) : llm,
      jev,
      onEvent: log
        ? (event) => {
            log.event(event);
            options.onEvent(event);
          }
        : options.onEvent,
      approve: log ? log.wrapApprove(options.approve) : options.approve,
      signal: options.signal,
      toolMode: flags.toolMode,
      narrate: flags.narrate,
    });
    try {
      await agent.run();
    } catch (error) {
      log?.failure(error);
      throw error;
    }
  };

  return {
    config,
    jevLabel: jev.label,
    deciderName: rawJev.provider === 'typesafe' ? 'JEV' : rawJev.provider.toUpperCase(),
    llmLabel,
    runner,
    ...(mockJev ? { mockJev } : {}),
    ...(log ? { log } : {}),
  };
}

/* ------------------------------------------------------------------ headless output */

const plain = (text: string) => process.stdout.write(`${text}\n`);

function decisionLine(decision: JevDecision): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `◆ jev -> ${decision.tool}`,
    `[${decision.route}]`,
    `confidence ${percent(decision.confidence)}`,
    `progress ${decision.progress.toFixed(2)}/4`,
    `goal? ${percent(decision.goalReached)}`,
    decision.stuck > 0.5 ? `stuck ${percent(decision.stuck)}` : '',
    decision.needsUserInput > 0.5 ? `needs-you ${percent(decision.needsUserInput)}` : '',
  ]
    .filter(Boolean)
    .join('  ');
}

function summariseArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const flat = String(text).replace(/\s+/g, ' ');
      return `${key}=${flat.length > 60 ? `${flat.slice(0, 57)}…` : flat}`;
    })
    .join(' ');
}

function budgetLine(budget: Budget): string {
  return `budget: ${budget.jevCalls} jev calls · ${budget.llmCalls} executor calls · ${budget.steps} steps · ${
    budget.jevInputTokens + budget.llmPromptTokens + budget.llmCompletionTokens
  } tokens`;
}

/**
 * Plain-text renderer for `--print` / `--json`. Streaming text is cumulative, so each channel keeps
 * its latest text and is flushed once, when the next non-stream event arrives.
 */
export function createPrinter(write = plain): {
  onEvent: (event: AgentEvent) => void;
  finish: () => number;
} {
  let reason = 'error';
  let summary = '';
  let budget: Budget | undefined;
  const pending = new Map<string, string>();

  const flush = () => {
    for (const [channel, text] of pending) {
      const flat = text.replace(/\s+/g, ' ').trim();
      if (!flat) continue;
      const clipped = flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
      write(channel === 'narration' ? `   ${clipped}` : `   reasoning: ${clipped}`);
    }
    pending.clear();
  };

  const onEvent = (event: AgentEvent) => {
    if (event.type === 'llm-stream') {
      pending.set(event.channel, event.text);
      return;
    }
    flush();

    switch (event.type) {
      case 'phase':
        break;
      case 'decision':
        write(decisionLine(event.decision));
        break;
      case 'llm-context':
        write(`   context: ${event.paths.join(', ')}${event.why ? ` — ${event.why}` : ''}`);
        break;
      case 'tool-call':
        write(`-> ${event.tool} ${summariseArgs(event.args)}${event.fromFallback ? '  [fallback]' : ''}`);
        break;
      case 'observation': {
        write(`   ${event.ok ? 'ok' : 'failed'}: ${event.summary}`);
        if (event.diff) {
          for (const line of event.diff.split('\n').slice(0, 40)) write(`   │ ${line}`);
        }
        break;
      }
      case 'notice':
        write(`   ${event.level}: ${event.message}`);
        break;
      case 'budget':
        budget = event.budget;
        break;
      case 'criteria': {
        const met = event.criteria.filter((criterion) => criterion.met).length;
        write(`   ${event.step === 0 ? 'done means' : 'criteria'}: ${met}/${event.criteria.length} met`);
        for (const criterion of event.criteria) {
          if (event.step === 0 || event.changed.includes(criterion.id)) {
            write(`     [${criterion.met ? 'x' : ' '}] ${criterion.id}. ${criterion.text}`);
          }
        }
        break;
      }
      case 'done':
        reason = event.reason;
        summary = event.summary;
        budget = event.budget;
        break;
    }
  };

  const finish = (): number => {
    flush();
    write('');
    write(`${reason === 'goal-reached' ? '✔' : '■'} ${reason}${summary ? ` — ${summary}` : ''}`);
    if (budget) write(budgetLine(budget));
    return reason === 'goal-reached' || reason === 'finished' ? 0 : 1;
  };

  return { onEvent, finish };
}

/* ------------------------------------------------------------------ entry */

export async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flags.init) {
    const target = configPaths().global;
    writeStarterConfig(target, DEFAULT_CONFIG);
    process.stdout.write(`wrote ${target}\n`);
    return;
  }
  if (flags.listModels) {
    const { config } = loadConfig(configOverrides(flags));
    const models = await listDecisionModels(config.decider);
    for (const model of models) process.stdout.write(`${model.name}\t${model.release_date}\t${model.description}\n`);
    return;
  }
  if (flags.showConfig) {
    const { config, sources } = loadConfig(configOverrides(flags));
    process.stdout.write(
      `${JSON.stringify(
        {
          sources,
          llm: { ...config.llm, apiKey: redact(config.llm.apiKey) },
          decider: { ...config.decider, apiKey: redact(config.decider.apiKey) },
          agent: config.agent,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const { config, jevLabel, deciderName, llmLabel, runner, log } = buildSession(flags);
  setDeciderName(deciderName);
  const headless = flags.print || !process.stdout.isTTY;

  if (headless) {
    if (!config.decider.mock && PROVIDERS[config.decider.provider].needsApiKey && !config.decider.apiKey) {
      fail(
        `no API key for the ${config.decider.provider} decider. Set TYPESAFE_API_KEY, run with ` +
          '--decider laya for a self-hosted one, or --jev-mock for an offline dry run.',
      );
    }
    const goal = flags.goal || (await readStdinGoal());
    if (!goal) fail('no goal given. Pass one as an argument, or pipe it on stdin.');

    const printer = createPrinter();
    const emit = flags.json
      ? (event: AgentEvent) => process.stdout.write(`${JSON.stringify(event)}\n`)
      : printer.onEvent;
    const approve = async (request: ApprovalRequest): Promise<ApprovalResponse> => {
      // Emit through the event stream so `--json` stays parseable (raw stdout writes would corrupt it)
      // and the question is visible in both text and JSON output.
      if (flags.dryRun) {
        emit({ type: 'notice', level: 'warn', message: `denied ${request.tool} (--dry-run)` });
        return 'deny';
      }
      if (request.question) {
        emit({ type: 'notice', level: 'info', message: `question for you: ${request.question}` });
      }
      // Headless mode has no one to type an answer, so the request is surfaced and then continued on.
      // The agent sees the continuation note rather than a fabricated answer.
      emit({ type: 'notice', level: 'info', message: `auto-allowed ${request.tool} (headless mode)` });
      return 'allow';
    };
    const jsonPrinter = emit;

    await runner(goal, { onEvent: jsonPrinter, approve, signal: new AbortController().signal });
    const code = flags.json ? 0 : printer.finish();
    // stderr, so `--json` on stdout stays parseable.
    if (log) process.stderr.write(`session log: ${log.path}\n`);
    process.exitCode = code;
    return;
  }

  const { waitUntilExit } = render(
    <App
      workspace={config.agent.workspace}
      version={VERSION}
      llmLabel={llmLabel}
      jevLabel={jevLabel}
      deciderName={deciderName}
      maxSteps={config.agent.maxSteps}
      explain={flags.explain}
      initialGoal={flags.goal || undefined}
      runner={runner}
      onExit={() => {}}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

async function readStdinGoal(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Only auto-run when this module *is* the entry point (e.g. `node dist/cli.js`), so tests can
 * import `parseArgs`/`buildSession` without kicking off a session. The published `bin/jeffrey.js`
 * is a separate file, so it calls `main()` itself rather than relying on this guard.
 */
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  });
}
