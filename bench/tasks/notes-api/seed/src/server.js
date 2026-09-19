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
        const input = JSON.parse(await readBody(req));
        return send(res, 201, store.create({ title: input.title, body: input.body }));
      }
      if (id !== undefined && req.method === 'GET') {
        const note = store.get(id);
        return note ? send(res, 200, note) : send(res, 404, { error: `no note ${id}` });
      }
      if (id !== undefined && req.method === 'DELETE') {
        return store.remove(id) ? send(res, 204) : send(res, 404, { error: `no note ${id}` });
      }
      return send(res, 405, { error: `${req.method} not allowed` });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  });
}
