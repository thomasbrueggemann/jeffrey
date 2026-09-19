import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

function cli() {
  const path = join(mkdtempSync(join(tmpdir(), 'todo-')), 'todos.json');
  const lines = [];
  return { lines, run: (...argv) => run(argv, { path, out: (line) => lines.push(line) }) };
}

test('add, done and list round-trip through the file', () => {
  const c = cli();
  c.run('add', 'write', 'report');
  c.run('add', 'send', 'invoice');
  c.run('done', '1');
  c.lines.length = 0;
  c.run('list', '--all');
  assert.deepEqual(c.lines, ['[x] 1. write report', '[ ] 2. send invoice']);
});

test('an unknown command prints usage and fails', () => {
  const c = cli();
  assert.equal(c.run('frobnicate'), 1);
  assert.match(c.lines[0], /usage/);
});
