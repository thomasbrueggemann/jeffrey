import http from 'node:http';
import { createStore } from './notes.js';

function send(res, status, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

class BadRequest extends Error {}

async function readObject(req) {
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new BadRequest('body must be a JSON object');
  return input;
}

function validate(input, { partial }) {
  const fields = {};
  if ('title' in input || !partial) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100) {
      throw new BadRequest('title must be a non-empty string of at most 100 characters');
    }
    fields.title = input.title;
  }
  if ('body' in input) {
    if (typeof input.body !== 'string') throw new BadRequest('body must be a string');
    fields.body = input.body;
  }
  if (partial && !Object.keys(fields).length) throw new BadRequest('nothing to update: send title and/or body');
  return fields;
}

/** The notes API as an http.Server. Not listening yet: call `.listen()`. */
export function createApp({ store = createStore() } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/notes(?:\/(\d+))?$/.exec(url.pathname);
    if (!match) return send(res, 404, { error: 'not found' });
    const id = match[1] ? Number(match[1]) : undefined;

    try {
      if (id === undefined && req.method === 'GET') return send(res, 200, store.list());
      if (id === undefined && req.method === 'POST') {
        const fields = validate(await readObject(req), { partial: false });
        return send(res, 201, store.create(fields));
      }
      if (id !== undefined && req.method === 'GET') {
        const note = store.get(id);
        return note ? send(res, 200, note) : send(res, 404, { error: `no note ${id}` });
      }
      if (id !== undefined && req.method === 'PATCH') {
        const fields = validate(await readObject(req), { partial: true });
        const note = store.update(id, fields);
        return note ? send(res, 200, note) : send(res, 404, { error: `no note ${id}` });
      }
      if (id !== undefined && req.method === 'DELETE') {
        return store.remove(id) ? send(res, 204) : send(res, 404, { error: `no note ${id}` });
      }
      return send(res, 405, { error: `${req.method} not allowed` });
    } catch (error) {
      if (error instanceof BadRequest) return send(res, 400, { error: error.message });
      return send(res, 500, { error: error.message });
    }
  });
}
