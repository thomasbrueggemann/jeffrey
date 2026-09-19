import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec, type ExecOptions } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ToolContext {
  workspace: string;
  allowOutsideWorkspace: boolean;
  bashTimeoutMs: number;
  /** Aborted when the user interrupts a run; long-running tools kill their child process on it. */
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Unified-ish diff for anything that changed a file, so the TUI can colour it. */
  diff?: string;
  summary: string;
}

export interface ToolSpec {
  name: string;
  /** Shown to the LLM. */
  description: string;
  /** JSON Schema for the LLM's function-calling interface. */
  parameters: Record<string, unknown>;
  /**
   * Arguments with a closed set of values. Jev gets a `choice` question for each of these, so
   * the decision model — not the LLM — picks which mode or option.
   */
  closedArgs?: Record<string, string[]>;
  /**
   * Arguments that name a workspace path. Jev gets a `choice` over a shortlist of real paths,
   * with an explicit "new path" escape hatch for creating something that does not exist yet.
   */
  pathArgs?: string[];
  /**
   * Arguments holding a shell command. When the workspace advertises a known set of scripts,
   * Jev gets a `choice` over them instead of leaving the command entirely to the executor.
   */
  commandArgs?: string[];
  /** Arguments that may be omitted entirely; Jev gets a noul "is this stated?" question. */
  optionalArgs?: string[];
  /** Tool-specific rules added to the executor's system prompt. */
  executorHints?: string[];
  /** The executor must see the target file's current contents to fill this call in correctly. */
  needsFileContext?: boolean;
  /** 0..1 — how much damage a wrong call can do. Feeds the approval prompt. */
  risk: number;
  /** True when the tool changes the filesystem or runs a process. */
  mutates: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/* ------------------------------------------------------------------ path helpers */

function assertInside(path: string, ctx: ToolContext): string {
  const absolute = resolve(ctx.workspace, path);
  if (!ctx.allowOutsideWorkspace) {
    const rel = relative(ctx.workspace, absolute);
    if (rel.startsWith('..') || (isAbsolute(rel) && rel !== '')) {
      throw new Error(
        `Refusing to touch ${absolute} — outside the workspace ${ctx.workspace}. ` +
          'Pass --allow-outside-workspace if that is really intended.',
      );
    }
  }
  return absolute;
}

function displayPath(path: string, ctx: ToolContext): string {
  const rel = relative(ctx.workspace, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', '.cache']);

async function walk(root: string, maxEntries = 20000): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  while (queue.length && found.length < maxEntries) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  }
  return found;
}

/** Minimal glob: `*`, `**`, `?`, and `{a,b}` alternation. Good enough for source trees. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        const options = pattern
          .slice(i + 1, close)
          .split(',')
          .map((option) => option.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${options.join('|')})`;
        i = close;
      }
    } else if ('.+^$()|[]\\'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

/* ------------------------------------------------------------------ diffing */

/** Line diff by longest common subsequence. Files here are small enough for the O(n·m) table. */
export function diffLines(before: string, after: string, path = ''): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: string[] = [];
  if (path) lines.push(`--- ${path}`);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) lines.push(`-${a[i++]}`);
  while (j < m) lines.push(`+${b[j++]}`);
  return lines.join('\n');
}

export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/* ------------------------------------------------------------------ tools */

const readFileTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a text file from the workspace. Returns line-numbered content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      offset: { type: 'integer', description: 'First line to read (1-based).' },
      limit: { type: 'integer', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
  },
  optionalArgs: ['offset', 'limit'],
  pathArgs: ['path'],
  executorHints: [
    'Pick the file most likely to hold the code this step is about.',
    'Leave offset and limit out unless a previous result showed the file is very large.',
  ],
  risk: 0,
  mutates: false,
  async execute(args, ctx) {
    const path = assertInside(String(args['path'] ?? ''), ctx);
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    const offset = Math.max(1, Number(args['offset'] ?? 1));
    const limit = Number(args['limit'] ?? lines.length);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const body = slice
      .map((line, index) => `${String(offset + index).padStart(width, ' ')}  ${line}`)
      .join('\n');
    return {
      ok: true,
      output: body,
      summary: `read ${displayPath(path, ctx)} (${slice.length} lines)`,
    };
  },
};

