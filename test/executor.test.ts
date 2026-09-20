import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { Agent } from '../src/core/agent.js';
import { MockJevClient } from '../src/core/mock-jev.js';
import { alignEdit, buildBrief, gatherFiles, validateArgs } from '../src/core/executor.js';
import { localImports } from '../src/core/languages.js';
import { ACTION_TOOLS, TOOLS_BY_NAME } from '../src/core/tools.js';
import type { CompleteOptions, LlmClient, LlmResult } from '../src/core/llm.js';

/** The tool the agent forced for this call: every tool is offered, one is named in tool_choice. */
function chosenTool(options: CompleteOptions): string {
  const choice = options.toolChoice;
  return typeof choice === 'object' ? choice.function.name : (options.tools?.[0]?.function.name ?? 'write_file');
}
import type { AgentEvent } from '../src/types.js';

/**
 * The executor is only as good as its inputs. These pin the inputs it now gets — Jev's intent, the
 * target file's contents — and the repair round that turns a call which would fail into a second
 * attempt with the concrete problem, instead of a wasted step.
 */

const SOURCE = 'export function add(a: number, b: number) {\n  return a - b;\n}\n';

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-executor-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'math.ts'), SOURCE);
  return dir;
}

const edit = TOOLS_BY_NAME.get('edit_file')!;
const write = TOOLS_BY_NAME.get('write_file')!;

test('an old_string that is not in the file is rejected with the nearest real line', async () => {
  const dir = await workspace();
  const problems = validateArgs(edit, { path: 'src/math.ts', old_string: 'return a-b;', new_string: 'return a + b;' }, dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /does not occur/);
  assert.ok(problems[0]!.includes(JSON.stringify('  return a - b;')), problems[0]);
});

test('a non-unique old_string is rejected unless replace_all is set', async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'src', 'dup.ts'), 'x\nx\n');
  assert.match(validateArgs(edit, { path: 'src/dup.ts', old_string: 'x', new_string: 'y' }, dir)[0]!, /occurs 2 times/);
  assert.deepEqual(validateArgs(edit, { path: 'src/dup.ts', old_string: 'x', new_string: 'y', replace_all: true }, dir), []);
});

test('a correct edit passes', async () => {
  const dir = await workspace();
  assert.deepEqual(validateArgs(edit, { path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' }, dir), []);
});

test('write_file content with an elision comment is rejected, prose saying "unchanged" is not', async () => {
  const dir = await workspace();
  const elided = 'export function add() {\n  // ... rest of the code unchanged\n}\n';
  assert.match(validateArgs(write, { path: 'src/math.ts', content: elided }, dir)[0]!, /elision/);
  assert.deepEqual(validateArgs(write, { path: 'README.md', content: '# API\n\nThe public API remains unchanged.\n' }, dir), []);
  assert.deepEqual(validateArgs(write, { path: 'stub.py', content: 'def f():\n    ...\n' }, dir), []);
});

test('validation never reads outside the workspace', async () => {
  const dir = await workspace();
  // Would be "does not exist" if it had looked; outside paths are left to the tool to refuse.
  assert.deepEqual(validateArgs(edit, { path: '../../definitely/not/here.ts', old_string: 'a', new_string: 'b' }, dir), []);
});

/** Records every request and answers with a scripted sequence of edit_file argument objects. */
class ScriptedExecutor implements LlmClient {
  readonly label = 'scripted';
  readonly requests: CompleteOptions[] = [];
  private calls = 0;
  constructor(private readonly edits: Array<Record<string, unknown>>) {}

  async complete(options: CompleteOptions): Promise<LlmResult> {
    this.requests.push(options);
    const usage = { promptTokens: 0, completionTokens: 0 };
    if (!options.tools?.length) {
      if (options.messages.some((m) => m.role === 'system' && /note for the decision model/.test(m.content ?? ''))) {
        return { content: 'Yes: the subtraction is now an addition.', toolCalls: [], usage, finishReason: 'stop' };
      }
      return { content: '', toolCalls: [], usage, finishReason: 'stop' };
    }
    const args = this.edits[Math.min(this.calls++, this.edits.length - 1)]!;
    return {
      content: '',
      toolCalls: [{ id: `c${this.calls}`, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }],
      usage,
      finishReason: 'tool_calls',
    };
  }
}

async function runEdit(llm: ScriptedExecutor): Promise<{ dir: string; events: AgentEvent[] }> {
  const dir = await workspace();
  const config: Config = {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 2 },
  };
  const events: AgentEvent[] = [];
  const agent = new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config,
    llm,
    jev: new MockJevClient({ tools: ['edit_file'] }),
    onEvent: (event) => events.push(event),
    approve: async () => 'allow',
  });
  await agent.run();
  return { dir, events };
}

