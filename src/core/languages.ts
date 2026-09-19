import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Everything Jeffrey knows about particular languages and ecosystems, in one place and as tables.
 *
 * The agent itself is language-neutral. These three helpers make it cheaper where a project's own
 * tooling can answer a question without a model call — how to run the tests, whether a file still
 * parses, which files a file depends on — and each degrades to "don't know" rather than guessing:
 * an unknown ecosystem has no test command, an unknown extension is not parse-checked, an unknown
 * import syntax adds no context. Adding a language is adding rows, not changing the agent.
 */

/* ------------------------------------------------------------------ test commands */

interface TestRule {
  /** Whether this rule applies to the project at `root`. */
  applies: (root: string) => boolean;
  command: (root: string) => string;
}

const TEST_RULES: TestRule[] = [
  {
    // A real "test" script, not npm's "no test specified" placeholder. The lockfile picks the runner.
    applies: (root) => {
      const script = readJson<{ scripts?: Record<string, string> }>(join(root, 'package.json'))?.scripts?.['test'];
      return Boolean(script && !/no test specified/.test(script));
    },
    command: (root) =>
      existsSync(join(root, 'pnpm-lock.yaml'))
        ? 'pnpm test'
        : existsSync(join(root, 'yarn.lock'))
          ? 'yarn test'
          : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))
            ? 'bun run test'
            : 'npm test',
  },
  { applies: (root) => existsSync(join(root, 'Cargo.toml')), command: () => 'cargo test' },
  { applies: (root) => existsSync(join(root, 'go.mod')), command: () => 'go test ./...' },
  {
    applies: (root) =>
      ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'].some((file) => existsSync(join(root, file))) ||
      hasFile(root, /^test_.*\.py$|_test\.py$/),
    command: () => (pythonHasPytest() ? 'python3 -m pytest -q' : 'python3 -m unittest discover'),
  },
  { applies: (root) => existsSync(join(root, 'pom.xml')), command: () => 'mvn -q test' },
  {
    applies: (root) => existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts')),
    command: (root) => (existsSync(join(root, 'gradlew')) ? './gradlew test' : 'gradle test'),
  },
  { applies: (root) => hasFile(root, /\.(csproj|fsproj|sln)$/), command: () => 'dotnet test' },
  { applies: (root) => existsSync(join(root, 'mix.exs')), command: () => 'mix test' },
  {
    applies: (root) => existsSync(join(root, 'Gemfile')) && existsSync(join(root, 'spec')),
    command: () => 'bundle exec rspec',
  },
  {
    applies: (root) => /^test:/m.test(readText(join(root, 'Makefile')) ?? ''),
    command: () => 'make test',
  },
];

/** The project's own test command, or undefined when its ecosystem is not recognised. */
export function detectTestCommand(root: string): string | undefined {
  return TEST_RULES.find((rule) => rule.applies(root))?.command(root);
}

/* ------------------------------------------------------------------ parse checks */

type Checker = (absolute: string, source: string) => string | undefined;

/**
 * Parse-only checks, by extension. Each needs nothing but the file (no project build, no network), and
 * the ones that shell out run only when their interpreter is installed. Languages whose check needs
 * the whole project (TypeScript, Rust, Go, Java) are left to the tests.
 */
