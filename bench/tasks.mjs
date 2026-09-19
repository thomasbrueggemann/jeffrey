import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The benchmark's tasks, one folder each under bench/tasks:
 *
 *   task.md      the prompt, given verbatim to every agent
 *   seed/        the project the agent starts in (copied, then committed to a fresh git repo)
 *   hidden/      tests the agent never sees, copied in after it finishes and run against its work
 *   reference/   a known-good solution overlaid on the seed, used by --verify to check the tests
 *   check.json   { runner?: 'node' | 'pytest', requireNewTests?: boolean, protectedFiles?: string[] }
 *   check.mjs    optional: `check(dir)` replaces the hidden-test scoring (the greenfield task)
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'tasks');

export function listTasks() {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'task.md')))
    .map((entry) => entry.name)
    .sort();
}

export async function loadTask(name) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'task.md'))) throw new Error(`no task "${name}" (have: ${listTasks().join(', ')})`);
  const config = existsSync(join(dir, 'check.json')) ? JSON.parse(readFileSync(join(dir, 'check.json'), 'utf8')) : {};
  const custom = existsSync(join(dir, 'check.mjs')) ? (await import(join(dir, 'check.mjs'))).check : undefined;
  return {
    name,
    prompt: readFileSync(join(dir, 'task.md'), 'utf8').trim(),
    seed: existsSync(join(dir, 'seed')) ? join(dir, 'seed') : undefined,
    hidden: existsSync(join(dir, 'hidden')) ? join(dir, 'hidden') : undefined,
    reference: existsSync(join(dir, 'reference')) ? join(dir, 'reference') : undefined,
    config,
    custom,
  };
}

/** Lay the seed out in `dir` as a fresh one-commit git repository, the way a real project arrives. */
export function prepare(task, dir) {
  mkdirSync(dir, { recursive: true });
  if (task.seed) cpSync(task.seed, dir, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '--allow-empty', '-m', 'seed');
}

/** Score the work in `dir`. Returns { passed, total, results: [{ name, ok }] }. */
export function score(task, dir) {
  if (task.custom) return task.custom(dir);
  const results = [];

  // The project's own suite, including whatever tests the agent added, has to pass.
  const runner = task.config.runner ?? 'node';
  const visible = runTests(dir, [], runner);
  results.push({ name: `the project's own tests pass (${visible.pass}/${visible.pass + visible.fail})`, ok: visible.fail === 0 && visible.pass > 0 });

  if (task.config.requireNewTests) {
    const before = countTests(task.seed);
    const after = countTests(dir);
    results.push({ name: `new tests were added (${before} → ${after})`, ok: after > before });
  }
  for (const file of task.config.protectedFiles ?? []) {
    const same = existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8') === readFileSync(join(task.seed, file), 'utf8');
    results.push({ name: `${file} is unchanged`, ok: same });
  }

  // Hidden tests sit next to src/ so their `../src/...` imports resolve, and are removed again after.
  const hiddenDir = join(dir, '.bench-hidden');
  rmSync(hiddenDir, { recursive: true, force: true });
  cpSync(task.hidden, hiddenDir, { recursive: true });
  const hiddenFiles = readdirSync(hiddenDir).filter((name) => TEST_FILE[runner].test(name)).map((name) => join(hiddenDir, name));
  const hidden = runTests(dir, hiddenFiles, runner);
  rmSync(hiddenDir, { recursive: true, force: true });
  if (!hidden.tests.length) results.push({ name: `hidden tests ran (${hidden.error || 'no output'})`, ok: false });
  for (const t of hidden.tests) results.push({ name: `hidden: ${t.name}`, ok: t.ok });

  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
}

/** Seed must fail the hidden tests, seed + reference must pass them: otherwise the task is broken. */
export function verify(task, scratch) {
  if (task.custom || !task.hidden) return undefined;
  const seedDir = join(scratch, `${task.name}-seed`);
  const refDir = join(scratch, `${task.name}-reference`);
  prepare(task, seedDir);
  prepare(task, refDir);
  cpSync(task.reference, refDir, { recursive: true });
  const hiddenOnly = (s) => s.results.filter((r) => r.name.startsWith('hidden'));
  const seed = hiddenOnly(score(task, seedDir));
  const ref = score(task, refDir);
  return {
    seedFails: seed.some((r) => !r.ok),
    seedHidden: `${seed.filter((r) => r.ok).length}/${seed.length}`,
    referencePasses: hiddenOnly(ref).every((r) => r.ok),
    referenceHidden: `${hiddenOnly(ref).filter((r) => r.ok).length}/${hiddenOnly(ref).length}`,
    referenceFailures: ref.results.filter((r) => !r.ok && !r.name.startsWith('new tests')).map((r) => r.name),
  };
}

const TEST_FILE = { node: /\.test\.[cm]?js$/, pytest: /^test_.*\.py$|_test\.py$/ };

function runTests(cwd, paths, runner = 'node') {
  const [command, args] =
    runner === 'pytest'
      ? ['python3', ['-m', 'pytest', '-q', '-rA', '--tb=no', '-p', 'no:cacheprovider', ...paths]]
      : [process.execPath, ['--test', '--test-reporter=tap', ...paths]];
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const tests = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    if (runner === 'pytest') {
      // -rA summary: "PASSED tests/test_x.py::test_name", "FAILED …::name - reason", "ERROR path - reason".
      const match = /^(PASSED|FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - .*)?$/.exec(line.trim());
      if (match) tests.push({ name: match[3] ?? match[2], ok: match[1] === 'PASSED' });
      continue;
    }
    // Top-level results only; a file's subtests are indented.
    const match = /^(not )?ok \d+ - (.+?)(?: # .*)?$/.exec(line);
    if (match) tests.push({ name: match[2].trim(), ok: !match[1] });
  }
  return {
    tests,
    pass: tests.filter((t) => t.ok).length,
    fail: tests.filter((t) => !t.ok).length,
    error: result.error?.message ?? (result.status !== 0 && !tests.length ? (result.stderr ?? '').split('\n')[0] : ''),
  };
}

/** Test cases in the project: `test(`/`it(` calls, `def test_…` functions, `#[test]` attributes. */
function countTests(dir) {
  let count = 0;
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (['node_modules', '.git', '.bench-hidden', '__pycache__', '.venv', 'target'].includes(entry.name)) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.[cm]?[jt]s$|^test_.*\.py$|_test\.py$/.test(entry.name) || relative(dir, path).startsWith('test')) {
        count += (readFileSync(path, 'utf8').match(/^\s*(?:(?:test|it)\s*\(|(?:async\s+)?def\s+test_|#\[test\])/gm) ?? []).length;
      }
    }
  };
  walk(dir);
  return count;
}
