import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { localImports, syntaxProblem } from './languages.js';
import type { HistoryEntry } from './decider.js';
import type { ToolSpec } from './tools.js';
import { describeLedger, type LedgerView } from './ledger.js';

/**
 * Everything the executor LLM is told, in one place.
 *
 * The executor is usually a small local model. It cannot see the workspace, it does not remember the
 * last step, and it has no idea why Jev chose this tool — unless the prompt says so. Most bad tool
 * calls were not reasoning failures but missing inputs: an `old_string` guessed because the file was
 * never shown, a path invented because no file list was given. So the brief carries the inputs a
 * call needs, and `validateArgs` catches the calls that would fail anyway before they cost a step.
 */

export const EXECUTOR_SYSTEM = `You are the executor half of a two-model coding agent. A decision model
has chosen the tool and the step's purpose; you write the arguments for that one call, nothing else.

- Settled arguments are fixed. Use them exactly.
- Every other argument is concrete and complete: no placeholders, no "...", no "rest unchanged".
- Serve the step's purpose, not the whole goal.
- Use paths from the workspace files, the history or the contents shown, or a new path when the step
  creates a file.
- Do not explain. The tool call is the deliverable.`;

/**
 * The reporter's note is not for the user: it lands in Jev's state as `agent_notes`, and Jev scores
 * progress and "goal reached" from it. So it has to carry evidence, not impressions.
 */
export const REPORTER_SYSTEM = `You are the executor half of a two-model coding agent. A tool has just run.
Write a note for the decision model, which scores progress from it. At most three sentences:
1. Whether the call achieved the step's purpose — yes, partly, or no.
2. The concrete evidence: the error message, the file and line, the test counts, the match — quoted, not paraphrased.
3. What the goal still lacks, stated as a fact. Not a suggestion, not a next step. A file in the
   workspace list or written by an earlier step exists: never call it missing. If nothing is lacking, say so.
No preamble, no bullet lists, no markdown.

Then, only if this step established something the rest of the task will need — where code lives, what
a command reports, how something is wired — add up to two lines of the form
FACT: <one durable, specific fact>
Skip them when nothing durable was learned.`;

/**
 * Asked once, before the first step. The criteria are what Jev scores "done" against, so they have
 * to be checkable from evidence a tool can produce — not restatements of the goal.
 */
export const CRITERIA_SYSTEM = `You are the planning half of a two-model coding agent. Before any work starts, turn the
user's goal into the acceptance criteria that define "done".

Rules:
- 2 to 6 criteria, as a numbered list, one per line, nothing else. Use as many as the goal needs and
  no more.
- Each one must be checkable from evidence a tool can produce: a file's contents, a command's output,
  a test result. The tools read files, search them and run shell commands — nothing can open a
  browser or click through a UI. So state behaviour as the code that implements it ("the handler in
  the routes file rejects an empty title with a 400"), never as what a user sees.
- Each one is proven by a line that will be in a file, so name the file that will hold that line —
  the one where that part of the work belongs, not the one the goal happens to mention first.
- Nothing that can only be shown by an absence ("uses no framework", "makes no network requests").
- Cover what the goal asks for and how it will be shown to work. Do not invent extra scope.
- When the goal asks for tests as well, one criterion is about the test file and what it checks.
- Every file the goal asks for gets a criterion about what has to be in that file. A criterion about
  one file referring to another says nothing about what the other one contains.
- No preamble, no explanation.`;

/** Jev's answer to "what is this call for?", phrased for the executor. */
export const STEP_INTENTS: Record<string, string> = {
  locate: 'find where the code relevant to the goal lives',
  inspect: 'read code that has to be understood before it can be changed',
  change: 'make the change the goal asks for',
  verify: 'check that a change already made actually works',
  repair: 'fix the failure shown by the most recent step',
};

export interface FileContext {
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
  /** Shown because this file imports it, as reference rather than as the call's target. */
  importedBy?: string;
}

export interface BriefInput {
  goal: string;
  workspace: string;
  intent?: string;
  /** The progress rubric level Jev scored, as text. */
  stage?: string;
  /** Loop diagnosis and user answers Jev was steered with on this decision. */
  steering: string[];
  notes: string;
  history: HistoryEntry[];
  candidates: string[];
  scripts: string[];
  files: FileContext[];
  /** Characters of the most recent observations kept verbatim. */
  observationChars: number;
  /** What the run has established so far, beyond the history window. */
  ledger?: LedgerView;
  /** The acceptance criteria as written, which do not change between steps. */
  criteria?: Array<{ id: number; text: string }>;
  /** Every file in the workspace, by name. */
  workspaceFiles?: string[];
}