test('the executor sees the intent and the target file, and a rejected call is repaired', async () => {
  const llm = new ScriptedExecutor([
    { path: 'src/math.ts', old_string: 'return a-b;', new_string: 'return a + b;' },
    { path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' },
  ]);
  const { dir, events } = await runEdit(llm);

  // The run opens with the criteria call; the tool calls are the ones that offer a tool.
  const calls = llm.requests.filter((request) => request.tools?.length);
  const first = calls[0]!.messages.map((m) => m.content).join('\n');
  assert.match(first, /This step is for: make the change the goal asks for/);
  assert.match(first, /Current contents of src\/math\.ts/);
  assert.ok(first.includes(SOURCE.trimEnd()), 'the file contents must be in the brief verbatim');
  // The tool's own rules ride in the instruction turn, so the system turn stays the same on every
  // call and the server can serve the prefix from its cache.
  assert.match(calls[0]!.messages[0]!.content!, /Copy old_string character-for-character/);
  assert.equal(calls[0]!.messages[0]!.content, calls[1]!.messages[0]!.content, 'one system turn for every tool');

  const repair = calls[1]!.messages.at(-1)!.content!;
  assert.match(repair, /rejected before it ran/);
  assert.match(repair, /does not occur in src\/math\.ts/);

  assert.equal(await readFile(join(dir, 'src', 'math.ts'), 'utf8'), SOURCE.replace('a - b', 'a + b'));
  assert.ok(events.some((e) => e.type === 'llm-context' && e.paths.includes('src/math.ts')));
});

test('a call that stays invalid is not run, and Jev is told exactly why', async () => {
  const llm = new ScriptedExecutor([{ path: 'src/math.ts', old_string: 'nope', new_string: 'still nope' }]);
  const { dir, events } = await runEdit(llm);

  assert.equal(await readFile(join(dir, 'src', 'math.ts'), 'utf8'), SOURCE, 'the file must be untouched');
  assert.ok(!events.some((e) => e.type === 'tool-call'), 'an invalid call must never reach the tool');
  const rejected = events.find((e) => e.type === 'observation' && !e.ok);
  assert.ok(rejected && rejected.type === 'observation');
  assert.match(rejected.output, /executor could not produce a valid edit_file call/);
  assert.match(rejected.output, /does not occur/);
});

/** Cuts the first tool call off at `max_tokens`, then answers in full once the budget is raised. */
class TruncatingExecutor implements LlmClient {
  readonly label = 'truncating';
  readonly budgets: Array<number | undefined> = [];

  async complete(options: CompleteOptions): Promise<LlmResult> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    if (!options.tools?.length) return { content: 'Yes: the edit applied.', toolCalls: [], usage, finishReason: 'stop' };
    this.budgets.push(options.maxTokens);
    if (this.budgets.length === 1) return { content: '<tool_call>\n<function=edit_file>', toolCalls: [], usage, finishReason: 'length' };
    const args = { path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' };
    return {
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }],
      usage,
      finishReason: 'tool_calls',
    };
  }
}

test('a reply cut off at max_tokens is retried once with a bigger budget, not re-asked at the same one', async () => {
  const llm = new TruncatingExecutor();
  const { dir, events } = await runEdit(llm as unknown as ScriptedExecutor);

  const base = DEFAULT_CONFIG.llm.maxTokens;
  assert.deepEqual(llm.budgets.slice(0, 2), [base, base * 2], 'no JSON fallback at the budget that already overflowed');
  assert.ok(events.some((e) => e.type === 'notice' && /cut off after \d+ tokens/.test(e.message)));
  assert.equal(await readFile(join(dir, 'src', 'math.ts'), 'utf8'), SOURCE.replace('a - b', 'a + b'));
});