const writeFileTool: ToolSpec = {
  name: 'write_file',
  description: 'Create a file or replace its entire contents. Prefer edit_file for small changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'Full new contents of the file.' },
    },
    required: ['path', 'content'],
  },
  pathArgs: ['path'],
  needsFileContext: true,
  executorHints: [
    'content is the complete file exactly as it should end up on disk, from the first line to the last.',
    'When the file already exists its current contents are shown: keep every part the goal does not ask to change.',
    'Never abbreviate. A comment like "// ... rest unchanged" is written to disk literally and destroys the file.',
  ],
  risk: 0.6,
  mutates: true,
  async execute(args, ctx) {
    const path = assertInside(String(args['path'] ?? ''), ctx);
    const content = String(args['content'] ?? '');
    const before = existsSync(path) ? await readFile(path, 'utf8') : '';
    if (before === content) {
      return { ok: true, output: 'no change', summary: `${displayPath(path, ctx)} already up to date` };
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    const diff = diffLines(before, content, displayPath(path, ctx));
    return {
      ok: true,
      output: `wrote ${content.length} bytes`,
      diff,
      summary: `${before ? 'rewrote' : 'created'} ${displayPath(path, ctx)}`,
    };
  },
};

const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must appear verbatim and must be unique unless replace_all is set.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to replace, including indentation.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  optionalArgs: [],
  closedArgs: { replace_all: ['false', 'true'] },
  pathArgs: ['path'],
  needsFileContext: true,
  executorHints: [
    'Copy old_string character-for-character from the current file contents shown: same indentation, same line breaks, no line numbers.',
    'Include two or three unchanged neighbouring lines in old_string so it occurs exactly once.',
    'new_string replaces the whole of old_string, so repeat those neighbouring lines in it unchanged.',
  ],
  risk: 0.5,
  mutates: true,
  async execute(args, ctx) {
    const path = assertInside(String(args['path'] ?? ''), ctx);
    const oldString = String(args['old_string'] ?? '');
    const newString = String(args['new_string'] ?? '');
    const replaceAll = args['replace_all'] === true || args['replace_all'] === 'true';

    if (!oldString) throw new Error('old_string must not be empty');
    const before = await readFile(path, 'utf8');
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${displayPath(path, ctx)}`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string appears ${occurrences} times in ${displayPath(path, ctx)} — add more context or set replace_all.`,
      );
    }
    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    await writeFile(path, after, 'utf8');
    return {
      ok: true,
      output: `replaced ${replaceAll ? occurrences : 1} occurrence(s)`,
      diff: diffLines(before, after, displayPath(path, ctx)),
      summary: `edited ${displayPath(path, ctx)}`,
    };
  },
};

const listDirTool: ToolSpec = {
  name: 'list_dir',
  description: 'List the immediate entries of a directory.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory, relative to the workspace root.' } },
  },
  optionalArgs: ['path'],
  pathArgs: ['path'],
  executorHints: ['Use "." for the workspace root. Directories only, never a file.'],
  risk: 0,
  mutates: false,
  async execute(args, ctx) {
    const path = assertInside(String(args['path'] ?? '.'), ctx);
    const entries = await readdir(path, { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map(async (entry) => {
          const info = await stat(join(path, entry.name));
          const suffix = entry.isDirectory() ? '/' : '';
          return `${entry.isDirectory() ? 'd' : '-'} ${String(info.size).padStart(8, ' ')}  ${entry.name}${suffix}`;
        }),
    );
    return {
      ok: true,
      output: rows.join('\n') || '(empty)',
      summary: `listed ${displayPath(path, ctx)} (${rows.length} entries)`,
    };
  },
};

const globTool: ToolSpec = {
  name: 'glob',
  description: 'Find files by glob pattern, e.g. "src/**/*.ts". Sorted by path.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Directory to search from.' },
    },
    required: ['pattern'],
  },
  optionalArgs: ['path'],
  pathArgs: ['path'],
  executorHints: ['Patterns match paths relative to the workspace root, e.g. "src/**/*.ts". Supports *, **, ? and {a,b}.'],
  risk: 0,
  mutates: false,
  async execute(args, ctx) {
    const pattern = String(args['pattern'] ?? '');
    const root = assertInside(String(args['path'] ?? '.'), ctx);
    const regex = globToRegExp(pattern);
    const matches = (await walk(root))
      .map((file) => displayPath(file, ctx))
      .filter((file) => regex.test(file))
      .sort();
    return {
      ok: true,
      output: matches.slice(0, 500).join('\n') || '(no matches)',
      summary: `glob ${pattern} → ${matches.length} file(s)`,
    };
  },
};

