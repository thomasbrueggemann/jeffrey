#!/usr/bin/env node
/**
 * Jeffrey vs. OpenCode on the same local model and the same tasks, each run in a fresh copy of the
 * task's seed project.
 *
 *   node bench/compare.mjs [--task a,b] [--runs 1] [--only jeffrey|opencode] [--timeout-min 45] [--no-think]
 *   node bench/compare.mjs --verify      check every task's hidden tests against its seed and reference
 *
 * Measures wall time, model-server tokens (metered by bench/proxy.mjs, so both tools are counted the
 * same way, thinking included), Jev tokens for Jeffrey, and scores the work with the task's hidden
 * tests (bench/tasks.mjs).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from './proxy.mjs';
import { listTasks, loadTask, prepare, score, verify } from './tasks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const args = parseArgs(process.argv.slice(2));
const taskNames = args.task ? args.task.split(',') : listTasks();
const tasks = await Promise.all(taskNames.map((name) => loadTask(name)));

if (args.verify === 'true') {
  const scratch = join(realpathSync(tmpdir()), 'jeffrey-bench-verify', String(Date.now()));
  let broken = 0;
  for (const task of tasks) {
    const result = verify(task, scratch);
    if (!result) continue;
    const ok = result.seedFails && result.referencePasses && !result.referenceFailures.length;
    if (!ok) broken += 1;
    console.log(`${ok ? '✔' : '✖'} ${task.name}: seed passes ${result.seedHidden} hidden, reference ${result.referenceHidden}${result.referenceFailures.length ? ` — reference fails: ${result.referenceFailures.join('; ')}` : ''}`);
  }
  process.exit(broken ? 1 : 0);
}

const jeffreyConfig = JSON.parse(readFileSync(join(homedir(), '.jeffrey', 'config.json'), 'utf8'));
const model = args.model ?? jeffreyConfig.llm.model;
const apiKey = jeffreyConfig.llm.apiKey || 'not-needed';
const maxTokens = jeffreyConfig.llm.maxTokens;
const upstream = args.upstream ?? 'http://127.0.0.1:8000';
const port = Number(args.port ?? 8100);
const timeoutMs = Number(args['timeout-min'] ?? 45) * 60_000;
const runners = args.only ? [args.only] : ['jeffrey', 'opencode'];
const runs = Number(args.runs ?? 1);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = realpathSync(tmpdir());
const benchDir = join(root, 'jeffrey-bench', stamp);
mkdirSync(benchDir, { recursive: true });
const meterLog = join(benchDir, 'meter.jsonl');
const noThink = args['no-think'] === 'true';
const proxy = await startProxy({
  upstream,
  port,
  logFile: meterLog,
  ...(noThink ? { inject: { chat_template_kwargs: { enable_thinking: false } } } : {}),
});
const proxyBase = (tag) => `http://127.0.0.1:${port}/t/${tag}/v1`;

console.log(`model ${model}${noThink ? ' (thinking off)' : ''} · max output ${maxTokens} · tasks ${taskNames.join(', ')} · runs ${runs} · work in ${benchDir}\n`);

const listing = () => new Set(readdirSync(process.cwd()));
const strayBefore = listing();
const results = [];
for (const task of tasks) {
  for (let n = 1; n <= runs; n++) {
    for (const runner of runners) {
      const tag = `${task.name}.${runner}-${n}`;
      const dir = join(benchDir, tag);
      prepare(task, dir);
      process.stdout.write(`▶ ${tag} … `);
      const started = Date.now();
      const exit = await (runner === 'jeffrey' ? runJeffrey(dir, tag, task.prompt) : runOpencode(dir, tag, task.prompt));
      const seconds = (Date.now() - started) / 1000;
      const tokens = meterFor(tag);
      const jev = runner === 'jeffrey' ? jevTokens(dir, started) : undefined;
      const scored = score(task, dir);
      const strays = [...listing()].filter((name) => !strayBefore.has(name));
      if (strays.length) console.log(`\n  ! ${runner} wrote ${strays.join(', ')} into ${process.cwd()} instead of its own folder`);
      const result = { task: task.name, runner, run: n, dir, exit, seconds, ...tokens, jev, score: scored };
      results.push(result);
      console.log(`${fmtTime(seconds)} · ${tokens.requests} requests · ${fmt(tokens.promptTokens + tokens.completionTokens)} tokens (${fmt(tokens.promptTokens - tokens.cachedTokens + tokens.completionTokens)} uncached) · checks ${scored.passed}/${scored.total}${exit.timedOut ? ' · TIMED OUT' : ''}`);
    }
  }
}
proxy.close();

const report = render(results);
writeFileSync(join(benchDir, 'results.json'), JSON.stringify({ tasks: taskNames, model, maxTokens, noThink, results }, null, 2));
writeFileSync(join(benchDir, 'report.md'), report);
console.log(`\n${report}\nresults: ${join(benchDir, 'results.json')}`);

/* ---------------------------------------------------------------- runners */

