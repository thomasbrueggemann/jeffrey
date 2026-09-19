/**
 * In-memory note store. `clock` is injectable so tests can pin timestamps.
 *
 * @typedef {{ id: number, title: string, body: string, createdAt: string, updatedAt: string }} Note
 */
export function createStore({ clock = () => new Date() } = {}) {
  const notes = new Map();
  let nextId = 1;

  return {
    list() {
      return [...notes.values()];
    },
    get(id) {
      return notes.get(id);
    },
    create({ title, body = '' }) {
      const at = clock().toISOString();
      const note = { id: nextId++, title, body, createdAt: at, updatedAt: at };
      notes.set(note.id, note);
      return note;
    },
    update(id, fields) {
      const note = notes.get(id);
      if (!note) return undefined;
      const next = { ...note, ...fields, updatedAt: clock().toISOString() };
      notes.set(id, next);
      return next;
    },
    remove(id) {
      return notes.delete(id);
    },
  };
}
