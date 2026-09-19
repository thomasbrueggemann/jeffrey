/**
 * Todo list operations. Every function is pure: it takes the current list and returns a new one,
 * so the CLI decides when to load and save.
 *
 * @typedef {{ id: number, title: string, done: boolean, createdAt: string }} Todo
 */

/** Add an open todo with the next free id. The title is trimmed and must not be empty. */
export function addTodo(todos, title, { now = new Date() } = {}) {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) throw new RangeError('a todo needs a title');
  const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1;
  return [...todos, { id, title: trimmed, done: false, createdAt: now.toISOString() }];
}

/** Mark a todo done. An unknown id throws a RangeError. */
export function completeTodo(todos, id) {
  if (!todos.some((todo) => todo.id === id)) throw new RangeError(`no todo with id ${id}`);
  return todos.map((todo) => (todo.id === id ? { ...todo, done: true } : todo));
}

/** Remove a todo. An unknown id throws a RangeError. */
export function removeTodo(todos, id) {
  if (!todos.some((todo) => todo.id === id)) throw new RangeError(`no todo with id ${id}`);
  return todos.filter((todo) => todo.id !== id);
}

/** Open todos in id order, or every todo with `all`. */
export function listTodos(todos, { all = false } = {}) {
  return todos.filter((todo) => all || !todo.done).sort((a, b) => a.id - b.id);
}
