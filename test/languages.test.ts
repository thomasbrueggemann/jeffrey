import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTestCommand, localImports, syntaxProblem } from '../src/core/languages.js';

/**
 * Jeffrey's language knowledge is tables, and each table degrades to "don't know". These pin that
 * the tables cover more than the JavaScript the benchmark started with, and that an unknown language
 * gets no guesses.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jeffrey-lang-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test('test commands are detected across ecosystems, and not invented', () => {
  assert.equal(detectTestCommand(project({ 'package.json': '{"scripts":{"test":"vitest"}}' })), 'npm test');
  assert.equal(detectTestCommand(project({ 'package.json': '{"scripts":{"test":"vitest"}}', 'pnpm-lock.yaml': '' })), 'pnpm test');
  assert.equal(detectTestCommand(project({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), undefined);
  assert.equal(detectTestCommand(project({ 'Cargo.toml': '[package]' })), 'cargo test');
  assert.equal(detectTestCommand(project({ 'go.mod': 'module x' })), 'go test ./...');
  assert.match(detectTestCommand(project({ 'tests/test_app.py': '' }))!, /^python3 -m (pytest|unittest)/);
  assert.equal(detectTestCommand(project({ 'app.sln': '' })), 'dotnet test');
  assert.equal(detectTestCommand(project({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./run\n' })), 'make test');
  assert.equal(detectTestCommand(project({ 'README.md': '# nothing to run' })), undefined);
});

test('parse checks cover several languages and skip what they cannot check alone', () => {
  const at = (name: string) => join(project({}), name);
  assert.match(syntaxProblem(at('a.py'), undefined, 'def f(:\n  pass\n') ?? '', /line 1/);
  assert.equal(syntaxProblem(at('a.py'), undefined, 'def f():\n    return 1\n'), undefined);
  assert.ok(syntaxProblem(at('a.rb'), undefined, 'def f(\n'));
  assert.ok(syntaxProblem(at('a.sh'), undefined, 'if then fi\n'));
  assert.ok(syntaxProblem(at('a.json'), undefined, '{"a":}'));
  // Needs the whole crate / project to check: left to the tests, never guessed at.
  assert.equal(syntaxProblem(at('main.rs'), undefined, 'fn main( {'), undefined);
  assert.equal(syntaxProblem(at('x.ts'), undefined, 'let x: = 1'), undefined);
});

test('local imports resolve in Python, Rust, C and Ruby as well as JavaScript', () => {
  const py = project({ 'app/__init__.py': '', 'app/store.py': '', 'app/util/fmt.py': '', 'app/api.py': '' });
  assert.deepEqual(localImports(py, 'app/api.py', 'from .store import Store\nfrom .util import fmt\nimport json\n'), ['app/store.py', 'app/util/fmt.py']);
  assert.deepEqual(localImports(py, 'app/api.py', 'from app.store import Store\nimport app.util.fmt\n'), ['app/store.py', 'app/util/fmt.py']);

  const rs = project({ 'src/main.rs': '', 'src/store.rs': '', 'src/api/mod.rs': '' });
  assert.deepEqual(localImports(rs, 'src/main.rs', 'mod store;\npub mod api;\nuse std::io;\n'), ['src/store.rs', 'src/api/mod.rs']);

  const c = project({ 'src/main.c': '', 'include/store.h': '' });
  assert.deepEqual(localImports(c, 'src/main.c', '#include <stdio.h>\n#include "store.h"\n'), ['include/store.h']);

  const rb = project({ 'lib/app.rb': '', 'lib/store.rb': '' });
  assert.deepEqual(localImports(rb, 'lib/app.rb', "require 'json'\nrequire_relative 'store'\n"), ['lib/store.rb']);

  assert.deepEqual(localImports(project({ 'Main.hs': '' }), 'Main.hs', 'import Data.List\n'), [], 'unknown language: no guesses');
});
