import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Where the list lives: $TODO_FILE, or todos.json in the current folder. */
export function storePath(env = process.env) {
  return env.TODO_FILE || 'todos.json';
}

export function load(path) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function save(path, todos) {
  writeFileSync(path, `${JSON.stringify(todos, null, 2)}\n`);
}
