import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, DEFAULT_MOCK_TOOLS } from '../src/cli.js';

/** Spawned runs write a session transcript under HOME; keep it out of the real ~/.jeffrey. */
const isolatedEnv = () => {
  const home = mkdtempSync(join(tmpdir(), 'jeffrey-home-'));
  return { ...process.env, HOME: home, USERPROFILE: home };
};

/**
 * Argument parsing is the one place a bad guess is silent: `--jev-mock` used to accept a
 * space-separated tool list, so a goal written after it was eaten and the CLI reported "no goal
 * given" instead of the real mistake. These pin the documented `--jev-mock[=a,b,c]` form.
 */

test('bare --jev-mock does not swallow the goal', () => {
  const flags = parseArgs(['--jev-mock', 'write a README']);
  assert.deepEqual(flags.jevMock, DEFAULT_MOCK_TOOLS);
  assert.equal(flags.goal, 'write a README');
});

test('--jev-mock=a,b,c takes an inline tool list', () => {
  const flags = parseArgs(['--jev-mock=read_file,list_dir', 'look around']);
  assert.deepEqual(flags.jevMock, ['read_file', 'list_dir']);
  assert.equal(flags.goal, 'look around');
});

test('inline tool lists are trimmed and drop empties', () => {
  const flags = parseArgs(['--jev-mock= read_file , , list_dir ', 'look around']);
  assert.deepEqual(flags.jevMock, ['read_file', 'list_dir']);
});

test('--jev-mock-script does not swallow the goal either', () => {
  // Space-separated JSON would eat the goal exactly like --jev-mock did; inline is the only form.
  const flags = parseArgs(['--jev-mock-script={"tools":["read_file"]}', 'inspect the repo']);
  assert.deepEqual(flags.jevMockScript, { tools: ['read_file'] });
  assert.equal(flags.goal, 'inspect the repo');
});

test('flags after the goal still parse', () => {
  const flags = parseArgs(['fix the bug', '--dry-run', '--max-steps', '7']);
  assert.equal(flags.goal, 'fix the bug');
  assert.equal(flags.dryRun, true);
  assert.equal(flags.maxSteps, 7);
});

test('multi-word goals join from positional arguments', () => {
  const flags = parseArgs(['fix', 'the', 'off-by-one', 'in', 'src/index.ts']);
  assert.equal(flags.goal, 'fix the off-by-one in src/index.ts');
});

/**
 * The entry point must actually run. `bin/jeffrey.js` is a separate file from `dist/cli.js`, so the
 * module-level "am I the entry point?" guard is false under the published bin — it has to call
 * `main()` itself. This regressed once (the CLI printed nothing and exited 0) and was silent.
 */
test('the published bin runs main and produces output', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['bin/jeffrey.js', '--jev-mock=read_file', '--print', 'read package.json'],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 60_000, env: isolatedEnv() },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /jev ->/, 'expected the CLI to render at least one decision line');
});

/**
 * `--json` is a machine contract: every stdout line must parse. The headless approver used to write
 * raw text straight to stdout, which interleaved with the JSON stream and broke consumers.
 */
test('--json keeps stdout parseable while approvals fire', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['bin/jeffrey.js', '--jev-mock=ask_user', '--print', '--json', 'do I need to write the file?'],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 60_000, env: isolatedEnv() },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  assert.ok(lines.length > 0, 'expected JSON output');
  const events = lines.map((line) => JSON.parse(line) as { type: string; message?: string });
  assert.ok(
    events.some((event) => event.type === 'notice' && /question for you/.test(event.message ?? '')),
    'expected the question to surface as a notice event',
  );
});

test('a relative --cwd resolves from where jeffrey was started, once', () => {
  const root = mkdtempSync(join(tmpdir(), 'jeffrey-cwd-'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  const before = process.cwd();
  try {
    process.chdir(join(root, 'a'));
    const flags = parseArgs(['--cwd', '../b', 'look around']);
    assert.equal(flags.cwd, realpathSync(join(root, 'b')));
    assert.equal(process.cwd(), realpathSync(join(root, 'b')));
  } finally {
    process.chdir(before);
  }
});
