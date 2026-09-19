import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Static acceptance checks for the benchmark task. Neither agent can open a browser, so these check
 * what can be checked from the files: the three files exist and are wired together, the script
 * parses, every element the script looks up exists in the page, and each feature has its code.
 */
export function check(dir) {
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  const html = read('index.html');
  const css = read('style.css');
  const js = read('app.js');

  const idsInHtml = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const idsInJs = new Set([
    ...[...js.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/querySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]\s*\)/g)].map((m) => m[1]),
  ]);
  const missingIds = [...idsInJs].filter((id) => !idsInHtml.has(id));

  const results = [
    ['index.html, style.css and app.js exist', Boolean(html && css && js)],
    ['index.html links style.css', /<link[^>]+href=["']\.?\/?style\.css["']/i.test(html)],
    ['index.html loads app.js', /<script[^>]+src=["']\.?\/?app\.js["']/i.test(html)],
    ['app.js parses', js ? spawnSync(process.execPath, ['--check', join(dir, 'app.js')]).status === 0 : false],
    [`every id app.js looks up exists in index.html${missingIds.length ? ` (missing: ${missingIds.join(', ')})` : ''}`, js !== '' && idsInJs.size > 0 && missingIds.length === 0],
    ['has start, pause and reset controls', /start/i.test(html) && /pause/i.test(html) && /reset/i.test(html)],
    ['counts down with a timer', /set(Interval|Timeout)\s*\(/.test(js)],
    ['shows mm:ss', /padStart\s*\(\s*2|:\s*['"`]?\s*\+|toString\(\)\.padStart|`\$\{[^}]+\}:\$\{/.test(js)],
    ['work and break durations are configurable', /type=["']number["']/i.test(html)],
    ['completed sessions persist in localStorage', /localStorage\.(setItem|getItem)/.test(js)],
    ['style.css has real rules', (css.match(/\{[^}]*:[^}]*\}/g) ?? []).length >= 5],
  ];
  return {
    passed: results.filter(([, ok]) => ok).length,
    total: results.length,
    results: results.map(([name, ok]) => ({ name, ok })),
  };
}
