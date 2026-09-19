#!/usr/bin/env node
import { addTodo, completeTodo, listTodos, removeTodo } from './todos.js';
import { load, save, storePath } from './store.js';

const USAGE = `usage:
  todo add <title> [--due YYYY-MM-DD]
  todo done <id>
  todo rm <id>
  todo list [--all | --overdue]`;

export function format(todo) {
  return `${todo.done ? '[x]' : '[ ]'} ${todo.id}. ${todo.title}${todo.due ? ` (due ${todo.due})` : ''}`;
}

export function run(argv, { path = storePath(), out = console.log, today = new Date().toISOString().slice(0, 10) } = {}) {
  const [command, ...rest] = argv;
  const todos = load(path);
  switch (command) {
    case 'add': {
      const at = rest.indexOf('--due');
      const due = at === -1 ? undefined : rest[at + 1];
      const words = at === -1 ? rest : [...rest.slice(0, at), ...rest.slice(at + 2)];
      const next = addTodo(todos, words.join(' '), due ? { due } : {});
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
      for (const todo of listTodos(todos, { all: rest.includes('--all'), overdue: rest.includes('--overdue'), today })) out(format(todo));
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
