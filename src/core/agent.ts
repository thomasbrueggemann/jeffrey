import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentEvent, ApprovalChoice, ApprovalRequest, ApprovalResponse, Budget, DoneReason, JevDecision, StepRecord } from '../types.js';
import type { Config } from '../config.js';
import type { LlmClient, LlmMessage } from './llm.js';
import { Decider, ASK_USER_OPTION, FINISH_OPTION, type DeciderContext, type HistoryEntry } from './decider.js';
import { ACTION_TOOLS, TOOLS_BY_NAME, type ToolContext, type ToolResult, type ToolSpec } from './tools.js';
import type { JevClient } from './jev.js';

export type ToolMode = 'forced' | 'prompt';

/** How a loop is answered. See `Agent.planRecovery`. */
export interface RecoveryPlan {
  kind: 'improvise' | 'handoff' | 'terminal';
  /** One-line statement of the loop, for the user and for Jev. */
  diagnosis: string;
  /** What the agent has already tried and given up on — the context a human needs to answer. */
  context: string;
  /** The question itself, with no diagnosis repeated: shown on its own line in the approval box. */
  question: string;
  /** The hand-off question, or the closing report. */
  summary: string;
  /** Tools withheld from the next choice set. */
  exclude: string[];
  /** Facts for the next decision — input to it, not narration of the last one. */
  steering: string[];
}

/**
 * Bounds on the two in-step retry loops. Both are deliberately small: they exist to turn a bad
 * answer into a second attempt, not to grind against a model that will not converge.
 */
const MAX_ROUNDS_PER_STEP = 6;
const MAX_TOOL_CORRECTIONS = 2;

/**
 * Approvals are usually a bare choice, but a question's approval carries the user's typed answer
 * alongside it. Normalising here keeps every call site reading the same shape.
 */
function normaliseApproval(response: ApprovalResponse): { choice: ApprovalChoice; answer?: string } {
  if (typeof response === 'string') return { choice: response };
  return { choice: response.choice, answer: response.answer?.trim() || undefined };
}

/**
 * The line Jev reads when the user answered a question. It is deliberately phrased as an instruction
 * from the user rather than as narration, because it lands in `steering` — input to the next decision.
 */
function answerSteering(question: string, answer: string): string {
  return `You asked the user: "${question}"\nThey answered: "${answer}"\nTreat that as authoritative and act on it. Do not ask the same question again.`;
}

function summarise(args: Record<string, unknown>): string {
  return (
    Object.entries(args)
      .map(([key, value]) => `${key}=${typeof value === 'string' && value.length > 40 ? `<${value.length} chars>` : JSON.stringify(value)}`)
      .join(', ') || '(none)'
  );
}

export interface AgentOptions {
  goal: string;
  config: Config;
  llm: LlmClient;
  jev: JevClient;
  onEvent: (event: AgentEvent) => void;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  signal?: AbortSignal;
  toolMode?: ToolMode;
  /** Ask the executor for a one-line report after each tool run. */
  narrate?: boolean;
  /** Extra instructions appended to the executor's system prompt. */
  systemPrompt?: string;
}

const EXECUTOR_SYSTEM = `You are the executor half of a two-model coding agent.

A separate decision model (Jev) has already chosen which tool to call. That decision is final —
you do not get to pick a different tool, and you do not get to decide the task is finished.
Your job is exactly one thing: produce the arguments for the chosen tool call.

Rules:
- Follow the chosen arguments you are given. They came from the decision model and override anything you would otherwise infer.
- Every other argument must be concrete, complete, and ready to execute. No placeholders, no "...", no TODO.
- If you are writing a file, write the real, final content.
- If you are editing, "old_string" must match the file byte-for-byte, including indentation, and must be unique.
- Work from the workspace contents and the history. Do not invent file paths.
- Be terse in any prose. The tool call is the deliverable.`;

const REPORTER_SYSTEM = `You are the executor half of a two-model coding agent.
A tool has just run. Report what happened in at most two sentences: what changed and what it means
for the goal. Do not suggest next steps — a separate decision model handles that.
No preamble, no bullet lists, no markdown headings.`;

export class Agent {
  private readonly budget: Budget = {
    jevCalls: 0,
    jevInputTokens: 0,
    llmCalls: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    steps: 0,
  };

