import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExitCommand, parseSlashCommand } from '../src/ui/slash.js';

/**
 * ctrl-c used to be a silent no-op at the idle prompt (the handler was inactive there and
 * `TextInput` ignores ctrl-c), so `/exit` is the documented escape hatch. These pin the parsing
 * that decides whether a typed line quits or becomes a goal — the failure mode being that a quit
 * attempt is quietly handed to the agent as a task.
 */

test('/exit ends the session', () => {
  assert.equal(isExitCommand('/exit'), true);
});

test('/exit tolerates case and surrounding whitespace', () => {
  assert.equal(isExitCommand('  /EXIT  '), true);
});

test('/quit and /q are accepted aliases', () => {
  assert.equal(isExitCommand('/quit'), true);
  assert.equal(isExitCommand('/q'), true);
});

test('a real goal is not an exit command', () => {
  assert.equal(isExitCommand('add retry with backoff'), false);
  assert.equal(isExitCommand(''), false);
  assert.equal(isExitCommand('   '), false);
});

test('trailing words do not turn an exit command into a goal', () => {
  // Quitting must never silently become a task: `/exit now` quits, it does not get sent to the agent.
  assert.equal(isExitCommand('/exit now'), true);
  assert.equal(isExitCommand('/quit all'), true);
});

test('an unknown slash command is left to the agent as a goal', () => {
  assert.equal(isExitCommand('/help'), false);
  assert.deepEqual(parseSlashCommand('/help me'), { name: '/help', arg: 'me' });
});

test('non-slash input parses as no command', () => {
  assert.equal(parseSlashCommand('refactor the parser'), null);
});

test('a step with several calls keeps the earlier ones instead of overwriting them', async () => {
  const { initialState, reduce } = await import('../src/ui/view.js');
  let state = initialState();
  const step = 1;
  state = reduce(state, { type: 'phase', phase: 'deciding' } as never);
  state = reduce(state, { type: 'decision', step, decision: { tool: 'write_file' } } as never);
  for (const path of ['index.html', 'app.js']) {
    state = reduce(state, { type: 'tool-call', step, tool: 'write_file', args: { path } } as never);
    state = reduce(state, { type: 'observation', step, tool: 'write_file', ok: true, output: 'wrote', summary: `created ${path}` } as never);
  }
  assert.deepEqual(state.live?.earlier?.map((call) => call.summary), ['created index.html']);
  assert.equal(state.live?.args?.['path'], 'app.js');
});
