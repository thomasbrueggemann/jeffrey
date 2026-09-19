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
  /**
   * A quote from a file on disk that proves the criterion, checked by the agent rather than taken on
   * a model's word. Jev never sees the files whole, so without it criteria about file contents stayed
   * open long after the code was written.
   */
  evidence?: { path: string; quote: string; step: number };
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
  criteria?: Array<{ id: number; text: string; status: 'met' | 'open'; evidence?: string }>;
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

  /** Drop a failure record: for runs whose failure describes the project, not a wrong move. */
  forgetFailure(tool: string, args: Record<string, unknown>): void {
    const signature = `${tool}(${signatureArgs(args)})`;
    const index = this.failures.findIndex((failure) => failure.signature === signature);
    if (index !== -1) this.failures.splice(index, 1);
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
      const met = p >= threshold || Boolean(criterion.evidence);
      if (met === criterion.met) continue;
      criterion.met = met;
      if (met) criterion.metAtStep = step;
      else delete criterion.metAtStep;
      changed.push(criterion.id);
    }
    if (changed.length) this.criteriaChangedAt = step;
    return changed;
  }

  /** Mark a criterion met on a quote the caller has already found in `path`. */
  prove(id: number, path: string, quote: string, step: number): boolean {
    const criterion = this.criteria.find((c) => c.id === id);
    if (!criterion) return false;
    criterion.evidence = { path, quote, step };
    if (criterion.met) return false;
    criterion.met = true;
    criterion.metAtStep = step;
    this.criteriaChangedAt = step;
    return true;
  }

  /**
   * Drop evidence whose quote is no longer in its file: a later edit can remove the very line that
   * proved a criterion. `read` returns the file's current text, or undefined when it is gone.
   */
  recheckEvidence(read: (path: string) => string | undefined, step: number, threshold: number): number[] {
    const changed: number[] = [];
    for (const criterion of this.criteria) {
      const evidence = criterion.evidence;
      if (!evidence) continue;
      const text = read(evidence.path);
      if (text !== undefined && containsQuote(text, evidence.quote)) continue;
      delete criterion.evidence;
      const met = criterion.p >= threshold;
      if (met !== criterion.met) {
        criterion.met = met;
        if (!met) delete criterion.metAtStep;
        changed.push(criterion.id);
      }
    }
    if (changed.length) this.criteriaChangedAt = step;
    return changed;
  }

  /** Whether `command` has run and passed since the last file change. */
  passedSinceLastChange(command: string): boolean {
    const run = this.verifications.get(command);
    const lastMutation = Math.max(0, ...[...this.mutations.values()].flat());
    return Boolean(run?.ok && run.step >= lastMutation);
  }

  /** Whether `command` has run since the last file change, passing or not. */
  ranSinceLastChange(command: string): boolean {
    const run = this.verifications.get(command);
    const lastMutation = Math.max(0, ...[...this.mutations.values()].flat());
    return Boolean(run && run.step >= lastMutation);
  }

  /** Every criterion is proven by a quote from the files — done, without a model's say-so. */
  allProven(): boolean {
    return this.criteria.length > 0 && this.criteria.every((criterion) => criterion.evidence);
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
      view.criteria = this.criteria.map((c) => ({
        id: c.id,
        text: c.text,
        status: c.met ? 'met' : 'open',
        ...(c.evidence ? { evidence: `${c.evidence.path}: ${clip(c.evidence.quote, 120)}` } : {}),
      }));
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
export function splitFacts(
  text: string,
  max = 2,
): { note: string; facts: string[]; proofs: Array<{ id: number; quote: string }> } {
  const facts: string[] = [];
  const proofs: Array<{ id: number; quote: string }> = [];
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const fact = /^\s*[-*]?\s*FACT:\s*(.+)$/i.exec(line);
    const proof = /^\s*[-*]?\s*MET\s+#?(\d+)\s*:\s*(.+)$/i.exec(line);
    if (fact?.[1]) facts.push(fact[1].trim());
    else if (proof?.[1] && proof[2]) proofs.push({ id: Number(proof[1]), quote: unwrapQuote(proof[2]) });
    else rest.push(line);
  }
  return { note: rest.join('\n').trim(), facts: facts.slice(0, max), proofs };
}

/**
 * Whether `quote` occurs in `text`, ignoring whitespace differences. Too short a quote proves
 * nothing ("{" is in every file), so it has to carry at least a few real characters.
 */
export function containsQuote(text: string, quote: string): boolean {
  // Models shorten long quotes with "..." — honest, and each fragment is still checkable: they must
  // all occur, in order. Rejecting them cost an extra step re-reading the file for a verbatim line.
  const fragments = quote.split(/\.\.\.|…/).map(squash).filter(Boolean);
  if (fragments.join('').replace(/\s/g, '').length < 8) return false;
  const haystack = squash(text);
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at === -1) return false;
    from = at + fragment.length;
  }
  return true;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Models wrap quotes in backticks or quotation marks; the file does not contain those. */
function unwrapQuote(raw: string): string {
  let quote = raw.trim();
  const fence = /^(`+|"|')([\s\S]*)\1$/.exec(quote);
  if (fence?.[2]) quote = fence[2].trim();
  return quote;
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
