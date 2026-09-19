import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, describeLedger, parseCriteria, splitFacts } from '../src/core/ledger.js';
import type { HistoryEntry } from '../src/core/decider.js';

const entry = (step: number, tool: string, args: Record<string, unknown>, ok = true, observation = 'ok'): HistoryEntry => ({
  step,
  tool,
  args,
  ok,
  observation,
  progress: 1,
});

test('a repeated failure is counted, not listed twice', () => {
  const ledger = new Ledger();
  ledger.observe(entry(1, 'read_file', { path: 'src/x.ts' }, false, 'Error: ENOENT\nstack'));
  ledger.observe(entry(3, 'read_file', { path: 'src/x.ts' }, false, 'Error: ENOENT again'));
  const view = ledger.view(4);
  assert.deepEqual(view.failed_attempts, [{ call: 'read_file(path="src/x.ts")', step: 3, times: 2, reason: 'Error: ENOENT again' }]);
});

test('a verification goes stale once a file changes after it', () => {
  const ledger = new Ledger();
  ledger.observe(entry(1, 'edit_file', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }));
  ledger.observe(entry(2, 'run_shell', { command: 'npm test' }, true, 'running\n# pass 12'));
  assert.equal(ledger.view(3).verification?.[0]?.files_changed_since, false);
  assert.equal(ledger.view(3).verification?.[0]?.result, '# pass 12');

  ledger.observe(entry(3, 'write_file', { path: 'src/b.ts', content: 'z' }));
  const view = ledger.view(4);
  assert.equal(view.verification?.[0]?.files_changed_since, true);
  assert.deepEqual(view.files_changed, [
    { path: 'src/a.ts', steps: [1] },
    { path: 'src/b.ts', steps: [3] },
  ]);
});

test('a failed edit is not a change', () => {
  const ledger = new Ledger();
  ledger.observe(entry(1, 'edit_file', { path: 'src/a.ts' }, false, 'old_string not found'));
  assert.equal(ledger.view(2).files_changed, undefined);
});

test('facts are deduplicated and marked stale when their file changes', () => {
  const ledger = new Ledger();
  ledger.addFacts(1, ['add() lives in src/math.ts line 3.'], ['src/math.ts']);
  ledger.addFacts(2, ['add() lives in src/math.ts line 3'], ['src/math.ts']);
  assert.equal(ledger.facts.length, 1);
  assert.equal(ledger.facts[0]!.step, 2);

  ledger.observe(entry(4, 'edit_file', { path: 'src/math.ts' }));
  assert.deepEqual(ledger.view(5).facts, [{ step: 2, text: 'add() lives in src/math.ts line 3', stale: true }]);
});

test('criteria follow the latest answer and report what changed', () => {
  const ledger = new Ledger();
  ledger.setCriteria(['flag is parsed', 'tests pass']);
  assert.equal(ledger.view(1).focus, 'criterion 1: flag is parsed');

  assert.deepEqual(ledger.applyCriteria({ 1: 0.8, 2: 0.2 }, 3, 0.6), [1]);
  assert.equal(ledger.view(4).focus, 'criterion 2: tests pass');
  assert.equal(ledger.view(6).steps_since_criteria_changed, 2);
  assert.equal(ledger.allMet(), false);

  // A later edit can break a criterion that was met; the checklist must say so.
  assert.deepEqual(ledger.applyCriteria({ 1: 0.3, 2: 0.9 }, 6, 0.6), [1, 2]);
  assert.equal(ledger.criteria[0]!.met, false);
  assert.equal(ledger.criteria[1]!.metAtStep, 6);
});

test('the view sheds facts before it drops the criteria', () => {
  const ledger = new Ledger();
  ledger.setCriteria(['the goal']);
  for (let i = 0; i < 20; i++) ledger.addFacts(i, [`fact number ${i} ${'x'.repeat(80)}`], []);
  const view = ledger.view(21, 600);
  assert.ok(JSON.stringify(view).length <= 600);
  assert.deepEqual(view.criteria, [{ id: 1, text: 'the goal', status: 'open' }]);
  assert.ok((view.facts?.length ?? 0) < 20);
  assert.match(view.facts?.at(-1)?.text ?? '', /fact number 19/, 'the newest facts survive');
});

test('the executor reads the ledger as prose', () => {
  const ledger = new Ledger();
  ledger.setCriteria(['flag is parsed']);
  ledger.observe(entry(1, 'run_shell', { command: 'npm test' }, false, '1 failing'));
  const text = describeLedger(ledger.view(2)).join('\n');
  assert.match(text, /\[ \] 1\. flag is parsed/);
  assert.match(text, /npm test → failed at step 1: 1 failing/);
  assert.match(text, /Already failed/);
});

test('criteria are parsed from a list and nothing else', () => {
  assert.deepEqual(parseCriteria('Here you go:\n1. **flag** parsed\n2) tests pass\n- docs updated\nThanks'), [
    'flag parsed',
    'tests pass',
    'docs updated',
  ]);
  assert.deepEqual(parseCriteria('The goal is done when it works.'), []);
  assert.equal(parseCriteria('1. a\n2. b\n3. c\n4. d\n5. e\n6. f').length, 5);
});

test('FACT lines are split out of the reporter note', () => {
  assert.deepEqual(splitFacts('Yes: the edit applied.\nFACT: add() is in src/math.ts\nfact: tests use node:test\nFACT: a third'), {
    note: 'Yes: the edit applied.',
    facts: ['add() is in src/math.ts', 'tests use node:test'],
  });
  assert.deepEqual(splitFacts('No change.'), { note: 'No change.', facts: [] });
});