const CHECKERS: Record<string, Checker> = {
  '.json': (_absolute, source) => {
    try {
      JSON.parse(source);
      return undefined;
    } catch (error) {
      return `${(error as Error).message}.`;
    }
  },
  '.js': (absolute, source) => nodeCheck(source, nearestPackageType(dirname(absolute)) === 'module'),
  '.mjs': (_absolute, source) => nodeCheck(source, true),
  '.cjs': (_absolute, source) => nodeCheck(source, false),
  '.py': (_absolute, source) =>
    commandCheck('python3', source, '.py', (file) => ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', file]),
  '.rb': (_absolute, source) => commandCheck('ruby', source, '.rb', (file) => ['-c', file]),
  '.sh': (_absolute, source) => commandCheck('bash', source, '.sh', (file) => ['-n', file]),
  '.bash': (_absolute, source) => commandCheck('bash', source, '.sh', (file) => ['-n', file]),
  '.php': (_absolute, source) => commandCheck('php', source, '.php', (file) => ['-l', file]),
};

/**
 * Why `next` would not parse as the file at `absolute`, or undefined when it parses, its language is
 * not checked, or the file did not parse before either (then the change may be the fix).
 */
export function syntaxProblem(absolute: string, before: string | undefined, next: string): string | undefined {
  const check = CHECKERS[extname(absolute).toLowerCase()];
  if (!check) return undefined;
  const error = check(absolute, next);
  if (!error) return undefined;
  if (before !== undefined && check(absolute, before)) return undefined;
  return error;
}

function nodeCheck(source: string, module: boolean): string | undefined {
  return commandCheck(process.execPath, source, module ? '.mjs' : '.cjs', (file) => ['--check', file]);
}

/** Run a parse-only command on `source` in a scratch file; the first error line, if it failed. */
function commandCheck(binary: string, source: string, ext: string, args: (file: string) => string[]): string | undefined {
  if (!hasBinary(binary)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'jeffrey-check-'));
  const file = join(dir, `check${ext}`);
  try {
    writeFileSync(file, source);
    const result = spawnSync(binary, args(file), { encoding: 'utf8', timeout: 10_000 });
    if (result.status === 0 || result.error) return undefined;
    const output = `${result.stderr}\n${result.stdout}`.replaceAll(file, 'the file');
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const message = lines.find((line) => /error/i.test(line)) ?? lines[0] ?? 'syntax error';
    const line = /(?:line |:)(\d+)\b/.exec(output)?.[1];
    return `${message}${line && !message.includes(line) ? ` (line ${line})` : ''}.`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The "type" of the nearest package.json at or above `dir`: 'module' or 'commonjs' (the default). */
function nearestPackageType(dir: string): string {
  for (let at = dir; ; at = dirname(at)) {
    const pkg = readJson<{ type?: string }>(join(at, 'package.json'));
    if (pkg) return pkg.type ?? 'commonjs';
    if (dirname(at) === at) return 'commonjs';
  }
}

/* ------------------------------------------------------------------ local imports */

interface ImportRule {
  extensions: string[];
  /** Candidate paths (absolute, without guessing extensions) for each import in `content`. */
  candidates: (content: string, file: string, root: string) => string[][];
}

const IMPORT_RULES: ImportRule[] = [
  {
    // import … from './x', import('./x'), require('./x'); TypeScript's ESM style names x.ts as './x.js'.
    extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'],
    candidates: (content, file) =>
      [...content.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => {
        const base = resolve(dirname(file), match[1]!);
        const stems = [base, base.replace(/\.[cm]?js$/, '')];
        return stems.flatMap((stem) => ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'].map((ext) => stem + ext));
      }),
  },
  {
    // from .mod import x, from ..pkg.mod import y (relative); import pkg.mod / from pkg.mod import z (project root).
    extensions: ['.py'],
    candidates: (content, file, root) =>
      [...content.matchAll(/^\s*(?:from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)|import\s+([\w.]+))/gm)].flatMap((match) => {
        const [, dots = '', fromModule = '', names = '', plain] = match;
        let base: string;
        let parts: string[];
        if (plain) {
          base = root;
          parts = plain.split('.');
        } else if (dots) {
          base = dirname(file);
          for (let i = 1; i < dots.length; i++) base = dirname(base);
          parts = fromModule ? fromModule.split('.') : [];
        } else {
          base = root;
          parts = fromModule.split('.');
        }
        const module = join(base, ...parts);
        const files = (stem: string) => [`${stem}.py`, join(stem, '__init__.py'), `${join(root, 'src', relative(root, stem))}.py`];
        // `from pkg import name` may name a submodule as well as an attribute: look for both.
        const named = names ? names.split(',').map((name) => files(join(module, name.trim()))) : [];
        return [...(parts.length ? [files(module)] : []), ...named];
      }),
  },
  {
    // mod name; → name.rs or name/mod.rs next to (or under) the declaring file; use crate::a::b → src/a.rs.
    extensions: ['.rs'],
    candidates: (content, file, root) => {
      const here = dirname(file);
      const owner = ['mod.rs', 'lib.rs', 'main.rs'].includes(basename(file)) ? here : join(here, basename(file, '.rs'));
      const mods = [...content.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)].map((m) => [join(owner, `${m[1]}.rs`), join(owner, m[1]!, 'mod.rs')]);
      const uses = [...content.matchAll(/\buse\s+crate::(\w+)/g)].map((m) => [join(root, 'src', `${m[1]}.rs`), join(root, 'src', m[1]!, 'mod.rs')]);
      return [...mods, ...uses];
    },
  },
  {
    // #include "local.h" (not <system.h>), relative to the including file, then include/ and src/.
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.m', '.mm'],
    candidates: (content, file, root) =>
      [...content.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)].map((m) => [resolve(dirname(file), m[1]!), join(root, 'include', m[1]!), join(root, 'src', m[1]!)]),
  },
  {
    // require_relative 'x' → x.rb next to the file.
    extensions: ['.rb'],
    candidates: (content, file) =>
      [...content.matchAll(/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => {
        const base = resolve(dirname(file), m[1]!);
        return [base, `${base}.rb`];
      }),
  },
];

/** Workspace-relative paths of the project files that `path` imports, in the order it imports them. */
export function localImports(workspace: string, path: string, content: string): string[] {
  const file = resolve(workspace, path);
  const rule = IMPORT_RULES.find((r) => r.extensions.includes(extname(file).toLowerCase()));
  if (!rule) return [];
  const found: string[] = [];
  for (const candidates of rule.candidates(content, file, workspace)) {
    for (const candidate of candidates) {
      const rel = relative(workspace, candidate);
      if (rel.startsWith('..') || isAbsolute(rel) || resolve(candidate) === file) continue;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        if (!found.includes(rel)) found.push(rel);
        break;
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ helpers */

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson<T>(path: string): T | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Whether a file matching `pattern` sits in `root` or one level below it. */
function hasFile(root: string, pattern: RegExp): boolean {
  const skip = new Set(['node_modules', '.git', '.venv', 'venv', 'target', 'dist', 'build']);
  const scan = (dir: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) =>
      entry.isFile() ? pattern.test(entry.name) : depth > 0 && entry.isDirectory() && !skip.has(entry.name) && scan(join(dir, entry.name), depth - 1),
    );
  };
  return scan(root, 1);
}

const binaries = new Map<string, boolean>();
function hasBinary(name: string): boolean {
  if (isAbsolute(name)) return true;
  if (!binaries.has(name)) {
    binaries.set(name, spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }).status === 0);
  }
  return binaries.get(name)!;
}

let pytest: boolean | undefined;
function pythonHasPytest(): boolean {
  pytest ??= hasBinary('python3') && spawnSync('python3', ['-c', 'import pytest'], { stdio: 'ignore' }).status === 0;
  return pytest;
}
