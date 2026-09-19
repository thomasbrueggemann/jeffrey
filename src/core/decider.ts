import type { SystemOneResponse, JevDecision, DecisionRoute, Question } from '../types.js';
import { asChoice, asNoul, asScore, choice, noul, score, type JevClient } from './jev.js';
import type { ToolSpec } from './tools.js';
import { STEP_INTENTS } from './executor.js';
import type { LedgerView } from './ledger.js';

export interface HistoryEntry {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  observation: string;
  progress: number;
}

export interface DeciderContext {
  goal: string;
  workspace: string;
  step: number;
  maxSteps: number;
  tools: ToolSpec[];
  /** Workspace files Jev may name directly, which turns "which file?" into a closed-set decision. */
  files: string[];
  history: HistoryEntry[];
  /** Scratchpad the executor wrote for the decider — never shown to the user verbatim. */
  notes: string;
  minConfidence: number;
  goalReachedThreshold: number;
  minProgressScore: number;
  needsInputThreshold: number;
  stuckThreshold: number;
  /**
   * Closed-set values discovered at runtime, keyed `${tool}.${arg}` — the real files in the
   * workspace, the real scripts in package.json. This is what turns "which file?" from a
   * free-text guess into a decision Jev can actually make.
   */
  dynamicOptions: Record<string, string[]>;
  /**
   * Loop diagnosis fed back to Jev after it reports being stuck. Stated as facts it can act on,
   * not as advice — it changes the decision, it does not narrate it.
   */
  steering?: string[];
  /**
   * Tools removed from this decision's choice set because they have already been tried without
   * moving the goal. Physically removing them is the only reliable way to force a different
   * route; asking politely in the state does not survive a confident model.
   */
  excludeTools?: string[];
  /**
   * Acceptance criteria written at the start of the run. Each gets its own yes/no question, and a
   * goal-reached verdict needs every one of them met: "is the goal reached?" asked once is easy to
   * answer optimistically, a checklist is not.
   */
  criteria?: Array<{ id: number; text: string; proven?: boolean }>;
  /**
   * Lines the last step added to files, for open criteria to be proven from. Jev picks the line that
   * shows a criterion holds; the agent checks the quote against the file.
   */
  freshLines?: Array<{ path: string; line: string }>;
  /** Unattended: nothing is approved, so the risk of an action is not asked. */
  autoApprove?: boolean;
  /** Ask Jev whether the executor should think for this step. */
  askEffort?: boolean;
  /**
   * Files the next action's target imports. Each one shown to the executor is prompt it pays for on
   * every attempt, so Jev says which are needed rather than all of them being shown by default.
   */
  referenceCandidates?: string[];
  /** Probability at or above which a criterion counts as met. */
  criterionMetThreshold?: number;
  /** The trajectory so far, beyond the history window. */
  ledger?: LedgerView;
}

export interface DeciderResult {
  decision: JevDecision;
  /** Closed-set argument values Jev picked, keyed `${tool}.${arg}`. */
  argChoices: Record<string, string>;
  /**
   * What the chosen call is for — one of `STEP_INTENTS`. The tool alone underdetermines the call:
   * `read_file` to locate code and `read_file` to check an edit want different arguments.
   */
  intent?: string;
  /** The tools Jev could choose from on this decision. */
  shortlist: string[];
  /** Jev's probability that the executor needs to think for this step, when it was asked. */
  thinking?: number;
  /** Criteria Jev matched to a line the last step wrote. Unchecked: the agent verifies the quote. */
  proofs?: Array<{ id: number; path: string; quote: string }>;
  /** Imported files Jev judged the next call needs to see. */
  references: string[];
}

export const FINISH_OPTION = 'done';
export const ASK_USER_OPTION = 'ask_user';
/**
 * Escape hatch offered alongside every dynamic option list. Without it, a closed-set question
 * would force Jev to name an existing file even when the right answer is to create a new one.
 */
export const EXECUTOR_DECIDES = 'the executor should decide this, not a fixed list';

