import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/notes.js';

let server;
let base;

before(async () => {
  server = createApp({ store: createStore({ clock: () => new Date('2026-01-01T00:00:00Z') }) });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const json = (method, path, body) =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('create, read, list and delete a note', async () => {
  const created = await json('POST', '/notes', { title: 'groceries', body: 'eggs' });
  assert.equal(created.status, 201);
  const note = await created.json();
  assert.equal(note.title, 'groceries');

  assert.deepEqual(await (await json('GET', `/notes/${note.id}`)).json(), note);
  assert.ok((await (await json('GET', '/notes')).json()).some((n) => n.id === note.id));
  assert.equal((await json('DELETE', `/notes/${note.id}`)).status, 204);
  assert.equal((await json('GET', `/notes/${note.id}`)).status, 404);
});

test('unknown paths are 404', async () => {
  assert.equal((await json('GET', '/nope')).status, 404);
});
