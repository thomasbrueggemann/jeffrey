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
  /** Ceiling on how many tools get a full argument question set. */
  maxRelevantTools: number;
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
  criteria?: Array<{ id: number; text: string }>;
  /** Probability at or above which a criterion counts as met. */
  criterionMetThreshold?: number;
  /** The trajectory so far, beyond the history window. */
  ledger?: LedgerView;
}

export interface DeciderResult {
  decision: JevDecision;
  /** Closed-set argument values Jev picked, keyed `${tool}.${arg}`. */
  argChoices: Record<string, string>;
  /** Arguments Jev judged unstated, so the executor should leave them out. */
  argOmitted: Record<string, boolean>;
  /**
   * What the chosen call is for — one of `STEP_INTENTS`. The tool alone underdetermines the call:
   * `read_file` to locate code and `read_file` to check an edit want different arguments.
   */
  intent?: string;
  /** Tools that survived the relevance screen and got full argument questions. */
  shortlist: string[];
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

    // 1. Relevance screen. A per-member noul keeps the payload linear in the tool count instead
    //    of quadratic, and matches the documented pattern for set-valued arguments.
    const overBudget = candidates.length > ctx.maxRelevantTools;
    if (overBudget) {
      for (const tool of tools) {
        questions[`relevant.${tool.name}`] = noul(
          `Could calling "${tool.name}" (${tool.description}) be part of the single correct next step?`,
          {
            true: `the next step plausibly involves ${tool.name}`,
            false: `the next step is possible without ${tool.name}`,
          },
        );
      }
    }

    // 2. The routing question itself.
    const actionOptions: Record<string, string | null> = {};
    for (const tool of tools) {
      actionOptions[tool.name] = tool.description;
    }
    actionOptions[FINISH_OPTION] = 'the goal is already met and no further action is needed';
    actionOptions[ASK_USER_OPTION] = 'progress requires a decision, credential, or fact only the user can supply';

    questions['next_action'] = choice(
      'What is the single best next action to take right now? Choose the one action that moves this goal forward the most.',
      actionOptions,
    );
    questions['fallback_action'] = choice(
      'If the action you just chose fails or turns out to be impossible, what is the second-best action?',
      actionOptions,
    );

    // 3. Outcome questions. These are the ones the loop is actually gated on.
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
    questions['needs_user'] = noul(
      'Does the next step require information that only the user can provide?',
      {
        true: 'the agent cannot proceed without a missing credential, preference, or external fact',
        false: 'the agent can proceed from the workspace and the history alone',
      },
    );
    for (const criterion of ctx.criteria ?? []) {
      questions[`criterion.${criterion.id}`] = noul(
        `Is this acceptance criterion satisfied right now, based only on evidence in the history and the ledger? Criterion: ${criterion.text}`,
        {
          true: 'a tool result in the history or ledger shows this criterion holds',
          false: 'there is no evidence yet, or the evidence shows it does not hold',
        },
      );
    }
    questions['risk'] = score(
      'How risky or hard to reverse is the action you selected as next_action?',
      RISK_LEVELS,
    );

    const state = buildState(ctx);
    const response = await this.client.ask(state, questions);

    const shortlist = overBudget ? this.screen(tools, response, ctx.maxRelevantTools) : candidates;

    // 4. Argument questions for the shortlisted tools only.
    const { argChoices, argOmitted, intent } = await this.askArguments(ctx, shortlist, state, response);