const grepTool: ToolSpec = {
  name: 'grep',
  description: 'Search file contents with a regular expression. Returns path:line:match.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression.' },
      path: { type: 'string', description: 'Directory to search from.' },
      glob: { type: 'string', description: 'Restrict to files matching this glob.' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
    },
    required: ['pattern'],
  },
  optionalArgs: ['path', 'glob', 'ignore_case'],
  pathArgs: ['path'],
  executorHints: [
    'pattern is a JavaScript regular expression matched line by line: escape ( ) [ ] { } . * + ? | \\ when you mean them literally.',
    'Search for an identifier, a string literal or an error message from the history — not a sentence describing the goal.',
  ],
  risk: 0,
  mutates: false,
  async execute(args, ctx) {
    const pattern = String(args['pattern'] ?? '');
    const root = assertInside(String(args['path'] ?? '.'), ctx);
    const fileGlob = args['glob'] ? globToRegExp(String(args['glob'])) : undefined;
    const flags = args['ignore_case'] === true || args['ignore_case'] === 'true' ? 'i' : '';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }

    const hits: string[] = [];
    for (const file of await walk(root)) {
      const rel = displayPath(file, ctx);
      if (fileGlob && !fileGlob.test(rel)) continue;
      let content: string;
      try {
        const info = await stat(file);
        if (info.size > 2_000_000) continue;
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (regex.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 240)}`);
          if (hits.length >= 300) break;
        }
      }
      if (hits.length >= 300) break;
    }
    return {
      ok: true,
      output: hits.join('\n') || '(no matches)',
      summary: `grep /${pattern}/ → ${hits.length} hit(s)`,
    };
  },
};

const runShellTool: ToolSpec = {
  name: 'run_shell',
  description: 'Run a shell command in the workspace and capture stdout, stderr, and exit code.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'Shell command to run.' } },
    required: ['command'],
  },
  commandArgs: ['command'],
  executorHints: [
    'One non-interactive command that exits on its own: no watch mode, no dev servers, no editors, pagers or prompts.',
    'Prefer the commands this workspace defines. To verify, run the narrowest check that proves the change.',
  ],
  risk: 0.85,
  mutates: true,
  async execute(args, ctx) {
    const command = String(args['command'] ?? '');
    if (!command.trim()) throw new Error('command must not be empty');
    return await new Promise<ToolResult>((resolvePromise) => {
      // `detached` puts the command in its own process group, so an interrupt can signal the group
      // (`-pid`) and take its children down with it. Without it, `-pid` would address *our* group.
      // `@types/node` omits `detached` from `ExecOptions`, but `exec` forwards it to `spawn`, which
      // does honour it, so the option is cast rather than dropped.
      const execOptions: ExecOptions = {
        cwd: ctx.workspace,
        timeout: ctx.bashTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        shell: '/bin/bash',
      };
      (execOptions as { detached?: boolean }).detached = true;
      const child = exec(
        command,
        execOptions,
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          clearTimeout(killTimer);
          ctx.signal?.removeEventListener('abort', onAbort);
          const combined = [String(stdout), String(stderr)].filter(Boolean).join('\n').trimEnd();
          const code = error && 'code' in error ? (error as { code?: number }).code : 0;
          resolvePromise({
            ok: !error,
            output: `exit ${code ?? 0}\n${combined || '(no output)'}`,
            summary: `${error ? 'failed' : 'ran'}: ${command.slice(0, 80)}`,
          });
        },
      );
      // `exec`'s own `timeout` only bounds the command, and a TUI interrupt aborts the agent loop
      // without touching the child — so ctrl-c would leave the command running while the UI claimed
      // to be stopping it. SIGTERM the group first, SIGKILL it if it ignores that.
      let killTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, 2000);
        killTimer.unref();
      };
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

const doneTool: ToolSpec = {
  name: 'done',
  description:
    'Declare the task finished. Only Jev decides when this is the right call, and only after the goal is met.',
  parameters: { type: 'object', properties: {}, required: [] },
  risk: 0,
  mutates: false,
  async execute() {
    return { ok: true, output: 'finished', summary: 'declared done' };
  },
};

export const TOOL_REGISTRY: ToolSpec[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  runShellTool,
  doneTool,
];

export const TOOLS_BY_NAME = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));

/** Everything except `done`, which is a verdict rather than an action. */
export const ACTION_TOOLS = TOOL_REGISTRY.filter((tool) => tool.name !== 'done');

export function toolSpecsForLlm(only?: string[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const tools = only ? TOOL_REGISTRY.filter((tool) => only.includes(tool.name)) : ACTION_TOOLS;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** One line per tool, used in Jev's state so the router knows what is on the menu. */
export function toolMenuText(): string {
  return ACTION_TOOLS.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
}

export function workspaceSummary(ctx: ToolContext): string {
  const rel = (path: string) => relative(ctx.workspace, path).split(sep).join('/');
  return `workspace: ${rel(ctx.workspace) || '.'}`;
}
