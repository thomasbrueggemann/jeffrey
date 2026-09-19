import type { HistoryEntry } from './decider.js';

/**
 * The trajectory ledger: what the run has established, kept by the agent rather than by a model.
 *
 * Neither model remembers anything between calls — Jev scores a snapshot, the executor fills in a
 * fresh brief — and both only see the last few steps. A regular coding agent carries its trajectory
 * in its transcript; here it has to be carried explicitly. Most of it is deterministic bookkeeping
 * over the history (what changed, what was verified since, what already failed). The two parts
 * that need judgement come from the executor: the acceptance criteria, written once, and the facts
 * the reporter extracts after each step. Jev only ever reads the ledger and scores against it.
 */

export interface Criterion {
  id: number;
  text: string;
  met: boolean;
  /** Jev's probability on the latest decision. */
  p: number;
  /** The step on which it last became met. */
  metAtStep?: number;
}

export interface Fact {
  step: number;
  text: string;
  /** Files the step worked on. A later change to one of them makes the fact stale. */
  paths: string[];
  stale: boolean;
}

interface Verification {
  command: string;
  step: number;
  ok: boolean;
  result: string;
}

interface Failure {
  signature: string;
  step: number;
  times: number;
  reason: string;
}

/** What Jev's state and the executor's brief carry. Plain data, already trimmed to budget. */
export interface LedgerView {
  criteria?: Array<{ id: number; text: string; status: 'met' | 'open' }>;
  /** The first unmet criterion — what the next steps should move. */
  focus?: string;
  steps_since_criteria_changed?: number;
  files_changed?: Array<{ path: string; steps: number[] }>;
  verification?: Array<{ command: string; step: number; ok: boolean; result: string; files_changed_since: boolean }>;
  failed_attempts?: Array<{ call: string; step: number; times: number; reason: string }>;
  facts?: Array<{ step: number; text: string; stale?: true }>;
}

const FILE_MUTATORS = new Set(['write_file', 'edit_file']);
const MAX_FACTS = 20;
const MAX_FAILURES = 12;

export class Ledger {
  criteria: Criterion[] = [];
  readonly facts: Fact[] = [];
  readonly mutations = new Map<string, number[]>();
  readonly verifications = new Map<string, Verification>();
  readonly failures: Failure[] = [];
  /** The step on which the set of met criteria last changed. */
  private criteriaChangedAt = 0;

  setCriteria(texts: string[]): void {
    this.criteria = texts.map((text, index) => ({ id: index + 1, text, met: false, p: 0 }));
  }

  /** Fold one finished step into the ledger. Called for every recorded history entry. */
  observe(entry: HistoryEntry): void {
    const path = typeof entry.args['path'] === 'string' ? entry.args['path'] : undefined;

    if (!entry.ok) {
      const signature = `${entry.tool}(${signatureArgs(entry.args)})`;
      const reason = firstLine(entry.observation);
      const known = this.failures.find((failure) => failure.signature === signature);
      if (known) {
        known.times += 1;
        known.step = entry.step;
        known.reason = reason;
      } else {
        this.failures.push({ signature, step: entry.step, times: 1, reason });
        if (this.failures.length > MAX_FAILURES) this.failures.shift();
      }
    }

    if (entry.ok && path && FILE_MUTATORS.has(entry.tool)) {
      this.mutations.set(path, [...(this.mutations.get(path) ?? []), entry.step]);
      for (const fact of this.facts) {
        if (fact.step < entry.step && fact.paths.includes(path)) fact.stale = true;
      }
    }

    if (entry.tool === 'run_shell' && typeof entry.args['command'] === 'string') {
      const command = entry.args['command'];
      // Keyed by command so re-running the tests replaces the old result instead of piling up.
      this.verifications.delete(command);
      this.verifications.set(command, { command, step: entry.step, ok: entry.ok, result: lastLine(entry.observation) });
    }
  }

  /** Record facts the reporter extracted from a step. Duplicates refresh rather than repeat. */
  addFacts(step: number, texts: string[], paths: string[]): void {
    for (const raw of texts) {
      const text = raw.trim();
      if (!text) continue;
      const key = normalise(text);
      const index = this.facts.findIndex((fact) => normalise(fact.text) === key);
      if (index !== -1) this.facts.splice(index, 1);
      this.facts.push({ step, text, paths, stale: false });
    }
    while (this.facts.length > MAX_FACTS) this.facts.shift();
  }

  /**
   * Apply Jev's per-criterion answers. Status follows the latest answer rather than latching, since
   * a later edit can break something that was met. Returns the ids whose status changed.
   */
  applyCriteria(answers: Record<number, number>, step: number, threshold: number): number[] {
    const changed: number[] = [];
    for (const criterion of this.criteria) {
      const p = answers[criterion.id];
      if (p === undefined) continue;
      criterion.p = p;
      const met = p >= threshold;
      if (met === criterion.met) continue;
      criterion.met = met;
      if (met) criterion.metAtStep = step;
      else delete criterion.metAtStep;
      changed.push(criterion.id);
    }
    if (changed.length) this.criteriaChangedAt = step;
    return changed;
  }

