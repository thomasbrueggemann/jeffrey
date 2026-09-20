import type { ToolSpec } from './tools.js';

/**
 * What to try when the decision model reports that the agent is repeating itself.
 *
 * The ladder used to answer a loop subtractively: withhold whatever ran most often, tell Jev not
 * to repeat itself, ask again. That stops a loop from spinning, but it never proposes anything. An
 * agent stuck because it has been reading the wrong file is told "read something else", not "the
 * file you need has not been found yet — go and search for it".
 *
 * So the loop gets diagnosed instead. Each tactic below pairs a cause the decision model can
 * recognise from the state it already has with the one move that cause implies. Jev picks the
 * cause — a closed-set question about the state, which is the only kind it answers — and the agent
 * enforces the move by restricting the next decision's choice set to it. Advice in the state does
 * not survive a confident model; a shorter option list does.
 *
 * A tactic is offered once per run. The second recovery chooses between what is left, so a loop
 * that survives one approach is answered by a different one rather than a louder version of the
 * same one.
 */
export interface Tactic {
  id: string;
  /**
   * The option Jev chooses between. Phrased as a statement about the state, never as an
   * instruction: System One judges what is true, it does not take advice about what to do.
   */
  cause: string;
  /**
   * The only tools offered on the next decision. Empty means the tactic is not a move at all —
   * see `needs-user`, which hands the loop to the person who can break it.
   */
  tools: string[];
  /** Why the choice set changed, for Jev's next decision and for the executor's brief. */
  instruction: string;
  /** One line for the user, in the imperative: what the agent is about to try instead. */
  attempt: string;
}

/**
 * Ordered by how often each cause is the real one in practice, because the order is also the
 * tie-break: the model that cannot tell them apart lands on the most likely rather than the
 * alphabetically first.
 */
export const TACTICS: readonly Tactic[] = [
  {
    id: 'unverified',
    cause:
      'nothing has actually been executed: the code is being reasoned about rather than run, so no step has produced real evidence about what it does',
    tools: ['run_shell'],
    instruction:
      "Run the project's tests, build, or the program itself, and read the real output. Reasoning about what the code does has not worked; an actual result is the next thing worth having.",
    attempt: 'run something and read the real output',
  },
  {
    id: 'wrong-place',
    cause:
      'the code that has to change has not been found yet: the files being opened are not the ones the goal is about',
    tools: ['grep', 'glob', 'list_dir'],
    instruction:
      'Search the workspace for the code the goal names instead of reopening files already seen. The right file has not been found yet, so looking harder at the wrong one cannot help.',
    attempt: 'search the workspace for the right file',
  },
  {
    id: 'never-written',
    cause:
      'enough has been read already: what is missing is the change itself, which has not been written to any file',
    tools: ['write_file', 'edit_file'],
    instruction:
      'Write the change now. What it has to say is already in the history and the notes; another look adds nothing. Produce the deliverable, with real content.',
    attempt: 'write the change instead of reading more',
  },
  {
    id: 'too-big',
    cause:
      'the change being attempted is too large to land in one step, so every attempt fails in the same way',
    tools: ['edit_file', 'write_file'],
    instruction:
      'Make the smallest part of the change that stands on its own — one file, one function — and leave the rest for the next step. A smaller edit that applies beats a complete one that does not.',
    attempt: 'make one small part of the change',
  },
  {
    id: 'needs-user',
    cause:
      'the loop is a missing fact or decision that no tool can supply: which of several options was meant, a name, a credential, or what the goal actually asks for',
    tools: [],
    instruction: '',
    attempt: 'ask the user',
  },
];

const TACTICS_BY_ID = new Map(TACTICS.map((tactic) => [tactic.id, tactic]));

export function tactic(id: string): Tactic | undefined {
  return TACTICS_BY_ID.get(id);
}

/**
 * The tactics still worth offering: not already tried, and — for the ones that are a move — with
 * at least one of their tools actually available. A tactic whose tools this run does not have is
 * not a way out of anything, and offering it would spend the recovery on a dead end.
 */
export function availableTactics(tried: ReadonlySet<string>, tools: readonly ToolSpec[]): Tactic[] {
  const names = new Set(tools.map((tool) => tool.name));
  return TACTICS.filter(
    (candidate) =>
      !tried.has(candidate.id) &&
      (candidate.tools.length === 0 || candidate.tools.some((name) => names.has(name))),
  );
}

/** A tactic's tools, narrowed to the ones this run has. */
export function tacticTools(candidate: Tactic, tools: readonly ToolSpec[]): string[] {
  const names = new Set(tools.map((tool) => tool.name));
  return candidate.tools.filter((name) => names.has(name));
}

export const LOOP_CAUSE_QUESTION =
  'The agent is repeating itself without making progress. Based on the history and the notes, which of these is the reason it is not getting anywhere?';