const PROGRESS_LEVELS = [
  'nothing useful has been established yet',
  'the relevant code has been located but nothing has changed',
  'a concrete change has been made but it is unverified',
  'the change is in place and verified, only incidental cleanup remains',
  'the goal is completely and verifiably satisfied',
];

const RISK_LEVELS = [
  'read-only: cannot change anything',
  'reversible and local to one file, no external effects',
  'reversible but touches several files or a build artifact',
  'hard to reverse: rewrites or deletes files, or runs a state-changing command',
  'irreversible or externally visible: deploys, publishes, deletes data, touches the network',
];

/**
 * The decider. It asks Jev one batch of atomic questions per step and turns the answers into a
 * routing decision.
 *
 * All questions ride in a single request: System One evaluates them in parallel and in isolation,
 * so the marginal cost of the extra questions is close to zero and they cannot bias each other.
 */
export class Decider {
  constructor(
    private readonly client: JevClient,
    private readonly maxArgOptions = 12,
  ) {}

  async decide(ctx: DeciderContext): Promise<DeciderResult> {
    const questions: Record<string, Question> = {};
    const tools = selectableTools(ctx);
    const candidates = tools.map((tool) => tool.name);

    // 1. The routing question. The tools are described once, in the state's tools_available; naming
    //    them here is enough, and saves repeating every description in both questions.
    const actionOptions: Record<string, string | null> = {};
    for (const tool of tools) {
      actionOptions[tool.name] = null;
    }
    actionOptions[FINISH_OPTION] = 'the goal is already met and no further action is needed';
    actionOptions[ASK_USER_OPTION] = 'progress requires a decision, credential, or fact only the user can supply';

    questions['next_action'] = choice(
      'What is the single best next action to take right now? Choose the one action from tools_available that moves this goal forward the most.',
      actionOptions,
    );
    // No separate fallback question: the runner-up in next_action's own probabilities is the same
    // answer, and it was only ever used when the first choice named no real tool.

    // 2. Outcome questions. These are the ones the loop is actually gated on.
    questions['goal_reached'] = noul(
      'Is the goal fully achieved right now, based only on evidence already in the history?',
      {
        true: 'the stated goal is satisfied and the history shows it working or complete',
        false: 'something required by the goal is still missing, unverified, or broken',
      },
    );
    questions['progress'] = score(
      'How much real progress toward the goal has been made so far?',
      PROGRESS_LEVELS,
    );
    questions['stuck'] = noul(
      'Is the agent repeating itself without making progress?',
      {
        true: 'recent steps repeat the same action or produce the same result',
        false: 'recent steps each changed the state of the problem',
      },
    );
    // Asking the user is an option of next_action; a separate probability for it decided nothing.
    // A criterion already proven by a quote from the files is settled: asking Jev again only adds a
    // guess the loop would overrule.
    for (const criterion of (ctx.criteria ?? []).filter((c) => !c.proven)) {
      questions[`criterion.${criterion.id}`] = noul(
        `Is this acceptance criterion satisfied right now, based only on evidence in the history and the ledger? Criterion: ${criterion.text}`,
        {
          true: 'a tool result in the history or ledger shows this criterion holds',
          false: 'there is no evidence yet, or the evidence shows it does not hold',
        },
      );
    }
    // Proof from what the last step wrote: per open criterion, the added lines most like it.
    const fresh = ctx.freshLines ?? [];
    const proofOptions: Record<string, Array<{ path: string; line: string }>> = {};
    if (fresh.length) {
      for (const criterion of (ctx.criteria ?? []).filter((c) => !c.proven)) {
        const ranked = rankLines(fresh, criterion.text).slice(0, Math.min(10, this.maxArgOptions));
        if (!ranked.length) continue;
        proofOptions[String(criterion.id)] = ranked;
        const options: Record<string, string | null> = {};
        for (const entry of ranked) options[entry.line] = null;
        options[NO_PROOF] = 'none of these lines shows it';
        questions[`proof.${criterion.id}`] = choice(
          `The last step wrote these lines. Which one shows this acceptance criterion holds? Criterion: ${criterion.text}`,
          options,
        );
      }
    }

    for (const path of (ctx.referenceCandidates ?? []).slice(0, 4)) {
      questions[`context.${path}`] = noul(`Does the best next action need to see the contents of ${path} to be written correctly?`, {
        true: `the change calls into ${path}, or has to match what it defines`,
        false: `the change can be written without reading ${path}`,
      });
    }

    // Risk only decides whether to ask for approval, which an unattended run never does.
    if (!ctx.autoApprove) {
      questions['risk'] = score(
        'How risky or hard to reverse is the action you selected as next_action?',
        RISK_LEVELS,
      );
    }
    if (ctx.askEffort) {
      questions['needs_thinking'] = noul(
        'If the best next action writes or changes code, does getting it right take careful reasoning?',
        {
          true: 'new logic, several parts that must fit together, or a failure whose cause is not yet clear',
          false: 'a direct change: the files and results already show what to write, or it changes no code',
        },
      );
    }

    // 3. What the next action is for and what it works on, in the same request. They used to be a
    //    second call, asked once the tool was known: the whole state sent twice per step. A file or a
    //    command is mostly the same answer whichever tool acts on it, so one question each covers
    //    every tool, and the answer is applied to the tool that wins.
    questions['step_intent'] = choice('What is the best next action meant to achieve at this point?', STEP_INTENTS);
    const paths = closedValues(ctx, tools, 'pathArgs');
    if (paths.length) {
      questions['target_path'] = choice(
        'Which existing file or folder will the best next action read, change, or search?',
        closedOptions(paths, this.maxArgOptions, 'none of these: a new file, several files, or no file at all'),
      );
    }
    const commands = closedValues(ctx, tools, 'commandArgs');
    if (commands.length) {
      questions['target_command'] = choice(
        'If the best next action runs a command, which one?',
        closedOptions(commands, this.maxArgOptions, 'none of these, or the next action runs no command'),
      );
    }

    const response = await this.client.ask(buildState(ctx), questions);
    const decision = this.interpret(ctx, response, candidates);

    const argChoices: Record<string, string> = {};
    const chosen = tools.find((tool) => tool.name === decision.tool);
    const path = asChoice(response.answers['target_path'])?.choice;
    const command = asChoice(response.answers['target_command'])?.choice;
    for (const arg of chosen?.pathArgs ?? []) {
      if (path && paths.includes(path)) argChoices[`${chosen!.name}.${arg}`] = path;
    }
    for (const arg of chosen?.commandArgs ?? []) {
      if (command && commands.includes(command)) argChoices[`${chosen!.name}.${arg}`] = command;
    }
    const proofs: Array<{ id: number; path: string; quote: string }> = [];
    for (const [id, ranked] of Object.entries(proofOptions)) {
      const answer = asChoice(response.answers[`proof.${id}`]);
      const hit = answer && answer.choice !== NO_PROOF && answer.confidence >= 0.5 ? ranked.find((entry) => entry.line === answer.choice) : undefined;
      if (hit) proofs.push({ id: Number(id), path: hit.path, quote: hit.line });
    }
    const references = (ctx.referenceCandidates ?? [])
      .slice(0, 4)
      .filter((path) => (asNoul(response.answers[`context.${path}`])?.noul ?? 1) >= 0.5);
    const intent = asChoice(response.answers['step_intent'])?.choice;
    const thinking = asNoul(response.answers['needs_thinking'])?.noul;

    return {
      decision,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(proofs.length ? { proofs } : {}),
      references,
      argChoices,
      ...(intent && intent in STEP_INTENTS ? { intent } : {}),
      shortlist: candidates,
    };
  }