  firstOpen(): Criterion | undefined {
    return this.criteria.find((criterion) => !criterion.met);
  }

  allMet(): boolean {
    return this.criteria.every((criterion) => criterion.met);
  }

  /** The ledger as data, trimmed oldest-first until it fits `maxChars` of JSON. */
  view(step: number, maxChars = 2500): LedgerView {
    const lastMutation = Math.max(0, ...[...this.mutations.values()].flat());
    const view: LedgerView = {};

    if (this.criteria.length) {
      view.criteria = this.criteria.map((c) => ({ id: c.id, text: c.text, status: c.met ? 'met' : 'open' }));
      const open = this.firstOpen();
      if (open) view.focus = `criterion ${open.id}: ${open.text}`;
      view.steps_since_criteria_changed = Math.max(0, step - 1 - this.criteriaChangedAt);
    }
    if (this.mutations.size) {
      view.files_changed = [...this.mutations.entries()].map(([path, steps]) => ({ path, steps }));
    }
    if (this.verifications.size) {
      view.verification = [...this.verifications.values()].map((v) => ({
        command: v.command,
        step: v.step,
        ok: v.ok,
        result: clip(v.result, 200),
        files_changed_since: lastMutation > v.step,
      }));
    }
    if (this.failures.length) {
      view.failed_attempts = this.failures.map((f) => ({ call: f.signature, step: f.step, times: f.times, reason: clip(f.reason, 200) }));
    }
    if (this.facts.length) {
      view.facts = this.facts.map((f) => ({ step: f.step, text: f.text, ...(f.stale ? { stale: true as const } : {}) }));
    }

    // Criteria and the file list are the spine; facts and failures are what can be shed.
    while (JSON.stringify(view).length > maxChars) {
      if (view.facts?.length) view.facts.shift();
      else if (view.failed_attempts?.length) view.failed_attempts.shift();
      else if (view.verification && view.verification.length > 1) view.verification.shift();
      else break;
    }
    if (view.facts && !view.facts.length) delete view.facts;
    if (view.failed_attempts && !view.failed_attempts.length) delete view.failed_attempts;
    return view;
  }
}

/** The ledger as prose for the executor, which reads text better than JSON. */
export function describeLedger(view: LedgerView): string[] {
  const lines: string[] = [];
  if (view.criteria?.length) {
    lines.push('Done means all of these:');
    for (const c of view.criteria) lines.push(`  [${c.status === 'met' ? 'x' : ' '}] ${c.id}. ${c.text}`);
    if (view.focus) lines.push(`Currently open: ${view.focus}`);
  }
  if (view.files_changed?.length) {
    lines.push(`Files changed so far: ${view.files_changed.map((f) => `${f.path} (step ${f.steps.join(', ')})`).join('; ')}`);
  }
  if (view.verification?.length) {
    lines.push('Commands run:');
    for (const v of view.verification) {
      lines.push(`  ${v.command} → ${v.ok ? 'ok' : 'failed'} at step ${v.step}${v.files_changed_since ? ' (files changed since)' : ''}: ${v.result}`);
    }
  }
  if (view.failed_attempts?.length) {
    lines.push('Already failed — do not repeat unchanged:');
    for (const f of view.failed_attempts) lines.push(`  ${f.call}${f.times > 1 ? ` ×${f.times}` : ''}: ${f.reason}`);
  }
  if (view.facts?.length) {
    lines.push('Established:');
    for (const f of view.facts) lines.push(`  - ${f.text} (step ${f.step}${f.stale ? ', file changed since' : ''})`);
  }
  return lines;
}

/**
 * Numbered or bulleted lines from the executor's criteria reply. Anything else — a preamble, a
 * sign-off — is ignored, and a reply with no list at all yields nothing so the caller can fall back.
 */
export function parseCriteria(text: string, max = 5): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) out.push(match[1].replace(/\*\*/g, ''));
  }
  return out.slice(0, max);
}

/** Split a reporter reply into its note and its `FACT:` lines. */
export function splitFacts(text: string, max = 2): { note: string; facts: string[] } {
  const facts: string[] = [];
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]?\s*FACT:\s*(.+)$/i.exec(line);
    if (match?.[1]) facts.push(match[1].trim());
    else rest.push(line);
  }
  return { note: rest.join('\n').trim(), facts: facts.slice(0, max) };
}

function signatureArgs(args: Record<string, unknown>): string {
  return (
    Object.entries(args)
      .map(([key, value]) => `${key}=${typeof value === 'string' && value.length > 60 ? `<${value.length} chars>` : JSON.stringify(value)}`)
      .join(', ') || ''
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** A command's verdict is usually at the end: the test summary, the compiler's error count. */
function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.at(-1)?.trim() ?? '';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
}