/**
 * The same system turn for every call, so consecutive requests share a prefix the server can serve
 * from its cache. What is specific to one tool rides in the instruction turn at the end, where it
 * changes nothing the cache depends on.
 */
export function executorSystem(tools: ToolSpec[], extra?: string): string {
  // Every tool's rules, always, in tool order: text that is the same on every call belongs in the
  // part of the request a cache can serve. No schema here: the request's tool definitions carry it.
  const rules = tools
    .filter((tool) => tool.executorHints?.length)
    .map((tool) => `For ${tool.name}:\n${tool.executorHints!.map((hint) => `- ${hint}`).join('\n')}`)
    .join('\n\n');
  return [EXECUTOR_SYSTEM, extra, rules].filter(Boolean).join('\n\n');
}

export function buildBrief(input: BriefInput): string {
  // Ordered from what changes least to what changes every step, so consecutive calls share a long
  // prefix a server can serve from its cache: the goal, the files and their contents, the ledger and
  // history, and only then what this one step is for.
  // No absolute workspace path: shown one, a small model writes absolute paths and garbles them
  // (a dropped directory once sent a whole file outside the workspace, refused, and rewritten).
  const lines = [`Goal: ${input.goal}`, 'Workspace: the current folder. Every path is relative to it, e.g. index.html or src/app.ts.'];
  if (input.workspaceFiles?.length) lines.push('', `Files in the workspace: ${input.workspaceFiles.join(', ')}`);

  // The criteria's wording never changes, so it belongs in the part of the brief that is the same on
  // every call; how they stand is in the ledger further down, where it changes freely.
  if (input.criteria?.length) {
    lines.push('', 'What this run has to show:');
    for (const criterion of input.criteria) lines.push(`  ${criterion.id}. ${criterion.text}`);
  }
  if (input.candidates.length) {
    lines.push('', `Files most likely relevant: ${input.candidates.join(', ')}`);
  }
  if (input.scripts.length) {
    lines.push(`Commands this workspace defines: ${input.scripts.join(', ')}`);
  }

  for (const file of input.files) {
    if (!file.exists) {
      lines.push('', `${file.path} does not exist yet.`);
      continue;
    }
    lines.push(
      '',
      file.importedBy
        ? `${file.path}, which ${file.importedBy} imports — what it offers, for reference:`
        : `Current contents of ${file.path}${file.truncated ? ' (truncated)' : ''} — copy from here verbatim, no line numbers:`,
      fence(file.content),
    );
  }

  const ledger = input.ledger ? describeLedger(input.ledger) : [];
  if (ledger.length) lines.push('', ...ledger);

  const history = input.history.slice(-8);
  lines.push('', history.length ? 'History so far:' : 'No steps have run yet.');
  for (const entry of history) {
    lines.push(`  step ${entry.step}: ${entry.tool}(${summariseArgs(entry.args)}) → ${entry.ok ? 'ok' : 'failed'} — ${firstLine(entry.observation)}`);
  }

  // A one-liner is enough to follow the story, but not to act on: the last result is usually the
  // very thing this call has to use (the grep hit, the compiler error, the failing assertion).
  const shown = new Set(input.files.filter((file) => file.exists && !file.truncated).map((file) => file.path));
  for (const entry of history.slice(-2)) {
    if (!entry.observation.includes('\n') && entry.observation.length <= 160) continue;
    // A read of a file whose current contents are shown above is the same text again, with line
    // numbers a copied old_string then carries.
    if (entry.tool === 'read_file' && shown.has(String(entry.args['path'] ?? ''))) continue;
    lines.push('', `Full result of step ${entry.step} (${entry.tool}):`, fence(clamp(entry.observation, input.observationChars)));
  }

  // The last command failure is what a repair has to fix, and a read or two after it pushes it out of
  // the window above. It stays until another command runs.
  const lastCommand = input.history.findLast((entry) => entry.tool === 'run_shell');
  if (lastCommand && !lastCommand.ok && !history.slice(-2).includes(lastCommand)) {
    lines.push('', `Output of the command that failed at step ${lastCommand.step}:`, fence(clamp(lastCommand.observation, input.observationChars)));
  }

  if (input.notes) lines.push('', `Note from the last step: ${input.notes}`);

  if (input.intent || input.stage) lines.push('');
  if (input.intent) lines.push(`This step is for: ${STEP_INTENTS[input.intent] ?? input.intent}`);
  if (input.stage) lines.push(`Where the work stands: ${input.stage}`);
  if (input.steering.length) {
    lines.push('', 'The decision model was told this before choosing, and it applies to you too:');
    for (const entry of input.steering) lines.push(indent(entry));
  }
  return lines.join('\n');
}