/** A reporter that is cut off mid-draft, and records what it was shown. */
class RamblingReporter extends ScriptedExecutor {
  reporterPrompt = '';
  reporterBudget: number | undefined;
  override async complete(options: CompleteOptions): Promise<LlmResult> {
    if (!options.tools?.length && options.messages.some((m) => /note for the decision model/.test(m.content ?? ''))) {
      this.reporterPrompt = options.messages.map((m) => m.content).join('\n');
      this.reporterBudget = options.maxTokens;
      return { content: '**Analysis:** the user wants a note…', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, finishReason: 'length' };
    }
    return super.complete(options);
  }
}

test('the reporter sees the workspace, and a cut-off draft never becomes the note', async () => {
  const llm = new RamblingReporter([{}]);
  const dir = await workspace();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(3)"' } }));
  const jev = new MockJevClient({ tools: ['run_shell', 'read_file'] });
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 2 } },
    llm,
    jev,
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();

  assert.match(llm.reporterPrompt, /Files in the workspace now: .*src\/math\.ts/);
  assert.equal(llm.reporterBudget, DEFAULT_CONFIG.llm.noteMaxTokens, 'a note never gets the executor budget');
  const notes = (jev.seenStates as Array<Record<string, unknown>>).map((state) => String(state['agent_notes'] ?? ''));
  assert.ok(notes.some((note) => note.startsWith('run_shell failed')), `expected the plain fallback, got ${JSON.stringify(notes)}`);
  assert.ok(!notes.some((note) => note.includes('**Analysis')), 'the cut-off draft must not reach Jev');
});

test('grep with a file as its path searches that file', async () => {
  const dir = await workspace();
  const ctx = { workspace: dir, allowOutsideWorkspace: false, bashTimeoutMs: 1000 };
  const grep = TOOLS_BY_NAME.get('grep')!;
  const hit = await grep.execute({ pattern: 'return a - b', path: 'src/math.ts' }, ctx);
  assert.match(hit.output, /src\/math\.ts:2:/);
  await assert.rejects(grep.execute({ pattern: 'x', path: 'src/nope.ts' }, ctx), /does not exist/);
});

/** Writes app.js and claims criteria in the call: once with a made-up quote, then with real ones. */
class ProvingExecutor implements LlmClient {
  readonly label = 'proving';
  private writes = 0;
  async complete(options: CompleteOptions): Promise<LlmResult> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    const system = options.messages[0]?.content ?? '';
    if (/planning half/.test(system)) {
      return { content: '1. app.js saves the count in localStorage\n2. app.js ticks every second', toolCalls: [], usage, finishReason: 'stop' };
    }
    const writing = chosenTool(options) === 'write_file';
    if (writing) this.writes += 1;
    const args = writing
      ? {
          path: 'app.js',
          content: 'let n = 0;\nlocalStorage.setItem("count", n);\nsetInterval(tick, 1000);\n',
          criteria_met: this.writes === 1 ? ['1: localStorage.setItem("count", n);', '2: setInterval(tock, 5000);'] : ['2: setInterval(tick, 1000);'],
        }
      : { path: 'app.js' };
    return {
      content: '',
      toolCalls: [{ id: 'c', type: 'function', function: { name: chosenTool(options), arguments: JSON.stringify(args) } }],
      usage,
      finishReason: 'tool_calls',
    };
  }
}

test('a run ends once every criterion is proven by a quote found in the files', async () => {
  const dir = await workspace();
  const events: AgentEvent[] = [];
  const jev = new MockJevClient({ tools: ['write_file', 'write_file', 'read_file', 'read_file', 'read_file'], leaveArgsToExecutor: true });
  const { reason, summary } = await new Agent({
    goal: 'write app.js that saves a count and ticks',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 6 } },
    llm: new ProvingExecutor(),
    jev,
    onEvent: (event) => events.push(event),
    approve: async () => 'allow',
  }).run();

  assert.equal(reason, 'goal-reached', summary);
  assert.match(summary, /proven by quotes/);
  assert.ok(
    events.some((e) => e.type === 'notice' && /criteria 2: the quote is not in the file/.test(e.message)),
    'a made-up quote is rejected',
  );
  assert.equal(events.filter((e) => e.type === 'tool-call').length, 2, 'it stops right after the step that proved the last one');
  const state = (jev.seenStates as Array<Record<string, any>>).at(-1)!;
  assert.match(JSON.stringify(state['ledger']), /"evidence":"app\.js: localStorage\.setItem/);
});

