import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SessionLog } from '../src/core/session-log.js';
import type { JevClient } from '../src/core/jev.js';
import type { LlmClient } from '../src/core/llm.js';
import type { SystemOneResponse } from '../src/types.js';

/**
 * The transcript is only worth having if it is complete, ordered and safe to share. These pin the
 * properties that matter when reading one back: requests land before their responses (so a hang is
 * visible), failures are recorded, and no credential ever reaches the file.
 */

const scratch = () => mkdtempSync(join(tmpdir(), 'jeffrey-log-'));
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);

test('nothing is written until the first record', () => {
  const dir = join(scratch(), 'sessions');
  const log = new SessionLog(dir);
  assert.equal(existsSync(dir), false);
  log.goal('hello');
  assert.equal(existsSync(log.path), true);
});

test('the transcript is private to the user', () => {
  const log = new SessionLog(join(scratch(), 'sessions'));
  log.goal('hello');
  assert.equal(statSync(log.path).mode & 0o077, 0);
});

test('jev calls log the request before the response, correlated by call id', async () => {
  const log = new SessionLog(scratch());
  const response: SystemOneResponse = { model: 'jev', answers: {} };
  const jev = log.wrapJev({ label: 'jev', ask: async () => response } satisfies JevClient);

  await jev.ask({ goal: 'x' }, { next: { type: 'noul', instructions: 'q' } });

  const [request, reply] = read(log.path);
  assert.equal(request?.['type'], 'jev-request');
  assert.deepEqual(request?.['state'], { goal: 'x' });
  assert.equal(reply?.['type'], 'jev-response');
  assert.equal(reply?.['call'], request?.['call']);
  assert.deepEqual(reply?.['response'], response);
});

test('a failing client is logged and still throws', async () => {
  const log = new SessionLog(scratch());
  const llm = log.wrapLlm({
    label: 'llm',
    complete: async () => {
      throw new Error('boom');
    },
  } satisfies LlmClient);

  await assert.rejects(llm.complete({ messages: [{ role: 'user', content: 'hi' }] }), /boom/);

  const records = read(log.path);
  assert.deepEqual(records.map((r) => r['type']), ['llm-request', 'llm-error']);
  assert.equal(records[1]?.['error'].message, 'boom');
});

test('events are logged, but the cumulative stream and the duplicated raw response are not', () => {
  const log = new SessionLog(scratch());
  log.event({ type: 'llm-stream', channel: 'reasoning', text: 'partial' });
  log.event({ type: 'notice', level: 'warn', message: 'looping' });
  log.event({
    type: 'decision',
    step: 1,
    decision: { tool: 'read_file', route: 'act', raw: { model: 'jev', answers: {} } } as never,
  });

  const records = read(log.path);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.['event'].message, 'looping');
  assert.equal(records[1]?.['event'].decision.tool, 'read_file');
  assert.equal('raw' in records[1]?.['event'].decision, false);
});

test('approvals record both the request and the answer', async () => {
  const log = new SessionLog(scratch());
  const approve = log.wrapApprove(async () => ({ choice: 'allow', answer: 'use pnpm' }));

  await approve({ tool: 'ask_user', args: {}, risk: 0, reason: 'r', question: 'which package manager?' });

  const [request, response] = read(log.path);
  assert.equal(request?.['request'].question, 'which package manager?');
  assert.deepEqual(response?.['response'], { choice: 'allow', answer: 'use pnpm' });
});

test('credentials never reach the file', () => {
  const log = new SessionLog(scratch());
  const config = structuredClone(DEFAULT_CONFIG);
  config.llm.apiKey = 'sk-llm-super-secret-key';
  config.llm.headers = { Authorization: 'Bearer very-secret-gateway-token' };
  config.jev.apiKey = 'ts-jev-super-secret-key';
  log.start({ version: '0', config, jevLabel: 'jev', llmLabel: 'llm' });

  const text = readFileSync(log.path, 'utf8');
  for (const secret of ['super-secret', 'very-secret']) assert.equal(text.includes(secret), false);
});

test('an unwritable location disables logging instead of throwing', () => {
  // A file where the directory should be makes mkdir fail; the agent must carry on regardless.
  const blocker = join(scratch(), 'blocker');
  spawnSync('touch', [blocker]);
  const log = new SessionLog(join(blocker, 'sessions'));
  assert.doesNotThrow(() => {
    log.goal('a');
    log.goal('b');
  });
});

test('a real headless run leaves a transcript under HOME/.jeffrey/sessions', () => {
  const home = scratch();
  const result = spawnSync(
    process.execPath,
    ['bin/jeffrey.js', '--jev-mock=read_file', '--llm-mock', '--print', '--yes', 'read package.json'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const path = /session log: (.+)/.exec(result.stderr)?.[1];
  assert.ok(path, `expected the log path on stderr, got: ${result.stderr}`);
  assert.ok(path.startsWith(join(home, '.jeffrey', 'sessions')));

  const types = read(path).map((r) => r['type']);
  for (const expected of ['session-start', 'goal', 'jev-request', 'jev-response', 'llm-request', 'llm-response', 'event']) {
    assert.ok(types.includes(expected), `expected a ${expected} record, got ${[...new Set(types)].join(', ')}`);
  }
  assert.ok(read(path).some((r) => r['type'] === 'event' && r['event'].type === 'done'));
});

test('saveSessions can be switched off from the environment', () => {
  const home = scratch();
  const result = spawnSync(
    process.execPath,
    ['bin/jeffrey.js', '--jev-mock=read_file', '--llm-mock', '--print', '--yes', 'read package.json'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, JEFFREY_SAVE_SESSIONS: '0' },
    },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(existsSync(join(home, '.jeffrey', 'sessions')), false);
});

test('llm.extraBody is merged into the request body', async () => {
  const { OpenAiCompatibleClient } = await import('../src/core/llm.js');
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  try {
    const client = new OpenAiCompatibleClient({
      ...DEFAULT_CONFIG.llm,
      extraBody: { chat_template_kwargs: { enable_thinking: false }, model: 'must-not-win' },
    });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent['chat_template_kwargs'], { enable_thinking: false });
  assert.equal(sent['model'], DEFAULT_CONFIG.llm.model, 'extraBody cannot override the core fields');
});