    return {
      decision: this.interpret(ctx, response, shortlist),
      argChoices,
      argOmitted,
      ...(intent ? { intent } : {}),
      shortlist,
    };
  }

  /** Keep the tools Jev considered plausible, always leaving room for at least two. */
  private screen(tools: ToolSpec[], response: SystemOneResponse, maxRelevantTools: number): string[] {
    const scored = tools
      .map((tool) => ({ tool, p: asNoul(response.answers[`relevant.${tool.name}`])?.noul ?? 0 }))
      .sort((a, b) => b.p - a.p);
    const kept = scored.filter((entry) => entry.p >= 0.15).map((entry) => entry.tool.name);
    return kept.slice(0, Math.max(2, maxRelevantTools));
  }

  /**
   * Second Jev call for the chosen tool's closed-set arguments. It is a separate request because
   * the argument questions depend on which tool won the routing question.
   */
  private async askArguments(
    ctx: DeciderContext,
    shortlist: string[],
    state: unknown,
    routing: SystemOneResponse,
  ): Promise<{ argChoices: Record<string, string>; argOmitted: Record<string, boolean>; intent?: string }> {
    const argChoices: Record<string, string> = {};
    const argOmitted: Record<string, boolean> = {};
    const questions: Record<string, Question> = {};

    // Asked alongside the arguments because it depends on the routing answer, and it is what the
    // executor needs most: the tool says what to call, the intent says what the call has to achieve.
    questions['step_intent'] = choice(
      'What is the action already chosen in decision_already_made meant to achieve at this point?',
      STEP_INTENTS,
    );

    for (const name of shortlist) {
      const tool = ctx.tools.find((entry) => entry.name === name);
      if (!tool) continue;

      const closed: Record<string, string[]> = { ...(tool.closedArgs ?? {}) };
      for (const arg of [...(tool.pathArgs ?? []), ...(tool.commandArgs ?? [])]) {
        const discovered = ctx.dynamicOptions[`${name}.${arg}`];
        if (discovered?.length) closed[arg] = discovered;
      }

      for (const [arg, values] of Object.entries(closed)) {
        const options: Record<string, string | null> = {};
        const dynamic = Boolean(ctx.dynamicOptions[`${name}.${arg}`]?.length);
        for (const value of values.slice(0, this.maxArgOptions)) options[value] = null;
        if (dynamic) options[EXECUTOR_DECIDES] = 'none of these is right; the executor should supply this argument';
        questions[`${name}.${arg}`] = choice(
          `For the action "${name}", which value of "${arg}" is correct?`,
          options,
        );
      }

      for (const arg of tool.optionalArgs ?? []) {
        questions[`${name}.${arg}?`] = noul(
          `For the action "${name}", should the optional argument "${arg}" be supplied at all?`,
          {
            true: `a specific value for "${arg}" is needed for this call to be correct`,
            false: `"${arg}" should be left out so the tool's own default applies`,
          },
        );
      }
    }

    // The routing answer is echoed into the state so the argument questions are asked in the
    // context of the decision that was just made, not in a vacuum.
    const enrichedState = {
      ...(typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : { state }),
      decision_already_made: {
        next_action: asChoice(routing.answers['next_action'])?.choice ?? FINISH_OPTION,
        goal_reached: asNoul(routing.answers['goal_reached'])?.noul ?? 0,
        progress: asScore(routing.answers['progress'])?.score ?? 0,
      },
    };

    let response: SystemOneResponse;
    try {
      response = await this.client.ask(enrichedState, questions);
    } catch {
      // Argument questions are an optimisation. If they fail, the executor picks everything.
      return { argChoices, argOmitted };
    }

    const intent = asChoice(response.answers['step_intent'])?.choice;
    for (const id of Object.keys(questions)) {
      if (id === 'step_intent') continue;
      if (id.endsWith('?')) {
        argOmitted[id.slice(0, -1)] = (asNoul(response.answers[id])?.noul ?? 1) < 0.5;
      } else {
        const picked = asChoice(response.answers[id])?.choice;
        // The escape hatch means "no opinion", so the executor keeps that argument.
        if (picked && picked !== EXECUTOR_DECIDES) argChoices[id] = picked;
      }
    }
    return { argChoices, argOmitted, ...(intent && intent in STEP_INTENTS ? { intent } : {}) };
  }

  private interpret(ctx: DeciderContext, response: SystemOneResponse, shortlist: string[]): JevDecision {
    const action = asChoice(response.answers['next_action']);
    const fallback = asChoice(response.answers['fallback_action']);
    const goal = asNoul(response.answers['goal_reached']);
    const progress = asScore(response.answers['progress']);
    const stuck = asNoul(response.answers['stuck']);
    const needsUser = asNoul(response.answers['needs_user']);
    const risk = asScore(response.answers['risk']);

    const tool = action?.choice ?? FINISH_OPTION;
    const confidence = action?.confidence ?? 0;
    const goalReached = goal?.noul ?? 0;
    const progressScore = progress?.score ?? 0;
    const stuckP = stuck?.noul ?? 0;
    const needsUserP = needsUser?.noul ?? 0;

    const criteria: Record<string, number> = {};
    for (const criterion of ctx.criteria ?? []) {
      criteria[String(criterion.id)] = asNoul(response.answers[`criterion.${criterion.id}`])?.noul ?? 0;
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

    const toolRelevance: Record<string, number> = {};
    for (const name of ctx.tools.map((entry) => entry.name)) {
      const answer = asNoul(response.answers[`relevant.${name}`]);
      if (answer) toolRelevance[name] = answer.noul;
    }

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
      fallbackTool: fallback?.choice ?? '',
      toolRelevance,
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
  return {
    goal: ctx.goal,
    workspace: ctx.workspace,
    progress: `step ${ctx.step} of ${ctx.maxSteps}`,
    // Only what Jev can actually pick: naming a withheld tool would invite it to choose one.
    tools_available: selectableTools(ctx).map((tool) => ({ name: tool.name, does: tool.description })),
    workspace_files: ctx.files.slice(0, 200),
    history: ctx.history.slice(-12).map((entry) => ({
      step: entry.step,
      tool: entry.tool,
      args: summariseArgs(entry.args),
      ok: entry.ok,
      result: truncate(entry.observation, 1200),
      progress_after: entry.progress.toFixed(1),
    })),
    agent_notes: ctx.notes ? truncate(ctx.notes, 2000) : undefined,
    // The trajectory: acceptance criteria and which one is open, what changed, what was verified
    // since, what already failed, what was learned. It outlives the history window above.
    ledger: ctx.ledger && Object.keys(ctx.ledger).length ? ctx.ledger : undefined,
    // Loop diagnosis, when the agent has escalated. Facts, not advice — this is input to the next
    // decision, not a narration of the last one.
    steering: ctx.steering?.length ? ctx.steering : undefined,
  };
}

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
