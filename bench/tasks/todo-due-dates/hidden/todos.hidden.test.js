import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTodo, completeTodo, listTodos } from '../src/todos.js';

const now = new Date('2026-03-01T10:00:00Z');
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('a due date is stored on the todo', () => {
  const [todo] = addTodo([], 'pay rent', { now, due: '2026-03-05' });
  assert.equal(todo.due, '2026-03-05');
  assert.equal(todo.title, 'pay rent');
});

test('a todo without a due date still works', () => {
  const [todo] = addTodo([], 'someday', { now });
  assert.equal(todo.due, undefined);
});

test('a malformed or impossible due date throws a RangeError', () => {
  for (const due of ['2026-3-5', 'tomorrow', '2026-02-30', '2026-13-01', '05/03/2026']) {
    assert.throws(() => addTodo([], 'x', { now, due }), RangeError, due);
  }
});

test('overdue lists open todos due before today, oldest first', () => {
  let todos = [];
  todos = addTodo(todos, 'late b', { now, due: '2026-02-20' });
  todos = addTodo(todos, 'not due yet', { now, due: '2026-03-10' });
  todos = addTodo(todos, 'late a', { now, due: '2026-01-15' });
  todos = addTodo(todos, 'no date', { now });
  todos = addTodo(todos, 'late but done', { now, due: '2026-01-01' });
  todos = addTodo(todos, 'due today', { now, due: '2026-03-01' });
  todos = completeTodo(todos, 5);
  assert.deepEqual(listTodos(todos, { overdue: true, today: '2026-03-01' }).map((t) => t.title), ['late a', 'late b']);
});

test('the plain list is unchanged by due dates', () => {
  let todos = addTodo([], 'a', { now, due: '2026-05-01' });
  todos = addTodo(todos, 'b', { now });
  assert.deepEqual(listTodos(todos).map((t) => t.title), ['a', 'b']);
});

function cli(file, ...argv) {
  const result = spawnSync(process.execPath, [cliPath, ...argv], { env: { ...process.env, TODO_FILE: file }, encoding: 'utf8' });
  return { code: result.status, out: result.stdout.trim() };
}

test('the CLI adds with --due, lists due dates, and filters --overdue', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'todo-hidden-')), 'todos.json');
  assert.equal(cli(file, 'add', 'file', 'taxes', '--due', '2000-01-15').code, 0);
  assert.equal(cli(file, 'add', 'plan', 'trip', '--due', '2999-06-01').code, 0);
  assert.equal(cli(file, 'add', 'water', 'plants').code, 0);

  const all = cli(file, 'list').out.split('\n');
  assert.deepEqual(all, ['[ ] 1. file taxes (due 2000-01-15)', '[ ] 2. plan trip (due 2999-06-01)', '[ ] 3. water plants']);

  assert.deepEqual(cli(file, 'list', '--overdue').out.split('\n'), ['[ ] 1. file taxes (due 2000-01-15)']);
});

test('the CLI rejects a bad due date without saving', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'todo-hidden-')), 'todos.json');
  assert.notEqual(cli(file, 'add', 'x', '--due', '2026-02-30').code, 0);
  assert.equal(cli(file, 'list', '--all').out, '');
});