  private interpret(ctx: DeciderContext, response: SystemOneResponse, shortlist: string[]): JevDecision {
    const action = asChoice(response.answers['next_action']);
    const goal = asNoul(response.answers['goal_reached']);
    const progress = asScore(response.answers['progress']);
    const stuck = asNoul(response.answers['stuck']);
    const risk = asScore(response.answers['risk']);

    const tool = action?.choice ?? FINISH_OPTION;
    const confidence = action?.confidence ?? 0;
    const goalReached = goal?.noul ?? 0;
    const progressScore = progress?.score ?? 0;
    const stuckP = stuck?.noul ?? 0;
    const needsUserP = tool === ASK_USER_OPTION ? confidence : 0;

    const criteria: Record<string, number> = {};
    for (const criterion of ctx.criteria ?? []) {
      criteria[String(criterion.id)] = criterion.proven ? 1 : (asNoul(response.answers[`criterion.${criterion.id}`])?.noul ?? 0);
    }
    const threshold = ctx.criterionMetThreshold ?? 0.6;
    const criteriaMet = Object.values(criteria).every((p) => p >= threshold);

    const route = routeFor({
      ctx,
      tool,
      confidence,
      goalReached,
      progressScore,
      stuckP,
      needsUserP,
      shortlist,
      criteriaMet,
    });

    return {
      tool,
      probabilities: action?.probabilities ?? {},
      confidence,
      goalReached,
      progress: progressScore,
      progressLegend: progress?.legend ?? legendOf(PROGRESS_LEVELS),
      stuck: stuckP,
      needsUserInput: needsUserP,
      risk: risk?.score ?? 0,
      riskLegend: risk?.legend ?? legendOf(RISK_LEVELS),
      fallbackTool: runnerUp(action?.probabilities ?? {}, tool),
      toolRelevance: action?.probabilities ?? {},
      route,
      ...(ctx.criteria?.length ? { criteria } : {}),
      ...(!criteriaMet && goalReached >= ctx.goalReachedThreshold && progressScore >= ctx.minProgressScore
        ? { criteriaVeto: true }
        : {}),
      raw: response,
    };
  }
}