/** The instruction turn. Repeated in full on a repair so a small model does not lose the thread. */
export function callMessage(
  tool: ToolSpec,
  settled: Record<string, string>,
  problems: string[] = [],
  open: Array<{ id: number; text: string }> = [],
): string {
  const keys = Object.keys(settled);
  const lines = [`Call this tool now: ${tool.name}`, ''];
  if (keys.length) {
    lines.push('The decision model has already settled these arguments — use them exactly:');
    for (const key of keys) lines.push(`  ${key} = ${JSON.stringify(settled[key])}`);
  } else {
    lines.push('The decision model settled no arguments; you must supply all of them.');
  }
  if (problems.length) {
    lines.push('', 'Your previous call for this step was rejected before it ran:');
    for (const problem of problems) lines.push(`  - ${problem}`);
    lines.push('Fix exactly these problems and produce the call again.');
  }
  if (open.length) {
    lines.push('', 'Acceptance criteria not yet shown to be met:');
    for (const criterion of open) lines.push(`  ${criterion.id}. ${criterion.text}`);
    lines.push(
      'In criteria_met, list each one this call makes true as "<id>: <a line of the file after this call, copied exactly>".',
      'Only criteria this call really meets; leave it empty otherwise.',
    );
  }
  lines.push('', 'Produce the tool call.');
  return lines.join('\n');
}

/**
 * The files this call has to see. For a mutating file tool that is its target — settled by Jev, or
 * already named in the executor's own call. Otherwise it is whatever the recent history worked on,
 * then the best-ranked candidate, so an unsettled `edit_file` still has something real to copy from.
 */
/** Candidate order first, then settled targets, so the list does not reshuffle between steps. */
function rank(path: string, candidates: string[], settled: string[]): number {
  const at = candidates.indexOf(path);
  if (at >= 0) return at;
  return candidates.length + settled.indexOf(path) + 1;
}

export function gatherFiles(input: {
  /** Imported files Jev was asked about, and the ones it judged this call needs. A file Jev was not
   * asked about is shown: the allowlist withholds only what Jev turned down. */
  references?: { asked: string[]; wanted: string[] };
  tool: ToolSpec;
  settled: Record<string, string>;
  history: HistoryEntry[];
  candidates: string[];
  workspace: string;
  budget: number;
}): FileContext[] {
  const { tool, settled, history, candidates, workspace, budget } = input;
  if (!tool.needsFileContext) return [];

  const settledPaths = (tool.pathArgs ?? []).map((arg) => settled[arg]).filter((p): p is string => Boolean(p));
  const touched = history
    .slice(-6)
    .reverse()
    .map((entry) => entry.args['path'])
    .filter((p): p is string => typeof p === 'string');
  // The same files, in the same order, on every call of a run: a brief that shows a different file
  // each step shares no prefix with the last one, and the server's cache never hits. The target is
  // always in it; the other slot goes to the best-ranked candidate, whichever step this is.
  const pinned = candidates.slice(0, 2);
  const ordered = [...new Set([...pinned, ...settledPaths, ...(settledPaths.length ? [] : touched)])].sort(
    (a, b) => rank(a, candidates, settledPaths) - rank(b, candidates, settledPaths),
  );
  // The file this step changes goes last. Everything before it is the same text as last step, and a
  // cache can only serve a prefix: put the file that is about to change first and it serves nothing.
  const changing = new Set(tool.mutates ? settledPaths : []);
  ordered.sort((a, b) => Number(changing.has(a)) - Number(changing.has(b)));

  const out: FileContext[] = [];
  let remaining = budget;
  for (const path of [...new Set(ordered)]) {
    if (out.length >= 3 || remaining <= 0) break;
    const absolute = inside(workspace, path);
    if (!absolute) continue;
    if (!existsSync(absolute)) {
      if (settledPaths.includes(path)) out.push({ path, content: '', exists: false, truncated: false });
      continue;
    }
    try {
      if (!statSync(absolute).isFile()) continue;
      const raw = readFileSync(absolute, 'utf8');
      if (raw.includes('\u0000')) continue;
      const truncated = raw.length > remaining;
      out.push({ path, content: truncated ? raw.slice(0, remaining) : raw, exists: true, truncated });
      remaining -= raw.length;
    } catch {
      // unreadable: the executor gets no contents, and validation will say why the call fails
    }
  }

  // What the target imports from the project. A change that calls into another module has to know
  // what that module offers: shown only server.js, the executor called a store.update() that
  // notes.js never had, and every PATCH was a 500.
  // Which of them is worth its tokens is Jev's call, when it was asked: everything shown here is
  // prompt the executor pays for on every attempt.
  const target = out.find((file) => file.exists);
  if (target) {
    const references = input.references;
    for (const path of localImports(workspace, target.path, target.content)) {
      if (out.length >= 4 || remaining <= 0) break;
      if (references?.asked.includes(path) && !references.wanted.includes(path)) continue;
      if (out.some((file) => file.path === path)) continue;
      try {
        const raw = readFileSync(resolve(workspace, path), 'utf8');
        if (raw.includes('\u0000') || raw.length > remaining) continue;
        out.push({ path, content: raw, exists: true, truncated: false, importedBy: target.path });
        remaining -= raw.length;
      } catch {
        // unreadable import: skip it
      }
    }
  }
  return out;
}

