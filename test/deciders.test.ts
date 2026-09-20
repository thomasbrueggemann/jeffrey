import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The decision model is a plug: Jev is one provider, a self-hosted Laya is another, and nothing
 * above `DecisionModel` knows which is in play. These tests hold that seam — the provider's
 * defaults, the legacy config key, and the wire shape the Laya sidecar has to produce.
 */

const home = mkdtempSync(join(tmpdir(), 'jeffrey-deciders-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { LayaClient, PROVIDERS, createDecisionModel, isProvider } = await import('../src/core/deciders/index.js');
const { choice, noul, score, choiceValue, noulValue, scoreValue } = await import('../src/core/decision.js');

const QUESTIONS = {
  next_action: choice('What next?', { read_file: null, edit_file: null }),
  goal_reached: noul('Is the goal met?'),
  progress: score('How far along?', ['nothing', 'located', 'changed', 'verified', 'done']),
};

/* ------------------------------------------------------------------ configuration */

test('choosing a provider brings its own endpoint and model', () => {
  const { config } = loadConfig({ decider: { provider: 'laya' } }, {});
  assert.equal(config.decider.url, 'http://127.0.0.1:8137/v1/systemone');
  assert.equal(config.decider.model, 'router');
  assert.notEqual(config.decider.url, DEFAULT_CONFIG.decider.url, 'the TypeSafe endpoint must not leak through');
});

test('an endpoint the user named survives the provider defaults', () => {
  const { config } = loadConfig({ decider: { provider: 'laya', url: 'http://gpu-box:9000/v1/systemone' } }, {});
  assert.equal(config.decider.url, 'http://gpu-box:9000/v1/systemone');
});

test('the old jev section is still read as the decider section', () => {
  const { config } = loadConfig({ jev: { apiKey: 'ts-key', model: 'jev-1.13' } }, {});
  assert.equal(config.decider.apiKey, 'ts-key');
  assert.equal(config.decider.model, 'jev-1.13');
  assert.equal(config.decider.provider, 'typesafe');
});

test('the provider can be set from the environment', () => {
  const { config } = loadConfig({}, { JEFFREY_DECIDER: 'laya' });
  assert.equal(config.decider.provider, 'laya');
  assert.equal(config.decider.model, 'router');
});

test('an unknown provider fails loudly instead of falling back', () => {
  assert.throws(() => loadConfig({}, { JEFFREY_DECIDER: 'jeff' }), /Unknown decider provider/);
  assert.equal(isProvider('laya'), true);
  assert.equal(isProvider('nope'), false);
});

test('every provider builds a client that reports which one it is', () => {
  for (const name of Object.keys(PROVIDERS)) {
    const { config } = loadConfig({ decider: { provider: name as 'laya' } }, {});
    assert.equal(createDecisionModel(config.decider).provider, name);
  }
});

/* ------------------------------------------------------------------ the laya client */

interface Stub {
  url: string;
  bodies: unknown[];
  close(): Promise<void>;
}

async function stubLaya(reply: (body: any) => { status?: number; body: unknown }): Promise<Stub> {
  const bodies: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const parsed = raw ? JSON.parse(raw) : {};
      bodies.push(parsed);
      const { status = 200, body } = reply(parsed);
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function layaConfig(url: string) {
  const { config } = loadConfig({ decider: { provider: 'laya', url } }, {});
  return config.decider;
}

/** What `sidecar/laya-server.py` returns, verbatim in shape: laya's own `system_one` payload. */
const LAYA_REPLY = {
  model: 'laya-typed-decisions',
  answers: {
    next_action: { type: 'choice', choice: 'edit_file', probabilities: { edit_file: 0.71, read_file: 0.29 }, confidence: 0.71 },
    goal_reached: { type: 'noul', noul: 0.12, confidence: 0.88 },
    progress: { type: 'score', score: 1.84, legend: { '0': 'nothing' }, probabilities: { '0': 0.1 }, confidence: 0.6 },
  },
  usage: { input_tokens: 812, output_tokens: 0 },
  routing: { model: 'typed-decisions', reason: 'English state' },
};

test('a laya answer reads exactly like a jev answer', async () => {
  const stub = await stubLaya(() => ({ body: LAYA_REPLY }));
  try {
    const client = new LayaClient(layaConfig(stub.url));
    const response = await client.ask({ goal: 'fix the test' }, QUESTIONS);
    assert.equal(choiceValue(response, 'next_action'), 'edit_file');
    assert.equal(noulValue(response, 'goal_reached'), 0.12);
    assert.equal(scoreValue(response, 'progress'), 1.84);
    assert.equal(client.usage.calls, 1);
    assert.equal(client.usage.inputTokens, 812, 'local tokens are still counted, so runs stay comparable');
    assert.deepEqual((stub.bodies[0] as { questions: unknown }).questions, QUESTIONS);
    assert.equal((stub.bodies[0] as { model: string }).model, 'router');
  } finally {
    await stub.close();
  }
});

test('a server that omits the answer type is read by the question that asked', async () => {
  const bare = {
    model: 'laya',
    answers: {
      next_action: { choice: 'read_file', probabilities: {}, confidence: 0.5 },
      goal_reached: { noul: 0.4 },
      progress: { score: 2 },
    },
  };
  const stub = await stubLaya(() => ({ body: bare }));
  try {
    const response = await new LayaClient(layaConfig(stub.url)).ask('state', QUESTIONS);
    assert.equal(choiceValue(response, 'next_action'), 'read_file');
    assert.equal(noulValue(response, 'goal_reached'), 0.4);
    assert.equal(scoreValue(response, 'progress'), 2);
    const progress = response.answers['progress'];
    assert.equal(progress?.type === 'score' && progress.legend['2'], 'changed', 'the legend comes from the question');
  } finally {
    await stub.close();
  }
});

test('per-provider options ride along in the request body', async () => {
  const stub = await stubLaya(() => ({ body: LAYA_REPLY }));
  try {
    const config = { ...layaConfig(stub.url), options: { head_max_len: 768 } };
    await new LayaClient(config).ask('state', QUESTIONS);
    assert.equal((stub.bodies[0] as { head_max_len: number }).head_max_len, 768);
  } finally {
    await stub.close();
  }
});

test('a question the model cannot represent is reported, not retried away', async () => {
  let calls = 0;
  const stub = await stubLaya(() => {
    calls += 1;
    return { status: 400, body: { error: 'question "next_action" options exceed head_max_len=192' } };
  });
  try {
    await assert.rejects(
      () => new LayaClient(layaConfig(stub.url)).ask('state', QUESTIONS),
      /exceed head_max_len/,
    );
    assert.equal(calls, 1, 'a 400 is a bad request, not a transient fault');
  } finally {
    await stub.close();
  }
});

test('a dead port says how to start the server', async () => {
  // A port that was listening and is now closed: the connection is refused rather than hanging.
  const stub = await stubLaya(() => ({ body: LAYA_REPLY }));
  await stub.close();
  const config = { ...layaConfig(stub.url), maxRetries: 0 };
  await assert.rejects(() => new LayaClient(config).ask('state', QUESTIONS), /sidecar\/laya-server\.py/);
});