interface RouteInput {
  ctx: DeciderContext;
  tool: string;
  confidence: number;
  goalReached: number;
  progressScore: number;
  stuckP: number;
  needsUserP: number;
  shortlist: string[];
  /** Every acceptance criterion met, or none were set. */
  criteriaMet: boolean;
}

/**
 * The gate, in strict order of precedence.
 *
 * `ask_user` and `done` are options Jev can *choose*, not tools it can inspect, and the choice is
 * authoritative: it must never be second-guessed by a threshold. The thresholds answer different
 * questions ("does it need a human?" vs "which move is right?"), so gating a selected escape hatch
 * on one of them drops it through to a route that expects a real tool — which is how a legitimate
 * answer turned into "unknown tool".
 *
 * A goal-reached verdict needs both a high probability and a matching progress score — the two
 * questions are asked independently, so requiring them to agree filters out a single-question
 * false positive — and the acceptance criteria have to agree as well. Note this deliberately outranks `done`: a model that selects the finish option
 * while both signals agree it is finished has agreed with itself.
 */
function routeFor(input: RouteInput): DecisionRoute {
  const { ctx, tool, confidence, goalReached, progressScore, stuckP, shortlist, criteriaMet } = input;

  // Only this route is gated on the criteria. Jev choosing `done` stays authoritative, as above:
  // vetoing that too would leave a model that insists it is finished running to the step limit.
  if (goalReached >= ctx.goalReachedThreshold && progressScore >= ctx.minProgressScore && criteriaMet) {
    return 'goal-reached';
  }
  if (tool === FINISH_OPTION) {
    // Never an action: routed anywhere else, `done` runs as a no-op tool and the loop carries on.
    return 'jev-finish';
  }
  if (tool === ASK_USER_OPTION) {
    return 'ask-user';
  }
  if (stuckP >= ctx.stuckThreshold && ctx.history.length >= 3) {
    return 'stuck-escalation';
  }
  if (!shortlist.includes(tool)) {
    return 'act-low-confidence';
  }
  if (confidence < ctx.minConfidence) {
    return 'act-low-confidence';
  }
  return 'act';
}

const NO_PROOF = 'none of these';