/**
 * Reject calls that cannot work before they run. Each problem is phrased as an instruction the
 * executor can act on in a repair round; the ones that survive the repairs become the step's
 * observation, which gives Jev a precise failure instead of a garbled tool run.
 */
/**
 * An edit whose old_string matches the file except for leading whitespace, or carries the line
 * numbers of a read result, is the most common rejected call: copied from the numbered listing,
 * its indentation is shifted. Matched line by line with indentation ignored, a unique hit is taken
 * with the file's own text as old_string and new_string shifted by the same amount. Anything
 * ambiguous is left for validation to reject.
 */
export function alignEdit(args: Record<string, unknown>, workspace: string): Record<string, unknown> {
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const absolute = path ? inside(workspace, path) : undefined;
  if (!absolute || !existsSync(absolute) || typeof args['old_string'] !== 'string' || typeof args['new_string'] !== 'string') return args;
  const text = readFileSync(absolute, 'utf8');
  const unnumbered = (value: string) => {
    const lines = value.split('\n');
    const numbered = lines.filter((line) => line.trim()).every((line) => /^\s*\d+ {2}/.test(line));
    return numbered ? lines.map((line) => line.replace(/^\s*\d+ {2}/, '')).join('\n') : value;
  };
  const oldString = unnumbered(args['old_string']);
  const newString = unnumbered(args['new_string']);
  if (!oldString.trim() || text.includes(args['old_string'])) return args;
  if (text.includes(oldString)) return { ...args, old_string: oldString, new_string: newString };

  const want = oldString.replace(/\n$/, '').split('\n');
  const lines = text.split('\n');
  const same = (a: string, b: string) => a.trim() === b.trim();
  const hits: number[] = [];
  for (let at = 0; at + want.length <= lines.length && hits.length < 2; at++) {
    if (want.every((line, k) => same(line, lines[at + k]!))) hits.push(at);
  }
  if (hits.length !== 1) return args;
  const actual = lines.slice(hits[0]!, hits[0]! + want.length);
  const first = want.findIndex((line) => line.trim());
  const indent = (line: string) => line.length - line.trimStart().length;
  const shift = indent(actual[first]!) - indent(want[first]!);
  const pad = actual[first]!.startsWith('\t') ? '\t' : ' ';
  const shifted = newString
    .split('\n')
    .map((line) => (!line.trim() ? line : shift >= 0 ? pad.repeat(shift) + line : line.slice(Math.min(-shift, indent(line)))))
    .join('\n');
  return { ...args, old_string: actual.join('\n') + (oldString.endsWith('\n') ? '\n' : ''), new_string: shifted };
}

