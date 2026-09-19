/**
 * Todo list operations. Every function is pure: it takes the current list and returns a new one,
 * so the CLI decides when to load and save.
 *
 * @typedef {{ id: number, title: string, done: boolean, createdAt: string, due?: string }} Todo
 */

/** A real calendar date written as YYYY-MM-DD. */
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Add an open todo with the next free id. The title is trimmed and must not be empty. */
export function addTodo(todos, title, { now = new Date(), due } = {}) {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) throw new RangeError('a todo needs a title');
  if (due !== undefined && !isDate(due)) throw new RangeError(`not a YYYY-MM-DD date: ${due}`);
  const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1;
  return [...todos, { id, title: trimmed, done: false, createdAt: now.toISOString(), ...(due ? { due } : {}) }];
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

/** Open todos in id order, or every todo with `all`, or the overdue ones by due date. */
export function listTodos(todos, { all = false, overdue = false, today } = {}) {
  if (overdue) {
    return todos
      .filter((todo) => !todo.done && todo.due && todo.due < today)
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id));
  }
  return todos.filter((todo) => all || !todo.done).sort((a, b) => a.id - b.id);
}
