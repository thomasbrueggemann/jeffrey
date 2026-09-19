import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { Agent } from '../src/core/agent.js';
import { MockJevClient } from '../src/core/mock-jev.js';
import { validateArgs } from '../src/core/executor.js';
import { TOOLS_BY_NAME } from '../src/core/tools.js';
import type { CompleteOptions, LlmClient, LlmResult } from '../src/core/llm.js';
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
  assert.match(calls[0]!.messages[0]!.content!, /Copy old_string character-for-character/);

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
  const llm = new RamblingReporter([{ path: 'src/math.ts', old_string: '  return a - b;', new_string: '  return a + b;' }]);
  const dir = await workspace();
  const jev = new MockJevClient({ tools: ['edit_file', 'read_file'] });
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
  assert.ok(notes.some((note) => note.startsWith('edit_file succeeded')), `expected the plain fallback, got ${JSON.stringify(notes)}`);
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
