import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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

export const EXECUTOR_SYSTEM = `You are the executor half of a two-model coding agent.

A separate decision model (Jev) has already chosen the tool and what this step is for. That decision
is final: you do not pick a different tool, and you do not decide the task is finished. Your only
output is the arguments for that one tool call.

Rules:
- Arguments the decision model settled are fixed. Use them exactly as given.
- Every other argument must be concrete, complete, and ready to execute. No placeholders, no "...",
  no TODO, no "rest of file unchanged".
- Serve the step's purpose, not the whole goal. A "locate" step finds code; it does not change it.
- Use only paths from the workspace files, the history, or the file contents you were shown — or a
  new path when the step is creating a file.
- Do not explain. The tool call is the deliverable.`;

/**
 * The reporter's note is not for the user: it lands in Jev's state as `agent_notes`, and Jev scores
 * progress and "goal reached" from it. So it has to carry evidence, not impressions.
 */
export const REPORTER_SYSTEM = `You are the executor half of a two-model coding agent. A tool has just run.
Write a note for the decision model, which scores progress from it. At most three sentences:
1. Whether the call achieved the step's purpose — yes, partly, or no.
2. The concrete evidence: the error message, the file and line, the test counts, the match — quoted, not paraphrased.
3. What the goal still lacks, stated as a fact. Not a suggestion, not a next step.
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
- 2 to 5 criteria, as a numbered list, one per line, nothing else.
- Each one must be checkable from evidence a tool can produce: a file's contents, a command's output,
  a test result.
- Cover what the goal asks for and how it will be shown to work. Do not invent extra scope.
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
}

export function executorSystem(tool: ToolSpec, extra?: string): string {
  const parts = [EXECUTOR_SYSTEM];
  if (extra) parts.push(extra);
  if (tool.executorHints?.length) {
    parts.push(`For ${tool.name}:\n${tool.executorHints.map((hint) => `- ${hint}`).join('\n')}`);
  }
  // The schema stays last: the mock executor reads it back as the trailing JSON object.
  parts.push(`Tool schema:\n${JSON.stringify(tool.parameters, null, 2)}`);
  return parts.join('\n\n');
}

export function buildBrief(input: BriefInput): string {
  const lines = [`Goal: ${input.goal}`, `Workspace: ${input.workspace}`];
  if (input.intent) lines.push(`This step is for: ${STEP_INTENTS[input.intent] ?? input.intent}`);
  if (input.stage) lines.push(`Where the work stands: ${input.stage}`);

  if (input.steering.length) {
    lines.push('', 'The decision model was told this before choosing, and it applies to you too:');
    for (const entry of input.steering) lines.push(indent(entry));
  }

  if (input.candidates.length) {
    lines.push('', `Files most likely relevant: ${input.candidates.join(', ')}`);
  }
  if (input.scripts.length) {
    lines.push(`Commands this workspace defines: ${input.scripts.join(', ')}`);
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
  for (const entry of history.slice(-2)) {
    if (!entry.observation.includes('\n') && entry.observation.length <= 160) continue;
    lines.push('', `Full result of step ${entry.step} (${entry.tool}):`, fence(clamp(entry.observation, input.observationChars)));
  }

  for (const file of input.files) {
    if (!file.exists) {
      lines.push('', `${file.path} does not exist yet.`);
      continue;
    }
    lines.push(
      '',
      `Current contents of ${file.path}${file.truncated ? ' (truncated)' : ''} — copy from here verbatim, no line numbers:`,
      fence(file.content),
    );
  }

  if (input.notes) lines.push('', `Note from the last step: ${input.notes}`);
  return lines.join('\n');
}

/** The instruction turn. Repeated in full on a repair so a small model does not lose the thread. */
export function callMessage(tool: ToolSpec, settled: Record<string, string>, omitted: string[], problems: string[] = []): string {
  const keys = Object.keys(settled);
  const lines = [`Call this tool now: ${tool.name}`, ''];
  if (keys.length) {
    lines.push('The decision model has already settled these arguments — use them exactly:');
    for (const key of keys) lines.push(`  ${key} = ${JSON.stringify(settled[key])}`);
  } else {
    lines.push('The decision model settled no arguments; you must supply all of them.');
  }
  if (omitted.length) {
    lines.push('', `Omit these optional arguments entirely so the tool default applies: ${omitted.join(', ')}`);
  }
  if (problems.length) {
    lines.push('', 'Your previous call for this step was rejected before it ran:');
    for (const problem of problems) lines.push(`  - ${problem}`);
    lines.push('Fix exactly these problems and produce the call again.');
  }
  lines.push('', 'Produce the tool call.');
  return lines.join('\n');
}

/**
 * The files this call has to see. For a mutating file tool that is its target — settled by Jev, or
 * already named in the executor's own call. Otherwise it is whatever the recent history worked on,
 * then the best-ranked candidate, so an unsettled `edit_file` still has something real to copy from.
 */
export function gatherFiles(input: {
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
  const ordered = settledPaths.length ? settledPaths : [...touched, ...candidates.slice(0, 1)];

  const out: FileContext[] = [];
  let remaining = budget;
  for (const path of [...new Set(ordered)]) {
    if (out.length >= 2 || remaining <= 0) break;
    const absolute = inside(workspace, path);
    if (!absolute) continue;
    if (!existsSync(absolute)) {
      if (settledPaths.includes(path)) out.push({ path, content: '', exists: false, truncated: false });
      continue;
    }
    try {
      if (!statSync(absolute).isFile()) continue;
      const raw = readFileSync(absolute, 'utf8');
      if (raw.includes(' ')) continue;
      const truncated = raw.length > remaining;
      out.push({ path, content: truncated ? raw.slice(0, remaining) : raw, exists: true, truncated });
      remaining -= raw.length;
    } catch {
      // unreadable: the executor gets no contents, and validation will say why the call fails
    }
  }
  return out;
}

/**
 * Reject calls that cannot work before they run. Each problem is phrased as an instruction the
 * executor can act on in a repair round; the ones that survive the repairs become the step's
 * observation, which gives Jev a precise failure instead of a garbled tool run.
 */
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