test('an absolute path inside the workspace is recorded relative', async () => {
  const dir = await workspace();
  const llm = new ScriptedExecutor([{ path: join(dir, 'src', 'math.ts'), old_string: '  return a - b;', new_string: '  return a + b;' }]);
  const events: AgentEvent[] = [];
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 1 } },
    llm,
    jev: new MockJevClient({ tools: ['edit_file'], leaveArgsToExecutor: true }),
    onEvent: (event) => events.push(event),
    approve: async () => 'allow',
  }).run();
  const call = events.find((e) => e.type === 'tool-call');
  assert.ok(call && call.type === 'tool-call');
  assert.equal(call.args['path'], join('src', 'math.ts'));
});

/** Answers one write_file request with three calls, one of them a duplicate path. */
class BatchExecutor implements LlmClient {
  readonly label = 'batch';
  toolRequests = 0;
  async complete(options: CompleteOptions): Promise<LlmResult> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    const system = options.messages[0]?.content ?? '';
    if (/planning half/.test(system)) {
      return { content: '1. index.html loads app.js\n2. app.js greets the user', toolCalls: [], usage, finishReason: 'stop' };
    }
    if (!options.tools?.length) return { content: 'Yes.', toolCalls: [], usage, finishReason: 'stop' };
    this.toolRequests += 1;
    const call = (id: string, path: string, content: string, criteria_met: string[] = []) => ({
      id,
      type: 'function' as const,
      function: { name: 'write_file', arguments: JSON.stringify({ path, content, criteria_met }) },
    });
    return {
      content: '',
      toolCalls: [
        call('a', 'index.html', '<html><body><script src="app.js"></script></body></html>\n', ['1: <script src="app.js"></script>']),
        call('b', 'app.js', 'console.log("hello there");\n', ['2: console.log("hello there");']),
        call('c', 'app.js', 'console.log("a second app.js is dropped");\n'),
      ],
      usage,
      finishReason: 'tool_calls',
    };
  }
}

test('several write_file calls in one reply are written in one step', async () => {
  const dir = await workspace();
  const llm = new BatchExecutor();
  const events: AgentEvent[] = [];
  const { reason } = await new Agent({
    goal: 'make index.html that loads app.js, which greets the user',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 3 } },
    llm,
    jev: new MockJevClient({ tools: ['write_file', 'read_file', 'read_file'], leaveArgsToExecutor: true }),
    onEvent: (event) => events.push(event),
    approve: async () => 'allow',
  }).run();

  assert.equal(llm.toolRequests, 1, 'one executor call wrote both files');
  const calls = events.filter((e) => e.type === 'tool-call');
  assert.deepEqual(calls.map((e) => e.type === 'tool-call' && e.args['path']), ['index.html', 'app.js'], 'the duplicate path is dropped');
  assert.equal(await readFile(join(dir, 'app.js'), 'utf8'), 'console.log("hello there");\n');
  assert.equal(reason, 'goal-reached', 'the calls proved criteria from both files');
});

