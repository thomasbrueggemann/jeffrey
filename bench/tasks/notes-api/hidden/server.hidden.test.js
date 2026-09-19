import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore } from '../src/notes.js';

let server;
let base;
let tick = 0;

before(async () => {
  // Every clock read is one minute later, so a change is visibly newer than the creation.
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, tick++));
  server = createApp({ store: createStore({ clock }) });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const send = (method, path, raw) =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: raw });
const json = (method, path, body) => send(method, path, body === undefined ? undefined : JSON.stringify(body));

async function create(title = 'first', body = 'text') {
  const res = await json('POST', '/notes', { title, body });
  assert.equal(res.status, 201);
  return res.json();
}

async function expectError(res, status) {
  assert.equal(res.status, status);
  const payload = await res.json();
  assert.equal(typeof payload.error, 'string');
  assert.ok(payload.error.length > 0);
}

test('PATCH changes only the fields sent and bumps updatedAt', async () => {
  const note = await create('draft', 'keep me');
  const res = await json('PATCH', `/notes/${note.id}`, { title: 'final' });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.title, 'final');
  assert.equal(updated.body, 'keep me');
  assert.equal(updated.createdAt, note.createdAt);
  assert.ok(updated.updatedAt > note.updatedAt, 'updatedAt moves forward');
  assert.deepEqual(await (await json('GET', `/notes/${note.id}`)).json(), updated);
});

test('PATCH can change the body alone', async () => {
  const note = await create('title stays');
  const updated = await (await json('PATCH', `/notes/${note.id}`, { body: 'new body' })).json();
  assert.equal(updated.title, 'title stays');
  assert.equal(updated.body, 'new body');
});

test('PATCH on a missing note is 404', async () => {
  await expectError(await json('PATCH', '/notes/9999', { title: 'x' }), 404);
});

test('POST rejects a missing, empty, too long or non-string title', async () => {
  await expectError(await json('POST', '/notes', { body: 'no title' }), 400);
  await expectError(await json('POST', '/notes', { title: '' }), 400);
  await expectError(await json('POST', '/notes', { title: '   ' }), 400);
  await expectError(await json('POST', '/notes', { title: 'x'.repeat(101) }), 400);
  await expectError(await json('POST', '/notes', { title: 42 }), 400);
  assert.equal((await json('POST', '/notes', { title: 'x'.repeat(100) })).status, 201);
});

test('POST rejects a non-string body', async () => {
  await expectError(await json('POST', '/notes', { title: 'ok', body: 7 }), 400);
});

test('invalid JSON or a non-object body is 400, not 500', async () => {
  await expectError(await send('POST', '/notes', '{not json'), 400);
  await expectError(await send('POST', '/notes', '[1, 2]'), 400);
  await expectError(await send('POST', '/notes', 'null'), 400);
  const note = await create();
  await expectError(await send('PATCH', `/notes/${note.id}`, 'nope'), 400);
});

test('PATCH validates what it is sent', async () => {
  const note = await create('valid');
  await expectError(await json('PATCH', `/notes/${note.id}`, {}), 400);
  await expectError(await json('PATCH', `/notes/${note.id}`, { title: '' }), 400);
  await expectError(await json('PATCH', `/notes/${note.id}`, { body: false }), 400);
  const unchanged = await (await json('GET', `/notes/${note.id}`)).json();
  assert.equal(unchanged.title, 'valid');
});

test('the existing routes still work', async () => {
  const note = await create('still here');
  assert.equal((await json('GET', `/notes/${note.id}`)).status, 200);
  assert.equal((await json('DELETE', `/notes/${note.id}`)).status, 204);
  assert.equal((await json('GET', '/nope')).status, 404);
});
