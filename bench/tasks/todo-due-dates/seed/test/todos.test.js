import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTodo, completeTodo, listTodos, removeTodo } from '../src/todos.js';

const now = new Date('2026-03-01T10:00:00Z');

test('add gives each todo the next id and trims the title', () => {
  let todos = addTodo([], '  buy milk ', { now });
  todos = addTodo(todos, 'call mum', { now });
  assert.deepEqual(todos.map((t) => [t.id, t.title, t.done]), [[1, 'buy milk', false], [2, 'call mum', false]]);
});

test('an empty title is rejected', () => {
  assert.throws(() => addTodo([], '   '), RangeError);
});

test('completed todos drop out of the default list', () => {
  let todos = addTodo(addTodo([], 'a', { now }), 'b', { now });
  todos = completeTodo(todos, 1);
  assert.deepEqual(listTodos(todos).map((t) => t.title), ['b']);
  assert.deepEqual(listTodos(todos, { all: true }).map((t) => t.title), ['a', 'b']);
});

test('unknown ids throw', () => {
  assert.throws(() => completeTodo([], 7), RangeError);
  assert.throws(() => removeTodo([], 7), RangeError);
});
