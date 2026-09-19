#!/usr/bin/env node
import { addTodo, completeTodo, listTodos, removeTodo } from './todos.js';
import { load, save, storePath } from './store.js';

const USAGE = `usage:
  todo add <title>
  todo done <id>
  todo rm <id>
  todo list [--all]`;

export function format(todo) {
  return `${todo.done ? '[x]' : '[ ]'} ${todo.id}. ${todo.title}`;
}

export function run(argv, { path = storePath(), out = console.log } = {}) {
  const [command, ...rest] = argv;
  const todos = load(path);
  switch (command) {
    case 'add': {
      const next = addTodo(todos, rest.join(' '));
      save(path, next);
      out(format(next[next.length - 1]));
      return 0;
    }
    case 'done':
      save(path, completeTodo(todos, Number(rest[0])));
      return 0;
    case 'rm':
      save(path, removeTodo(todos, Number(rest[0])));
      return 0;
    case 'list':
      for (const todo of listTodos(todos, { all: rest.includes('--all') })) out(format(todo));
      return 0;
    default:
      out(USAGE);
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