function runJeffrey(dir, tag, prompt) {
  return run(process.execPath, [join(repo, 'bin', 'jeffrey.js'), '--print', '--yes', prompt], {
    cwd: dir,
    env: { ...process.env, JEFFREY_LLM_BASE_URL: proxyBase(tag), JEFFREY_AUTO_APPROVE: 'true' },
    log: join(dir, '..', `${tag}.log`),
  });
}

function runOpencode(dir, tag, prompt) {
  // Its own config home: the user's global config brings MCP servers (more tools, more prompt
  // tokens) and a different default model, which would not be a like-for-like comparison.
  const home = join(dir, '..', `${tag}-home`);
  mkdirSync(join(home, 'config', 'opencode'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'opencode', 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: `bench/${model}`,
        permission: { '*': 'allow' },
        autoupdate: false,
        share: 'disabled',
        provider: {
          bench: {
            npm: '@ai-sdk/openai-compatible',
            name: 'bench',
            options: { baseURL: proxyBase(tag), apiKey },
            models: {
              [model]: {
                name: model,
                limit: { context: 262144, output: maxTokens },
                tool_call: true,
                reasoning: true,
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return run('opencode', ['run', '--auto', '--dir', dir, '-m', `bench/${model}`, prompt], {
    cwd: dir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      // No ~/.claude/CLAUDE.md or skills leaking in as rules.
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
    },
    log: join(dir, '..', `${tag}.log`),
  });
}

function run(command, argv, { cwd, env, log }) {
  return new Promise((resolve) => {
    const out = createWriteStream(log);
    // PWD too: opencode takes its project folder from $PWD, not the process cwd, and without this it
    // wrote the whole app into the directory the benchmark was started from.
    const child = spawn(command, argv, { cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out.end();
      resolve({ code, signal, timedOut, log });
    });
  });
}

/* ---------------------------------------------------------------- metering */

function meterFor(tag) {
  const records = existsSync(meterLog)
    ? readFileSync(meterLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.tag === tag)
    : [];
  return {
    requests: records.length,
    promptTokens: records.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0),
    completionTokens: records.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0),
    cachedTokens: records.reduce((sum, r) => sum + (r.cachedTokens ?? 0), 0),
    unmetered: records.filter((r) => !r.metered).length,
    truncated: records.filter((r) => r.finish === 'length').length,
    modelSeconds: records.reduce((sum, r) => sum + (r.ms ?? 0), 0) / 1000,
  };
}

/** Jev is remote, so the proxy never sees it; its usage is in Jeffrey's own session log. */
function jevTokens(dir, since) {
  const sessions = join(homedir(), '.jeffrey', 'sessions');
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };
  for (const name of readdirSync(sessions)) {
    const path = join(sessions, name);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const start = lines.length ? JSON.parse(lines[0]) : undefined;
    if (!start || start.cwd !== dir || Date.parse(start.ts) < since - 1000) continue;
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.type !== 'jev-response') continue;
      totals.calls += 1;
      totals.inputTokens += record.response?.usage?.input_tokens ?? 0;
      totals.outputTokens += record.response?.usage?.output_tokens ?? 0;
    }
  }
  return totals;
}

/* ---------------------------------------------------------------- report */

function render(results) {
  const lines = [`# Jeffrey vs OpenCode — ${model}${noThink ? ' (thinking off for both)' : ''}`, ''];

  // The headline: per runner, summed over every task and run.
  lines.push('| runner | runs | total time | local LLM tokens | uncached local tokens | Jev tokens | checks passed |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const runner of runners) {
    const mine = results.filter((r) => r.runner === runner);
    const sum = (f) => mine.reduce((total, r) => total + f(r), 0);
    lines.push(
      `| ${runner} | ${mine.length} | ${fmtTime(sum((r) => r.seconds))} | ${fmt(sum((r) => r.promptTokens + r.completionTokens))} | ${fmt(sum((r) => r.promptTokens - (r.cachedTokens ?? 0) + r.completionTokens))} | ${runner === 'jeffrey' ? fmt(sum((r) => r.jev.inputTokens + r.jev.outputTokens)) : '—'} | ${sum((r) => r.score.passed)}/${sum((r) => r.score.total)} |`,
    );
  }

  lines.push('', '| task | run | wall time | LLM requests | prompt tokens | of which cached | generation tokens | total LLM tokens | cut off | Jev calls / tokens | checks |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    lines.push(
      `| ${r.task} | ${r.runner} #${r.run}${r.exit.timedOut ? ' (timed out)' : ''} | ${fmtTime(r.seconds)} | ${r.requests} | ${fmt(r.promptTokens)} | ${fmt(r.cachedTokens ?? 0)} | ${fmt(r.completionTokens)} | ${fmt(r.promptTokens + r.completionTokens)} | ${r.truncated} | ${r.jev ? `${r.jev.calls} / ${fmt(r.jev.inputTokens + r.jev.outputTokens)}` : '—'} | ${r.score.passed}/${r.score.total} |`,
    );
  }
  lines.push('', 'Failed checks:');
  for (const r of results) {
    const failed = r.score.results.filter((c) => !c.ok).map((c) => c.name);
    lines.push(`- ${r.task} · ${r.runner} #${r.run}: ${failed.length ? failed.join('; ') : 'none'}`);
  }
  return `${lines.join('\n')}\n`;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}
