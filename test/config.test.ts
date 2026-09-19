import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `--init` used to write the cwd it ran in as `agent.workspace`, and every later run — from any
 * directory — then worked in that one. The workspace is where jeffrey is started, never global.
 */

const home = mkdtempSync(join(tmpdir(), 'jeffrey-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadConfig, writeStarterConfig, DEFAULT_CONFIG, GLOBAL_CONFIG_PATH } = await import('../src/config.js');

test('a workspace in the global config is ignored', () => {
  assert.ok(GLOBAL_CONFIG_PATH.startsWith(home));
  mkdirSync(join(home, '.jeffrey'), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify({ agent: { workspace: '/somewhere/else', maxSteps: 7 } }));
  const { config } = loadConfig({}, {});
  assert.equal(config.agent.workspace, process.cwd());
  assert.equal(config.agent.maxSteps, 7, 'the rest of the agent section still applies');
});

test('the starter config does not pin a workspace', () => {
  const path = join(home, 'starter.json');
  writeStarterConfig(path, DEFAULT_CONFIG);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.agent.workspace, undefined);
});
