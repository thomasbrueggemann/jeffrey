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
    remove(id) {
      return notes.delete(id);
    },
  };
}