export function validateArgs(tool: ToolSpec, args: Record<string, unknown>, workspace: string): string[] {
  const problems: string[] = [];
  const properties = (tool.parameters['properties'] ?? {}) as Record<string, { type?: string }>;
  const required = (tool.parameters['required'] ?? []) as string[];

  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null) problems.push(`"${name}" is required and was missing.`);
    else if (properties[name]?.type === 'string' && typeof value !== 'string') {
      problems.push(`"${name}" must be a string, got ${typeof value}.`);
    }
  }
  if (problems.length) return problems;

  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  // Outside the workspace is the tool's call to refuse; validation must not read there first.
  const absolute = path ? inside(workspace, path) : undefined;

  switch (tool.name) {
    case 'read_file':
    case 'edit_file':
      if (absolute && !existsSync(absolute)) problems.push(`"${path}" does not exist. Use a path from the workspace files.`);
      break;
    case 'list_dir':
      if (absolute && !existsSync(absolute)) problems.push(`Directory "${path}" does not exist.`);
      break;
  }
  if (problems.length) return problems;

  if (tool.name === 'edit_file' && absolute) {
    const oldString = String(args['old_string']);
    const newString = String(args['new_string']);
    if (!oldString) {
      problems.push('"old_string" is empty. Copy the exact lines to replace from the current file contents.');
    } else if (oldString === newString) {
      problems.push('"old_string" and "new_string" are identical, so the edit changes nothing.');
    } else {
      const text = readFileSync(absolute, 'utf8');
      const count = text.split(oldString).length - 1;
      const replaceAll = args['replace_all'] === true || args['replace_all'] === 'true';
      if (count === 0) {
        const near = nearestLine(text, oldString);
        problems.push(
          `"old_string" does not occur in ${path}. Copy it byte-for-byte from the current contents, including indentation.` +
            (near ? ` The closest line in the file is: ${JSON.stringify(near)}` : ''),
        );
      } else if (count > 1 && !replaceAll) {
        problems.push(`"old_string" occurs ${count} times in ${path}. Include enough surrounding lines to make it unique.`);
      } else {
        const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
        const broken = syntaxProblem(absolute, text, next);
        if (broken) problems.push(`The edit would leave ${path} unparseable: ${broken} Fix the edit so the file still parses.`);
      }
    }
  }

  if (tool.name === 'write_file') {
    const content = String(args['content']);
    if (!content.trim()) problems.push('"content" is empty. Write the complete file.');
    const placeholder = PLACEHOLDERS.find((pattern) => pattern.test(content));
    if (placeholder) {
      problems.push(
        'The content contains an elision such as "... rest unchanged". write_file replaces the whole file: write every line out in full.',
      );
    }
    if (absolute && content.trim() && !placeholder) {
      const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
      const broken = syntaxProblem(absolute, before, content);
      if (broken) problems.push(`${path} would not parse: ${broken} Fix it and write the complete file again.`);
    }
  }

  if (tool.name === 'grep') {
    try {
      new RegExp(String(args['pattern']));
    } catch (error) {
      problems.push(`"pattern" is not a valid JavaScript regular expression: ${(error as Error).message}. Escape special characters.`);
    }
  }

  if (tool.name === 'run_shell' && !String(args['command']).trim()) {
    problems.push('"command" is empty.');
  }
  return problems;
}

/** Drop keys the schema does not declare — small models like to add their own. */
export function schemaKeys(tool: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  const properties = (tool.parameters['properties'] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key in properties) out[key] = value;
  }
  return out;
}

/**
 * Elisions only count inside a comment: prose saying "the API remains unchanged" is real content,
 * and so is Python's bare `...`.
 */
const PLACEHOLDERS = [
  /^\s*(\/\/|#|\/\*|<!--|\*)\s*\.\.\.\s*$/m,
  /^\s*(\/\/|#|\/\*|<!--|\*)\s*(\.\.\.\s*)?(rest of|remaining|existing|other|previous|same as before)\b.*\b(unchanged|code|file|here|methods|functions|content)\b/im,
];

function inside(workspace: string, path: string): string | undefined {
  const absolute = resolve(workspace, path);
  const rel = relative(workspace, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : absolute;
}

function nearestLine(text: string, needle: string): string | undefined {
  const first = needle.split('\n').find((line) => line.trim())?.trim();
  if (!first) return undefined;
  const lines = text.split('\n');
  const exact = lines.find((line) => line.trim() === first);
  if (exact !== undefined) return exact;
  const token = first.split(/\W+/).filter((word) => word.length >= 3).sort((a, b) => b.length - a.length)[0];
  return token ? lines.find((line) => line.includes(token)) : undefined;
}

function summariseArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) =>
      typeof value === 'string' && value.length > 60 ? `${key}=<${value.length} chars>` : `${key}=${JSON.stringify(value)}`,
    )
    .join(', ');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim()) ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '~~~~' : '```';
  return `${ticks}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