/** Writes a broken app.js first and a working one second; every write claims both criteria. */
class TestGatedExecutor implements LlmClient {
  readonly label = 'test-gated';
  writes = 0;
  async complete(options: CompleteOptions): Promise<LlmResult> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    const system = options.messages[0]?.content ?? '';
    if (/planning half/.test(system)) {
      return { content: '1. app.js exports a tick function\n2. app.js exports ok', toolCalls: [], usage, finishReason: 'stop' };
    }
    if (!options.tools?.length) return { content: 'Yes.', toolCalls: [], usage, finishReason: 'stop' };
    const name = chosenTool(options);
    this.writes += name === 'write_file' ? 1 : 0;
    const args =
      name === 'write_file'
        ? {
            path: 'app.js',
            content: `export function tick() {}\nexport const ok = ${this.writes > 1};\n`,
            criteria_met: ['1: export function tick()', '2: export const ok ='],
          }
        : { path: 'app.js' };
    return {
      content: '',
      toolCalls: [{ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      usage,
      finishReason: 'tool_calls',
    };
  }
}

test('proven criteria still need the project tests to pass before the run ends', async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
  await writeFile(join(dir, 'check.mjs'), "const { ok } = await import('./app.js');\nif (!ok) { console.error('app is not ok'); process.exit(1); }\n");
  const events: AgentEvent[] = [];
  const llm = new TestGatedExecutor();
  const { reason, summary } = await new Agent({
    goal: 'write app.js with tick and ok',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 6 } },
    llm,
    jev: new MockJevClient({ tools: ['write_file', 'write_file', 'write_file', 'write_file'], leaveArgsToExecutor: true }),
    onEvent: (event) => events.push(event),
    approve: async () => 'allow',
  }).run();

  const runs = events.filter((e) => e.type === 'tool-call' && e.tool === 'run_shell');
  assert.deepEqual(
    runs.map((e) => e.type === 'tool-call' && e.step),
    [0, 2, 4],
    'a baseline before step 1, then at the start of the step after each write: failing, then passing',
  );
  assert.ok(events.some((e) => e.type === 'observation' && e.tool === 'run_shell' && !e.ok && /app is not ok/.test(e.output)));
  assert.equal(llm.writes, 2);
  assert.equal(reason, 'goal-reached', summary);
  assert.match(summary, /npm test` passes/);
});

test('the executor sees the files its target imports', async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'src', 'store.ts'), 'export function update() {}\n');
  await writeFile(join(dir, 'src', 'server.ts'), "import { update } from './store.js';\nimport { add } from './math';\nimport http from 'node:http';\n");
  assert.deepEqual(localImports(dir, 'src/server.ts', await readFile(join(dir, 'src', 'server.ts'), 'utf8')), ['src/store.ts', 'src/math.ts']);

  const files = gatherFiles({ tool: edit, settled: { path: 'src/server.ts' }, history: [], candidates: [], workspace: dir, budget: 10_000 });
  assert.deepEqual(files.map((f) => [f.path, f.importedBy]), [['src/server.ts', undefined], ['src/store.ts', 'src/server.ts'], ['src/math.ts', 'src/server.ts']]);
  const brief = buildBrief({ goal: 'g', workspace: dir, steering: [], notes: '', history: [], candidates: [], scripts: [], files, observationChars: 1000 });
  assert.match(brief, /src\/store\.ts, which src\/server\.ts imports/);
});

/** Cut off twice, then answers; records each tool request's budget and body extras. */
class RunawayExecutor implements LlmClient {
  readonly label = 'runaway';
  readonly calls: Array<{ maxTokens?: number; extraBody?: Record<string, unknown> }> = [];
  async complete(options: CompleteOptions): Promise<LlmResult> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    if (!options.tools?.length) return { content: 'Yes.', toolCalls: [], usage, finishReason: 'stop' };
    this.calls.push({ maxTokens: options.maxTokens, extraBody: options.extraBody });
    if (this.calls.length <= 2) return { content: '', toolCalls: [], usage, finishReason: 'length' };
    const args = { path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' };
    return { content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify(args) } }], usage, finishReason: 'tool_calls' };
  }
}

test('a cut-off reply is retried without thinking first, and only then with a bigger budget', async () => {
  const quickExtraBody = { chat_template_kwargs: { enable_thinking: false } };
  const dir = await workspace();
  const llm = new RunawayExecutor();
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, quickExtraBody, executorThinking: 'always' }, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 1 } },
    llm,
    jev: new MockJevClient({ tools: ['edit_file'] }),
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();

  const base = DEFAULT_CONFIG.llm.maxTokens;
  assert.deepEqual(llm.calls, [
    { maxTokens: base, extraBody: undefined },
    { maxTokens: base, extraBody: quickExtraBody },
    { maxTokens: base * 2, extraBody: quickExtraBody },
  ]);
  assert.equal(await readFile(join(dir, 'src', 'math.ts'), 'utf8'), SOURCE.replace('a - b', 'a + b'));
});

test('the old noteExtraBody name still configures the quick calls', async () => {
  const { loadConfig } = await import('../src/config.js');
  const path = join(await workspace(), 'cfg.json');
  await writeFile(path, JSON.stringify({ llm: { noteExtraBody: { x: 1 } } }));
  const { config } = loadConfig({ configPath: path }, {});
  assert.deepEqual(config.llm.quickExtraBody, { x: 1 });
});

test('an edit that would break the syntax is rejected before it is applied', async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const server = "import http from 'node:http';\nfunction handle(req) {\n  return 1;\n}\nexport { handle };\n";
  await writeFile(join(dir, 'src', 'server.js'), server);

  // The benchmark's failure: an await inside a function that is not async.
  const problems = validateArgs(edit, { path: 'src/server.js', old_string: '  return 1;', new_string: '  const raw = await read(req);' }, dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /would leave src\/server\.js unparseable: SyntaxError: Unexpected reserved word \(line 3\)/);
  assert.equal(await readFile(join(dir, 'src', 'server.js'), 'utf8'), server, 'nothing is written');

  // Valid ESM passes, JSON is checked, other languages are left alone.
  assert.deepEqual(validateArgs(write, { path: 'src/ok.js', content: "import x from './server.js';\nexport const y = await Promise.resolve(x);\n" }, dir), []);
  assert.match(validateArgs(write, { path: 'data.json', content: '{"a": 1,}' }, dir)[0]!, /data\.json would not parse/);
  assert.deepEqual(validateArgs(write, { path: 'Main.hs', content: 'main = (' }, dir), [], 'a language without a checker is not guessed at');
});

test('a file that was already broken can still be edited', async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'src', 'broken.js'), 'const a = ;\nconst b = ;\n');
  assert.deepEqual(validateArgs(edit, { path: 'src/broken.js', old_string: 'const a = ;', new_string: 'const a = 1;' }, dir), []);
});

test('a first attempt gets a thinking allowance, and the retry without thinking the full budget', async () => {
  const quickExtraBody = { chat_template_kwargs: { enable_thinking: false } };
  const dir = await workspace();
  const llm = new RunawayExecutor();
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, maxTokens: 32_768, quickExtraBody, executorThinking: 'always' },
      agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 1 },
    },
    llm,
    jev: new MockJevClient({ tools: ['edit_file'] }),
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();
  assert.deepEqual(
    llm.calls.map((c) => [c.maxTokens, Boolean(c.extraBody)]),
    [[DEFAULT_CONFIG.llm.thinkingAllowance + 3072, false], [32_768, true], [65_536, true]],
  );
});

/** Records what the criteria call was given. */
class CriteriaSpy extends ScriptedExecutor {
  criteriaPrompt = '';
  override async complete(options: CompleteOptions): Promise<LlmResult> {
    if (/planning half/.test(options.messages[0]?.content ?? '')) {
      this.criteriaPrompt = options.messages.map((m) => m.content).join('\n');
      return { content: '1. src/math.ts adds\n2. it is tested', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, finishReason: 'stop' };
    }
    return super.complete(options);
  }
}

test('criteria are planned from the files the goal names, not from the goal alone', async () => {
  const llm = new CriteriaSpy([{ path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' }]);
  await runEdit(llm);
  assert.match(llm.criteriaPrompt, /Files in the workspace: .*src\/math\.ts/);
  assert.match(llm.criteriaPrompt, /src\/math\.ts, which the goal names:/);
  assert.ok(llm.criteriaPrompt.includes(SOURCE.trimEnd()), 'the named file is shown in full');
});

test('a call whose every required argument Jev settled runs without asking the executor', async () => {
  const dir = await workspace();
  const llm = new ScriptedExecutor([{}]);
  const jev = new MockJevClient({ tools: ['read_file'] });
  await new Agent({
    goal: 'look at src/math.ts',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 1 } },
    llm,
    jev,
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();

  assert.equal(llm.requests.filter((request) => request.tools?.length).length, 0, 'no executor call');
  assert.equal(llm.requests.filter((request) => /note for the decision model/.test(request.messages[0]?.content ?? '')).length, 0, 'no note for a read');
  assert.equal(jev.seenStates.length, 1, 'one Jev call for the step: the arguments ride with the routing question');
});

test('with executorThinking after-failure, a first attempt skips thinking and a rejected one thinks', async () => {
  const quickExtraBody = { chat_template_kwargs: { enable_thinking: false } };
  const dir = await workspace();
  const llm = new ScriptedExecutor([
    { path: 'src/math.ts', old_string: 'return a-b;', new_string: 'return a + b;' },
    { path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' },
  ]);
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, quickExtraBody, executorThinking: 'after-failure' },
      agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 1 },
    },
    llm,
    jev: new MockJevClient({ tools: ['edit_file'] }),
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();

  const calls = llm.requests.filter((request) => request.tools?.length);
  assert.deepEqual(calls.map((request) => request.extraBody), [quickExtraBody, undefined]);
  assert.equal(await readFile(join(dir, 'src', 'math.ts'), 'utf8'), SOURCE.replace('a - b', 'a + b'));
});

test('an old_string off only in indentation or copied with line numbers is aligned to the file', async () => {
  const dir = await workspace();
  await writeFile(join(dir, 'src', 'nest.ts'), 'function f() {\n  if (x) {\n    return 1;\n  }\n}\n');
  const shifted = alignEdit({ path: 'src/nest.ts', old_string: 'if (x) {\n  return 1;\n}', new_string: 'if (x) {\n  return 2;\n}' }, dir);
  assert.equal(shifted['old_string'], '  if (x) {\n    return 1;\n  }');
  assert.equal(shifted['new_string'], '  if (x) {\n    return 2;\n  }');
  const numbered = alignEdit({ path: 'src/nest.ts', old_string: '3      return 1;', new_string: '3      return 2;' }, dir);
  assert.deepEqual([numbered['old_string'], numbered['new_string']], ['    return 1;', '    return 2;']);
  const ambiguous = { path: 'src/nest.ts', old_string: '}', new_string: '};' };
  assert.deepEqual(alignEdit(ambiguous, dir), ambiguous, 'two lines match: left for validation to reject');
});

test('an edit that meets a criterion is proven from Jev\'s pick of the lines it wrote', async () => {
  const dir = await workspace();
  // The executor claims nothing; the proof comes from the next routing call.
  const llm = new ScriptedExecutor([{ path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b; // add, never subtract' }]);
  const jev = new MockJevClient({ tools: ['edit_file', 'list_dir', 'list_dir'] });
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 3 } },
    llm,
    jev,
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();

  const ledger = JSON.stringify((jev.seenStates as Array<Record<string, unknown>>).at(-1)?.['ledger'] ?? {});
  assert.match(ledger, /"status":"met","evidence":"src\/math\.ts: return a \+ b; \/\/ add, never subtract"/);
});

/** Answers the first forced call with a different tool than the one named, then the right one. */
class StrayingExecutor implements LlmClient {
  readonly label = 'straying';
  readonly offered: number[] = [];
  async complete(options: CompleteOptions): Promise<LlmResult> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    if (!options.tools?.length) return { content: 'Yes.', toolCalls: [], usage, finishReason: 'stop' };
    this.offered.push(options.tools.length);
    const stray = this.offered.length === 1;
    const call = stray
      ? { name: 'read_file', arguments: JSON.stringify({ path: 'src/math.ts' }) }
      : { name: 'edit_file', arguments: JSON.stringify({ path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' }) };
    return { content: '', toolCalls: [{ id: 'c', type: 'function', function: call }], usage, finishReason: 'tool_calls' };
  }
}

test('a reply that calls a tool other than the one asked for is asked again with only that tool', async () => {
  const dir = await workspace();
  const llm = new StrayingExecutor();
  await new Agent({
    goal: 'fix the add function in src/math.ts, it subtracts',
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, workspace: dir, autoApprove: true, maxSteps: 1 } },
    llm,
    jev: new MockJevClient({ tools: ['edit_file'] }),
    onEvent: () => {},
    approve: async () => 'allow',
  }).run();

  assert.deepEqual(llm.offered.slice(0, 2), [ACTION_TOOLS.length, 1], 'every tool, then only edit_file');
  assert.equal(await readFile(join(dir, 'src', 'math.ts'), 'utf8'), SOURCE.replace('a - b', 'a + b'));
});