/** Lines ranked by how many of the criterion's words they share; language-neutral, crude on purpose. */
function rankLines(lines: Array<{ path: string; line: string }>, criterion: string): Array<{ path: string; line: string }> {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}|\d+/g) ?? []);
  const wanted = words(criterion);
  const named = [...criterion.matchAll(/[\w./-]+\.[A-Za-z]{1,5}\b/g)].map((m) => m[0].split('/').pop()!.toLowerCase());
  return lines
    .map((entry, index) => {
      const shared = [...words(entry.line)].filter((word) => wanted.has(word)).length;
      const inFile = named.length === 0 || named.includes(entry.path.split('/').pop()!.toLowerCase());
      return { entry, index, score: inFile ? shared : -1 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.entry);
}

/** The option Jev ranked second, or '' when it gave no probabilities. */
function runnerUp(probabilities: Record<string, number>, chosen: string): string {
  return (
    Object.entries(probabilities)
      .filter(([name]) => name !== chosen)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  );
}

/** Every value the workspace offers for one kind of argument (paths, commands), across the tools. */
function closedValues(ctx: DeciderContext, tools: ToolSpec[], kind: 'pathArgs' | 'commandArgs'): string[] {
  const values = new Set<string>();
  for (const tool of tools) {
    for (const arg of tool[kind] ?? []) {
      for (const value of ctx.dynamicOptions[`${tool.name}.${arg}`] ?? []) values.add(value);
    }
  }
  return [...values];
}

function closedOptions(values: string[], max: number, none: string): Record<string, string | null> {
  const options: Record<string, string | null> = {};
  for (const value of values.slice(0, max)) options[value] = null;
  options[EXECUTOR_DECIDES] = none;
  return options;
}

function legendOf(levels: string[]): Record<string, string> {
  const legend: Record<string, string> = {};
  levels.forEach((level, index) => {
    legend[String(index)] = level;
  });
  return legend;
}

/**
 * The tools Jev may choose from on this decision. Excluded tools are dropped from the choice set
 * entirely, so a stuck agent cannot keep picking the move that is not working — but never all of
 * them, because a decision with no options is not a decision. The escape hatches (`done`,
 * `ask_user`) are pseudo-options and are never part of this list.
 */
function selectableTools(ctx: DeciderContext): ToolSpec[] {
  const excluded = new Set(ctx.excludeTools ?? []);
  const pool = ctx.tools.filter((tool) => !excluded.has(tool.name));
  return pool.length ? pool : ctx.tools;
}

/** The state Jev reasons over. Text plus a little structure; everything truncated to stay in budget. */
export function buildState(ctx: DeciderContext): unknown {
  const recent = ctx.history.slice(-12);
  // Stable fields first and the step counter last: a prefix that does not change between calls is
  // one a caching API can reuse.
  return {
    goal: ctx.goal,
    workspace: ctx.workspace,
    // Only what Jev can actually pick: naming a withheld tool would invite it to choose one.
    tools_available: selectableTools(ctx).map((tool) => ({ name: tool.name, does: tool.description })),
    workspace_files: ctx.files.slice(0, 200),
    // The last few results are what the next move acts on; older ones only tell the story, and the
    // ledger keeps what was learned from them.
    history: recent.map((entry, index) => ({
      step: entry.step,
      tool: entry.tool,
      args: summariseArgs(entry.args),
      ok: entry.ok,
      result: truncate(entry.observation, index >= recent.length - RECENT_IN_FULL ? 1200 : 240),
      progress_after: entry.progress.toFixed(1),
    })),
    agent_notes: ctx.notes ? truncate(ctx.notes, 2000) : undefined,
    // The trajectory: acceptance criteria and which one is open, what changed, what was verified
    // since, what already failed, what was learned. It outlives the history window above.
    ledger: ctx.ledger && Object.keys(ctx.ledger).length ? ctx.ledger : undefined,
    // Loop diagnosis, when the agent has escalated. Facts, not advice — this is input to the next
    // decision, not a narration of the last one.
    steering: ctx.steering?.length ? ctx.steering : undefined,
    progress: `step ${ctx.step} of ${ctx.maxSteps}`,
  };
}

/** History entries whose result Jev sees at length; older ones are cut to their opening lines. */
const RECENT_IN_FULL = 3;

function summariseArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 120) {
      parts.push(`${key}=<${value.length} chars>`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.join(', ') || '(none)';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}