  private readonly history: HistoryEntry[] = [];
  private readonly steps: StepRecord[] = [];
  private readonly allowAlways = new Set<string>();
  private notes = '';
  private fileCache: string[] = [];
  private fileCacheStep = -1;
  /** Loop diagnosis handed to Jev on the next decision. Cleared once it is consumed. */
  private steering: string[] = [];
  /** Tools withheld from the choice set because they have stopped moving the goal. */
  private readonly excludedTools = new Set<string>();
  /**
   * How often Jev re-selected each tool while escalating. A re-selected tool never runs, so it leaves
   * no trace in `history` — without this the diagnosis would freeze on the first repeated tool and
   * the ladder would keep withholding the same thing and learn nothing.
   */
  private readonly reselects = new Map<string, number>();
  /** Loop recoveries used so far, and bad-tool-name corrections used so far. */
  private recoveries = 0;
  private toolCorrections = 0;
  /** Whether the loop has already been handed to the user with a concrete question. */
  private handedOff = false;
  private readonly decider: Decider;

  constructor(private readonly options: AgentOptions) {
    this.decider = new Decider(options.jev, 12);
  }

  get transcript(): StepRecord[] {
    return [...this.steps];
  }

  /**
   * One routing question to Jev, plus its event bookkeeping. Failures come back as data rather
   * than exceptions so the loop can re-ask from several places without repeating error handling.
   */
  private async ask(
    step: number,
  ): Promise<
    | { ok: true; decision: JevDecision; argChoices: Record<string, string>; argOmitted: Record<string, boolean> }
    | { ok: false; message: string }
  > {
    try {
      const result = await this.decider.decide(await this.buildContext(step));
      this.budget.jevCalls += 2;
      this.options.onEvent({ type: 'decision', step, decision: result.decision });
      this.options.onEvent({ type: 'budget', budget: { ...this.budget } });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async run(): Promise<{ reason: string; summary: string; decision?: JevDecision }> {
    const result = await this.runLoop();
    // Every caller — TUI, printer, test — learns the outcome from one place.
    this.options.onEvent({
      type: 'done',
      reason: result.reason as DoneReason,
      summary: result.summary,
      steps: this.budget.steps,
      budget: { ...this.budget },
      ...(result.decision ? { decision: result.decision } : {}),
    });
    return result;
  }

  private async runLoop(): Promise<{ reason: string; summary: string; decision?: JevDecision }> {
    const { config, onEvent, signal } = this.options;
    const toolCtx: ToolContext = {
      workspace: config.agent.workspace,
      allowOutsideWorkspace: config.agent.allowOutsideWorkspace,
      bashTimeoutMs: config.agent.bashTimeoutMs,
    };

    for (let step = 1; step <= config.agent.maxSteps; step++) {
      if (signal?.aborted) {
        return { reason: 'aborted', summary: 'Stopped by the user.' };
      }

      this.budget.steps = step;
      onEvent({ type: 'phase', phase: 'deciding' });

      const first = await this.ask(step);
      if (!first.ok) {
        onEvent({ type: 'notice', level: 'error', message: `Jev failed: ${first.message}` });
        return { reason: 'error', summary: `Decision model unavailable: ${first.message}` };
      }
      let decision = first.decision;
      let argChoices = first.argChoices;
      let argOmitted = first.argOmitted;

      /** Re-ask within the same step, so a recovery costs Jev calls but not steps. */
      const reask = async (): Promise<{ reason: string; summary: string } | null> => {
        const next = await this.ask(step);
        if (!next.ok) {
          onEvent({ type: 'notice', level: 'error', message: `Jev failed: ${next.message}` });
          return { reason: 'error', summary: `Decision model unavailable: ${next.message}` };
        }
        decision = next.decision;
        argChoices = next.argChoices;
        argOmitted = next.argOmitted;
        return null;
      };

      // --- the gate -------------------------------------------------------------------------
      // Non-action outcomes are resolved here rather than ending the run: a loop gets an
      // improvise-and-re-ask, a question gets asked, a bad tool name gets corrected. Only a
      // genuinely terminal verdict leaves the loop below.
      let tool: ToolSpec | undefined;
      for (let round = 0; !tool; round++) {
        if (round > MAX_ROUNDS_PER_STEP) {
          const summary = `Gave up resolving step ${step} after ${MAX_ROUNDS_PER_STEP} attempts (last route: ${decision.route}).`;
          onEvent({ type: 'notice', level: 'error', message: summary });
          return { reason: 'error', summary, decision };
        }

        if (decision.route === 'goal-reached') {
          return {
            reason: 'goal-reached',
            summary: `Jev scored the goal as reached (p=${decision.goalReached.toFixed(2)}, progress ${decision.progress.toFixed(1)}).`,
            decision,
          };
        }

        if (decision.route === 'jev-finish') {
          return {
            reason: 'finished',
            summary: `Jev selected "done" (p=${decision.goalReached.toFixed(2)}).`,
            decision,
          };
        }

        if (decision.route === 'ask-user') {
          const question = this.openQuestion(decision);
          const approval = normaliseApproval(
            await this.options.approve({
              tool: ASK_USER_OPTION,
              args: { goal: this.options.goal, question },
              question,
              risk: 0,
              reason: `Jev judged that the next step needs information only you have (p=${decision.needsUserInput.toFixed(2)}).`,
            })
          );
          if (approval.choice === 'deny') {
            return { reason: 'aborted', summary: 'User declined to continue.', decision };
          }
          this.steering = approval.answer
            ? [answerSteering(question, approval.answer)]
            : ['You just asked the user and they told you to continue. Do not ask again now — act.'];
          this.notes += approval.answer
            ? `\nThe user answered "${approval.answer}".`
            : '\nUser was asked and chose to continue.';
          const failure = await reask();
          if (failure) return failure;
          continue;
        }

        if (decision.route === 'stuck-escalation') {
          if (TOOLS_BY_NAME.has(decision.tool)) {
            this.reselects.set(decision.tool, (this.reselects.get(decision.tool) ?? 0) + 1);
          }
          const plan = this.planRecovery(decision);

          if (plan.kind === 'terminal') {
            // The final block already names the diagnosis and the open question; a notice would be
            // the same paragraph a third time.
            return { reason: 'needs-input', summary: plan.summary, decision };
          }

          if (plan.kind === 'handoff') {
            // One notice per round: the hand-off's message is the diagnosis plus the question, so a
            // separate diagnosis warning would just say it twice.
            onEvent({ type: 'notice', level: 'warn', message: plan.summary });
            const approval = normaliseApproval(
              await this.options.approve({
                tool: ASK_USER_OPTION,
                args: { goal: this.options.goal, question: plan.question },
                question: plan.question,
                risk: 0,
                reason: `${plan.diagnosis} ${plan.context}`,
              })
            );
            if (approval.choice === 'deny') {
              return { reason: 'needs-input', summary: plan.summary, decision };
            }
            this.notes += approval.answer
              ? `\nThe user was told the agent was looping and answered "${approval.answer}".`
              : `\nThe user was told the agent was looping and told it to keep going: ${plan.summary}`;
            // `applyRecovery` replaces the steering with the recovery's own facts, so the answer has
            // to be appended after it or it is thrown away on the very step it was meant to steer.
            this.applyRecovery(plan);
            if (approval.answer) {
              this.steering.push(answerSteering(plan.question, approval.answer));
            }
          } else {
            onEvent({ type: 'notice', level: 'warn', message: plan.diagnosis });
            this.applyRecovery(plan);
          }
          const failure = await reask();
          if (failure) return failure;
          continue;
        }

        // --- the action ---------------------------------------------------------------------
        tool = TOOLS_BY_NAME.get(decision.tool);
        if (tool) break;

        // Jev named something that is not in the registry. Fall back to its runner-up if that one
        // is real, then re-ask with the correction — a closed-set answer is not an error, and a
        // free-form hallucination deserves one chance to be corrected before the run ends.
        const substitute = TOOLS_BY_NAME.get(decision.fallbackTool);
        if (substitute) {
          onEvent({
            type: 'notice',
            level: 'info',
            message: `Jev named the unknown tool "${decision.tool}" — using its runner-up "${substitute.name}" instead.`,
          });
          tool = substitute;
          break;
        }

        if (this.toolCorrections >= MAX_TOOL_CORRECTIONS) {
          const summary = `Jev kept selecting the unknown tool "${decision.tool}".`;
          onEvent({ type: 'notice', level: 'error', message: summary });
          return { reason: 'error', summary, decision };
        }
        this.toolCorrections++;
        onEvent({
          type: 'notice',
          level: 'warn',
          message: `Jev selected an unknown tool "${decision.tool}" — asking again with the valid names.`,
        });
        this.steering = [
          `Your last answer chose "${decision.tool}", which is not a tool.`,
          `Choose next_action from exactly these: ${ACTION_TOOLS.map((entry) => entry.name).join(', ')}, ${ASK_USER_OPTION} (ask the user a question), or ${FINISH_OPTION} (the goal is met).`,
        ];
        const failure = await reask();
        if (failure) return failure;
      }
      const chosen = tool;
      if (!chosen) {
        const summary = `Could not resolve a tool for step ${step}.`;
        onEvent({ type: 'notice', level: 'error', message: summary });
        return { reason: 'error', summary, decision };
      }
      tool = chosen;
      const toolName = chosen.name;
      // The diagnosis did its job; a fresh one is built if the loop reports stuck again.
      this.steering = [];

      onEvent({ type: 'phase', phase: 'planning' });
      let args: Record<string, unknown>;
      try {
        args = await this.planArguments(tool, decision, argChoices, argOmitted);
      } catch (error) {
        const message = (error as Error).message;
        onEvent({ type: 'notice', level: 'error', message: `Executor failed: ${message}` });
        this.record(step, toolName, {}, false, `executor error: ${message}`, decision.progress);
        continue;
      }

      // --- approval -------------------------------------------------------------------------
      const preview = await this.preview(tool, args, toolCtx);
      const needsApproval =
        tool.mutates &&
        !config.agent.autoApprove &&
        !this.allowAlways.has(tool.name) &&
        decision.risk >= 0.5;

      if (needsApproval) {
        const { choice } = normaliseApproval(
          await this.options.approve({
            tool: tool.name,
            args,
            preview,
            risk: decision.risk,
            reason: `Jev picked ${tool.name} (confidence ${decision.confidence.toFixed(2)}, risk ${decision.risk.toFixed(1)}/4).`,
          })
        );
        if (choice === 'deny') {
          this.record(step, tool.name, args, false, 'user denied this action', decision.progress);
          onEvent({
            type: 'observation',
            step,
            tool: tool.name,
            ok: false,
            output: 'The user denied this action. Choose a different approach or stop.',
            summary: 'denied by user',
          });
          continue;
        }
        if (choice === 'allow-always') this.allowAlways.add(tool.name);
      }

      // --- execution ------------------------------------------------------------------------
      onEvent({ type: 'phase', phase: 'executing' });
      onEvent({
        type: 'tool-call',
        step,
        tool: tool.name,
        args,
        fromFallback: tool.name !== decision.tool,
      });

      let result: ToolResult;
      try {
        result = await tool.execute(args, toolCtx);
      } catch (error) {
        result = { ok: false, output: `Error: ${(error as Error).message}`, summary: `failed: ${tool.name}` };
      }

      const observation = clamp(result.output, config.agent.maxObservationChars);
      this.record(step, tool.name, args, result.ok, observation, decision.progress);
      this.steps.push({
        step,
        decision,
        tool: tool.name,
        args,
        ok: result.ok,
        observation,
      });

      onEvent({
        type: 'observation',
        step,
        tool: tool.name,
        ok: result.ok,
        output: observation,
        summary: result.summary,
        diff: result.diff,
      });

      // --- narration ------------------------------------------------------------------------
      if (this.options.narrate !== false) {
        onEvent({ type: 'phase', phase: 'verifying' });
        this.notes = await this.narrate(tool, args, observation, result.ok);
      } else {
        this.notes = `${tool.name} → ${result.summary}`;
      }
    }

    return {
      reason: 'max-steps',
      summary: `Hit the step limit (${config.agent.maxSteps}) without Jev scoring the goal as reached.`,
    };
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * Turn "Jev says we are looping" into a bounded plan instead of a terminal verdict.
   *
   * The ladder escalates and is deliberately finite: improvise by withholding the moves that are
   * not working and telling Jev what the loop looks like, then hand the problem to the user with a
   * concrete question, then stop. The point is that a loop produces a *new* decision rather than a
   * dead end, and that whatever ends the run names what was tried.
   */
  private planRecovery(decision: JevDecision): RecoveryPlan {
    const { maxRecoveries } = this.options.config.agent;
    const recent = this.history.slice(-6);
    const counts = new Map<string, number>();
    for (const entry of recent) counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const executedTop = ranked[0];
    const reselecting = this.reselects.get(decision.tool) ?? 0;
    const goalPercent = Math.round(decision.goalReached * 100);
    const ceiling = Math.max(1, Object.keys(decision.progressLegend).length - 1);

    // Withhold progressively more of what is not working: what ran repeatedly, plus what Jev keeps
    // re-selecting while it escalates. Preferring names that are not yet withheld is what makes each
    // round of the ladder a new attempt rather than the same one twice. The decider never excludes
    // everything, so there is always a move left to choose.
    const weights = new Map(counts);
    for (const [name, n] of this.reselects) weights.set(name, (weights.get(name) ?? 0) + n);
    const fresh = [...weights.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .filter((name) => !this.excludedTools.has(name));
    const exclude = fresh.slice(0, Math.min(3, this.recoveries + 1));
    const withheld = [...new Set([...this.excludedTools, ...exclude])];

    const diagnosis =
      `Jev reported a loop (stuck p=${decision.stuck.toFixed(2)}) after ${this.history.length} steps` +
      (executedTop ? `: ${executedTop} ran ${counts.get(executedTop)} of the last ${recent.length}` : '') +
      (reselecting && decision.tool !== executedTop
        ? `, and it keeps choosing ${decision.tool} instead of acting on it`
        : '') +
      `, while the goal score stayed at ${goalPercent}% (progress ${decision.progress.toFixed(1)}/${ceiling}).`;

    const context =
      `I withheld ${withheld.join(', ') || 'nothing'} and widened the context without getting unstuck.`;
    const question = 'What should I do differently?';
    const summary = `${diagnosis} ${context} ${question}`;

    // Terminal only after an improvised attempt has already followed a hand-off to the user. Nothing
    // new is withheld here, so the summary naming the full set stays accurate.
    if (this.handedOff && this.recoveries >= maxRecoveries) {
      return { kind: 'terminal', diagnosis, context, question, summary, exclude: [], steering: [] };
    }

    const steering = [
      diagnosis,
      'Repeating a call that did not move the goal score is not a plan. Pick a different tool from tools_available.',
    ];
    if (this.recoveries >= 1) {
      steering.push(`What has already been tried, with outcomes:\n${this.recentOutcomes()}`);
    }
    if (this.recoveries >= 2) {
      steering.push(`The goal, restated: ${this.options.goal}`);
      steering.push(
        'Produce the actual deliverable. If a file has to change, write_file or edit_file with real content; ' +
          `if a human decision is blocking you, choose ${ASK_USER_OPTION}.`,
      );
    }

    if (!this.handedOff && this.recoveries >= maxRecoveries) {
      this.handedOff = true;
      return { kind: 'handoff', diagnosis, context, question, summary, exclude, steering };
    }
    return { kind: 'improvise', diagnosis, context, question, summary, exclude, steering };
  }

  private applyRecovery(plan: RecoveryPlan): void {
    this.recoveries++;
    for (const name of plan.exclude) {
      this.excludedTools.add(name);
    }
    this.steering = [...plan.steering];
    // A recovery is a fresh look: the notes so far are what produced the loop, so they are demoted
    // to a fact in the steering rather than the executor's running summary.
    this.notes = `${this.notes}\n[loop recovery] ${plan.diagnosis}`.trim();
  }

  /** The last few tool results, verbatim enough for Jev to see the pattern it is stuck in. */
  private recentOutcomes(): string {
    return this.history
      .slice(-4)
      .map((entry) => `- ${entry.tool}(${summarise(entry.args)}) → ${entry.ok ? 'ok' : 'failed'}: ${clamp(entry.observation, 300)}`)
      .join('\n');
  }

  private openQuestion(decision: JevDecision): string {
    const weighing = Object.entries(decision.toolRelevance)
      .filter(([, p]) => p >= 0.15)
      .map(([name]) => name)
      .slice(0, 3);
    return (
      `Jev decided it needs input before acting on: ${this.options.goal}` +
      (weighing.length ? ` It was weighing ${weighing.join(', ')}.` : '') +
      ' Approve to let it improvise from here, or deny to stop.'
    );
  }

  private async buildContext(step: number): Promise<DeciderContext> {
    const { config, goal } = this.options;
    if (this.fileCacheStep < 0 || step - this.fileCacheStep >= 3) {
      this.fileCache = await listWorkspaceFiles(config.agent.workspace, 400);
      this.fileCacheStep = step;
    }
    return {
      goal,
      workspace: config.agent.workspace,
      step,
      maxSteps: config.agent.maxSteps,
      tools: ACTION_TOOLS,
      files: this.fileCache,
      history: this.history,
      notes: this.notes,
      minConfidence: config.agent.minConfidence,
      goalReachedThreshold: config.agent.goalReachedThreshold,
      minProgressScore: config.agent.minProgressScore,
      needsInputThreshold: config.agent.needsInputThreshold,
      stuckThreshold: config.agent.stuckThreshold,
      maxRelevantTools: 4,
      dynamicOptions: await this.dynamicOptions(goal),
      steering: this.steering,
      excludeTools: [...this.excludedTools],
    };
  }

  /**
   * Discover the closed sets Jev can choose from: the handful of real files that plausibly
   * matter for this goal, and the scripts the workspace advertises. Everything else stays
   * free text for the executor.
   */
  private async dynamicOptions(goal: string): Promise<Record<string, string[]>> {
    const { workspace } = this.options.config.agent;
    const candidates = rankFiles(this.fileCache, goal).slice(0, 10);
    const scripts = await detectScripts(workspace);

    const options: Record<string, string[]> = {};
    if (candidates.length) {
      for (const tool of ACTION_TOOLS) {
        for (const arg of tool.pathArgs ?? []) {
          options[`${tool.name}.${arg}`] = candidates;
        }
      }
    }
    if (scripts.length) {
      for (const tool of ACTION_TOOLS) {
        for (const arg of tool.commandArgs ?? []) {
          options[`${tool.name}.${arg}`] = scripts;
        }
      }
    }
    return options;
  }

  /**
   * Ask the executor for the tool arguments. Jev's closed-set answers are injected as settled
   * facts and re-applied after parsing, so the executor cannot silently override the router.
   */
  private async planArguments(
    tool: ToolSpec,
    decision: JevDecision,
    argChoices: Record<string, string>,
    argOmitted: Record<string, boolean>,
  ): Promise<Record<string, unknown>> {
    const { config, llm, goal } = this.options;
    const settled: Record<string, string> = {};
    const omitted: string[] = [];
    for (const [key, value] of Object.entries(argChoices)) {
      if (key.startsWith(`${tool.name}.`)) settled[key.slice(tool.name.length + 1)] = value;
    }
    for (const [key, isOmitted] of Object.entries(argOmitted)) {
      if (isOmitted && key.startsWith(`${tool.name}.`)) omitted.push(key.slice(tool.name.length + 1));
    }

    const guidance = [
      settledKeys(settled).length
        ? `The decision model has already settled these arguments — use them exactly:\n${settledKeys(settled)
            .map((key) => `  ${key} = ${JSON.stringify(settled[key])}`)
            .join('\n')}`
        : 'The decision model settled no arguments; you must supply all of them.',
      omitted.length
        ? `Omit these optional arguments entirely so the tool default applies: ${omitted.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const messages: LlmMessage[] = [
      { role: 'system', content: this.executorSystem(tool) },
      { role: 'user', content: this.executorBrief(goal) },
      {
        role: 'user',
        content: [
          `Call this tool now: ${tool.name}`,
          '',
          guidance,
          '',
          'Produce the tool call.',
        ].join('\n'),
      },
    ];

    const forced = (this.options.toolMode ?? 'forced') === 'forced';
    let parsed: Record<string, unknown> | undefined;

    if (forced) {
      const result = await this.llmCall(messages, tool, 'forced');
      if (result) parsed = result;
    }
    if (!parsed) {
      const result = await this.llmCall(messages, tool, 'prompt');
      parsed = result ?? {};
    }

    const merged: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(settled)) {
      merged[key] = coerce(value, tool, key);
    }
    for (const key of omitted) {
      if (merged[key] === undefined || merged[key] === null) delete merged[key];
    }
    return merged;
  }

  private async llmCall(
    messages: LlmMessage[],
    tool: ToolSpec,
    mode: ToolMode,
  ): Promise<Record<string, unknown> | undefined> {
    let buffer = '';
    const onToken = (token: string) => {
      buffer += token;
      this.options.onEvent({ type: 'llm-stream', channel: 'reasoning', text: buffer });
    };
    const spec = {
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };

    const result =
      mode === 'forced'
        ? await this.options.llm.complete({
            messages,
            tools: [spec],
            toolChoice: 'required',
            onToken,
            signal: this.options.signal,
          })
        : await this.options.llm.complete({
            messages: [
              ...messages,
              {
                role: 'user',
                content:
                  'Reply with a single JSON object and nothing else: {"arguments": { ... }}. ' +
                  'No markdown fence, no explanation.',
              },
            ],
            onToken,
            signal: this.options.signal,
          });

    this.budget.llmCalls += 1;
    this.budget.llmPromptTokens += result.usage.promptTokens;
    this.budget.llmCompletionTokens += result.usage.completionTokens;
    this.options.onEvent({ type: 'budget', budget: { ...this.budget } });

    const call = result.toolCalls.find((entry) => entry.function.name === tool.name) ?? result.toolCalls[0];
    if (call) {
      const parsed = safeJson(call.function.arguments);
      if (parsed) return parsed;
    }
    if (mode === 'prompt') {
      const parsed = extractJsonObject(result.content);
      if (parsed) {
        const args = parsed['arguments'] ?? parsed;
        if (typeof args === 'object' && args !== null) return args as Record<string, unknown>;
      }
    }
    return undefined;
  }

  private async narrate(tool: ToolSpec, args: Record<string, unknown>, observation: string, ok: boolean): Promise<string> {
    const messages: LlmMessage[] = [
      { role: 'system', content: REPORTER_SYSTEM },
      {
        role: 'user',
        content: [
          `Goal: ${this.options.goal}`,
          `Tool: ${tool.name}(${summariseArgs(args)})`,
          `Result: ${ok ? 'success' : 'failure'}`,
          '',
          observation,
        ].join('\n'),
      },
    ];

    let text = '';
    try {
      const result = await this.options.llm.complete({
        messages,
        onToken: (token) => {
          text += token;
          this.options.onEvent({ type: 'llm-stream', channel: 'narration', text });
        },
        signal: this.options.signal,
      });
      this.budget.llmCalls += 1;
      this.budget.llmPromptTokens += result.usage.promptTokens;
      this.budget.llmCompletionTokens += result.usage.completionTokens;
      this.options.onEvent({ type: 'budget', budget: { ...this.budget } });
      return (result.content || text).trim();
    } catch {
      return `${tool.name} ${ok ? 'succeeded' : 'failed'}: ${observation.slice(0, 200)}`;
    }
  }

  private executorSystem(tool: ToolSpec): string {
    const base = this.options.systemPrompt ? `${EXECUTOR_SYSTEM}\n\n${this.options.systemPrompt}` : EXECUTOR_SYSTEM;
    return `${base}\n\nTool schema:\n${JSON.stringify(tool.parameters, null, 2)}`;
  }

  private executorBrief(goal: string): string {
    const { config } = this.options;
    const history = this.history.slice(-8);
    const lines = [
      `Goal: ${goal}`,
      `Workspace: ${config.agent.workspace}`,
      '',
      history.length ? 'History so far:' : 'No steps have run yet.',
    ];
    for (const entry of history) {
      lines.push(
        `  step ${entry.step}: ${entry.tool}(${summariseArgs(entry.args)}) → ${entry.ok ? 'ok' : 'failed'} — ${firstLine(entry.observation)}`,
      );
    }
    if (this.notes) lines.push('', `Your own note from last step: ${this.notes}`);
    return lines.join('\n');
  }

  private async preview(tool: ToolSpec, args: Record<string, unknown>, ctx: ToolContext): Promise<string | undefined> {
    if (!tool.mutates) return undefined;
    if (tool.name === 'run_shell') return `$ ${String(args['command'] ?? '')}`;
    if (tool.name === 'write_file') {
      const content = String(args['content'] ?? '');
      const lines = content.split('\n').slice(0, 24);
      return `${args['path']}\n${lines.map((line) => `+ ${line}`).join('\n')}${
        content.split('\n').length > lines.length ? '\n+ …' : ''
      }`;
    }
    if (tool.name === 'edit_file') {
      const before = String(args['old_string'] ?? '').split('\n');
      const after = String(args['new_string'] ?? '').split('\n');
      return [
        `--- ${args['path']}`,
        ...before.map((line) => `- ${line}`),
        ...after.map((line) => `+ ${line}`),
      ].join('\n');
    }
    void ctx;
    return undefined;
  }

  private record(
    step: number,
    tool: string,
    args: Record<string, unknown>,
    ok: boolean,
    observation: string,
    progress: number,
  ): void {
    this.history.push({ step, tool, args, ok, observation, progress });
  }
}

/* ------------------------------------------------------------------ helpers */

function settledKeys(settled: Record<string, string>): string[] {
  return Object.keys(settled);
}

/** Closed-set values are strings by construction; convert when the schema wants another type. */
function coerce(value: string, tool: ToolSpec, arg: string): unknown {
  const properties = (tool.parameters['properties'] ?? {}) as Record<string, { type?: string }>;
  const type = properties[arg]?.type;
  if (type === 'integer' || type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean') return value === 'true';
  return value;
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return extractJsonObject(text);
  }
}

/** Tolerant object extraction: local models love to wrap JSON in prose or fences. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function summariseArgs(args: Record<string, unknown>): string {
  return (
    Object.entries(args)
      .map(([key, value]) =>
        typeof value === 'string' && value.length > 60 ? `${key}=<${value.length} chars>` : `${key}=${JSON.stringify(value)}`,
      )
      .join(', ') || ''
  );
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim()) ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/**
 * Cheap lexical ranking, not semantic search: Jev sees the full file list in its state anyway,
 * so this only decides which handful of paths are worth turning into a closed-set question.
 */
export function rankFiles(files: string[], goal: string): string[] {
  const terms = new Set(
    goal
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  );
  if (!terms.size) return files.slice(0, 10);

  const scored = files
    .map((file) => {
      const lower = file.toLowerCase();
      const base = lower.split('/').pop() ?? lower;
      let score = 0;
      for (const term of terms) {
        if (base.includes(term)) score += 3;
        else if (lower.includes(term)) score += 1;
      }
      // Source files beat lockfiles and generated output when nothing else separates them.
      if (/\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|cs|c|h|cpp|swift)$/.test(lower)) score += 0.5;
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const ranked = scored.map((entry) => entry.file);
  return ranked.length ? ranked : files.slice(0, 10);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'make', 'made', 'add', 'adding',
  'fix', 'fixing', 'use', 'using', 'should', 'would', 'could', 'please', 'need', 'needs', 'want',
  'when', 'then', 'than', 'them', 'they', 'have', 'has', 'had', 'not', 'but', 'all', 'any',
  'new', 'get', 'got', 'can', 'will', 'just', 'like', 'some', 'more', 'most', 'only', 'also',
  'file', 'files', 'code', 'work', 'works', 'test', 'tests',
]);

/** The workspace's own vocabulary of runnable commands, if it declares any. */
async function detectScripts(root: string): Promise<string[]> {
  const commands: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.scripts ?? {})) {
      commands.push(`npm run ${name}`);
    }
  } catch {
    // no package.json, or it is unreadable
  }
  if (existsSync(join(root, 'Makefile'))) commands.push('make');
  if (existsSync(join(root, 'pyproject.toml'))) commands.push('python -m pytest');
  return commands.slice(0, 8);
}

async function listWorkspaceFiles(root: string, limit: number): Promise<string[]> {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv']);
  const found: string[] = [];
  const queue = [root];
  while (queue.length && found.length < limit) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        found.push(relative(root, full));
      }
    }
  }
  return found.sort();
}
