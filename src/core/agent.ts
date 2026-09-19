import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentEvent, ApprovalChoice, ApprovalRequest, ApprovalResponse, Budget, DoneReason, JevDecision, StepRecord } from '../types.js';
import type { Config } from '../config.js';
import type { LlmClient, LlmMessage } from './llm.js';
import { Decider, ASK_USER_OPTION, EXECUTOR_DECIDES, FINISH_OPTION, type DeciderContext, type HistoryEntry } from './decider.js';
import { ACTION_TOOLS, TOOLS_BY_NAME, compactDiff, type ToolContext, type ToolResult, type ToolSpec } from './tools.js';
import type { JevClient } from './jev.js';
import { Ledger, containsQuote, parseCriteria, splitFacts, unwrapQuote } from './ledger.js';
import { detectTestCommand, localImports } from './languages.js';
import {
  CRITERIA_SYSTEM,
  REPORTER_SYSTEM,
  STEP_INTENTS,
  buildBrief,
  callMessage,
  executorSystem,
  gatherFiles,
  schemaKeys,
  validateArgs,
  alignEdit,
  type FileContext,
} from './executor.js';

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
/** Below this goal score, a `done` still ends the run but the user is told to check the result. */
const LOW_FINISH_GOAL_SCORE = 0.3;
const MAX_TOOL_CORRECTIONS = 2;
/** Executor calls rejected by `validateArgs` get this many second chances before the step fails. */
const MAX_ARG_REPAIRS = 2;
/**
 * A reply cut off at `max_tokens` is not a bad answer, it is an unfinished one: asking again with the
 * same budget just burns another full generation (a whole-file write_file at 4096 tokens never fits).
 * So each truncated call doubles the budget, up to this ceiling.
 */
const MAX_TOKENS_CEILING = 65_536;
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_shell']);

/** Whether the goal mentions `path` by its path or, for a distinctive name, by its file name. */
function goalNames(goal: string, path: string): boolean {
  const name = path.split('/').pop()!;
  // Split the goal into path-like words, trimming quotes and punctuation around each.
  const words = new Set(goal.split(/[\s"'`(),;:]+/).map((word) => word.replace(/^\.\//, '').replace(/[.]+$/, '')));
  return words.has(path) || (name.includes('.') && words.has(name));
}

/**
 * Roughly how many tokens a call's answer itself needs: a whole file for write_file (the current
 * one's size, or room for a few new ones), an excerpt for edit_file, a line for the rest.
 */
function answerEstimate(tool: ToolSpec, files: FileContext[]): number {
  if (tool.name === 'write_file') {
    const current = files.find((file) => file.exists && !file.importedBy);
    return current ? 2048 + Math.ceil(current.content.length / 3) : 8192;
  }
  if (tool.name === 'edit_file') return 3072;
  return 1024;
}

function normalisePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/');
}

/** Tools after which the file they touched is shown to the reporter to prove criteria against. */
const PROVING_TOOLS = new Set(['write_file', 'edit_file', 'read_file']);

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
  /** The trajectory: criteria, changes, verifications, failures and facts. Outlives the history window. */
  private readonly ledger = new Ledger();
  private readonly steps: StepRecord[] = [];
  private readonly allowAlways = new Set<string>();
  private notes = '';
  /**
   * What the last failed command showed, until a command runs again. A plain note for the read that
   * followed used to replace it, and Jev went looking for a cause it had already been told.
   */
  private finding = '';
  private sinceFinding: string[] = [];
  /** Lines the last step added, offered to Jev as proof for the open criteria on the next decision. */
  private freshLines: Array<{ path: string; line: string }> = [];
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
  /** Whether a "done" with open criteria has already been sent back once. */
  private finishChallenged = false;
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
    | {
        ok: true;
        decision: JevDecision;
        argChoices: Record<string, string>;
        intent?: string;
        thinking?: number;
        references: string[];
      }
    | { ok: false; message: string }
  > {
    try {
      const result = await this.decider.decide(await this.buildContext(step));
      this.budget.jevCalls += 1;
      if (result.proofs?.length) this.acceptJevProofs(step, result.proofs);
      this.options.onEvent({ type: 'decision', step, decision: result.decision });
      this.applyCriteria(step, result.decision);
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
      ...(signal ? { signal } : {}),
    };

    onEvent({ type: 'phase', phase: 'planning' });
    this.ledger.setCriteria(await this.planCriteria());
    this.emitCriteria(0, []);

    // Where the project's tests stand, before any change: a command, not a model call. A bug fix's
    // first move was always to run them — two model calls and a note for a fact the agent can get
    // itself. Only unattended, so an interactive run does not open with an approval prompt.
    const baseline = config.agent.autoApprove ? this.testCommand() : undefined;
    if (baseline) {
      const verdict = await this.runTests(0, baseline, toolCtx);
      this.notes =
        verdict === 'passed'
          ? `Before any change, \`${baseline}\` passes.`
          : `Before any change, \`${baseline}\` fails. Its output is step 0 of the history.`;
    }

    for (let step = 1; step <= config.agent.maxSteps; step++) {
      if (signal?.aborted) {
        return { reason: 'aborted', summary: 'Stopped by the user.' };
      }

      this.budget.steps = step;

      // A later edit can delete the line that proved a criterion, so evidence is re-read every step.
      const lost = this.ledger.recheckEvidence((path) => this.readWorkspaceFile(path), step, config.agent.criterionMetThreshold);
      if (lost.length) this.emitCriteria(step, lost);
      // The criteria define done. Once each is proven by a quote found in the files, asking Jev again
      // only buys more re-reading: it never sees the files whole, so it cannot see what proves them.
      // But a quote proves the code is there, not that it works: a project with a test command has to
      // pass it after the last change. The agent runs it itself — a command, not a model call.
      if (this.ledger.criteria.length >= 2 && this.ledger.allProven()) {
        const proven = `All ${this.ledger.criteria.length} acceptance criteria are proven by quotes from the files`;
        const tests = this.testCommand();
        if (!tests || this.ledger.passedSinceLastChange(tests)) {
          return { reason: 'goal-reached', summary: tests ? `${proven}, and \`${tests}\` passes.` : `${proven}.` };
        }
        if (!this.ledger.ranSinceLastChange(tests)) {
          const verdict = await this.runTests(step, tests, toolCtx);
          if (verdict === 'denied') {
            return { reason: 'goal-reached', summary: `${proven}; running \`${tests}\` was declined, so it is untested.` };
          }
          if (verdict === 'passed') {
            return { reason: 'goal-reached', summary: `${proven}, and \`${tests}\` passes.` };
          }
          // Failed: the output is this step's observation, and Jev repairs from it next step.
          continue;
        }
      }

      onEvent({ type: 'phase', phase: 'deciding' });

      const first = await this.ask(step);
      if (!first.ok) {
        onEvent({ type: 'notice', level: 'error', message: `Jev failed: ${first.message}` });
        return { reason: 'error', summary: `Decision model unavailable: ${first.message}` };
      }
      let decision = first.decision;
      let argChoices = first.argChoices;
      let intent = first.intent;
      let thinking = first.thinking;
      let references = first.references;

      /** Re-ask within the same step, so a recovery costs Jev calls but not steps. */
      const reask = async (): Promise<{ reason: string; summary: string } | null> => {
        const next = await this.ask(step);
        if (!next.ok) {
          onEvent({ type: 'notice', level: 'error', message: `Jev failed: ${next.message}` });
          return { reason: 'error', summary: `Decision model unavailable: ${next.message}` };
        }
        decision = next.decision;
        argChoices = next.argChoices;
        intent = next.intent;
        thinking = next.thinking;
        references = next.references;
        return null;
      };

      // --- the gate -------------------------------------------------------------------------
      // Non-action outcomes are resolved here rather than ending the run: a loop gets an
      // improvise-and-re-ask, a question gets asked, a bad tool name gets corrected. Only a
      // genuinely terminal verdict leaves the loop below.
      let tool: ToolSpec | undefined;
      const recoveriesAtStepStart = this.recoveries;
      let rereadSteered = false;
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
          // "done" with a criterion still open: say which, once, and ask again. The criteria are the
          // definition of done — a bug fix stopped when the visible tests passed, with the documented
          // rule its own criteria named still unfixed. Only once: a model that insists is not
          // overruled all the way to the step limit.
          const open = this.ledger.criteria.filter((criterion) => !criterion.met);
          if (open.length && !this.finishChallenged && this.ledger.criteria.length >= 2) {
            this.finishChallenged = true;
            onEvent({
              type: 'notice',
              level: 'info',
              message: `Jev chose "done" with ${open.length} criterion${open.length === 1 ? '' : 'a'} still open (${open.map((c) => c.id).join(', ')}) — asking once more.`,
            });
            this.steering = [
              ...this.steering,
              `You chose done, but these acceptance criteria are not shown to be met yet:\n${open.map((c) => `  ${c.id}. ${c.text}`).join('\n')}\nWork on them, or choose done again if they really are satisfied.`,
            ];
            const failure = await reask();
            if (failure) return failure;
            continue;
          }
          if (decision.goalReached < LOW_FINISH_GOAL_SCORE) {
            onEvent({
              type: 'notice',
              level: 'warn',
              message: `Jev chose "done" with a low goal score (p=${decision.goalReached.toFixed(2)}) — check the result yourself.`,
            });
          }
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

        // Jev's stuck score is read off the history, and nothing runs between re-asks within a step,
        // so the re-ask after a recovery still says "stuck". Escalating on it again climbed the whole
        // ladder to the hand-off in a second without trying a single move. One recovery per step: if
        // Jev then picks a real tool, run it — only a new result can show whether the loop broke.
        const recoveredThisStep = this.recoveries > recoveriesAtStepStart;
        if (decision.route === 'stuck-escalation' && recoveredThisStep && TOOLS_BY_NAME.has(decision.tool)) {
          decision = { ...decision, route: 'act' };
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
        // Reading a file that was already read and has not changed since shows nothing new, yet Jev
        // asked for exactly that three times running in a live run. Re-ask with read_file withheld
        // for this one decision: it costs a Jev call instead of an executor call, a step and a note.
        const reread = decision.tool === 'read_file' ? this.unchangedRead(argChoices['read_file.path']) : undefined;
        if (reread && !rereadSteered) {
          rereadSteered = true;
          onEvent({ type: 'notice', level: 'info', message: `Skipped re-reading ${reread.path}: read at step ${reread.step} and unchanged since.` });
          // After a failed command, reading the file again is Jev looking for the cause, and it never
          // sees a file whole. The executor does: the repair is an edit of that file, briefed with the
          // file and the failure, not another look.
          if (this.finding && !this.excludedTools.has('edit_file')) {
            onEvent({ type: 'notice', level: 'info', message: `Repairing ${reread.path} instead: the failure is in the brief.` });
            decision = { ...decision, tool: 'edit_file' };
            argChoices = { 'edit_file.path': reread.path };
            intent = 'repair';
            thinking = 1;
            continue;
          }
          // Otherwise Jev's runner-up is its answer with read_file withheld, without asking again. Its
          // argument answers were for the read, so the executor supplies them.
          const runnerUp = TOOLS_BY_NAME.get(decision.fallbackTool);
          if (runnerUp && runnerUp.name !== 'read_file' && !this.excludedTools.has(runnerUp.name)) {
            decision = { ...decision, tool: runnerUp.name };
            argChoices = {};
            continue;
          }
          this.steering = [
            ...this.steering,
            `${reread.path} was read at step ${reread.step} and has not changed since; reading it again shows nothing new. Its contents are in the history and the notes. Act on it.`,
          ];
          this.excludedTools.add('read_file');
          const failure = await reask();
          this.excludedTools.delete('read_file');
          if (failure) return failure;
          continue;
        }
        tool = TOOLS_BY_NAME.get(decision.tool);
        if (tool) break;

        // Jev named something that is not in the registry. Fall back to its runner-up if that one
        // is real, then re-ask with the correction — a closed-set answer is not an error, and a
        // free-form hallucination deserves one chance to be corrected before the run ends.
        const substitute = TOOLS_BY_NAME.get(decision.fallbackTool);
        if (substitute?.name === FINISH_OPTION) {
          return { reason: 'finished', summary: `Jev's runner-up was "done" after naming the unknown tool "${decision.tool}".`, decision };
        }
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
      // The diagnosis did its job for Jev; the executor still gets it once, because a user's answer
      // or a "produce the deliverable" instruction is as much about the arguments as the tool.
      // A fresh one is built if the loop reports stuck again.
      const steering = this.steering;
      this.steering = [];

      onEvent({ type: 'phase', phase: 'planning' });
      let args: Record<string, unknown>;
      let extra: Array<Record<string, unknown>> = [];
      let claimed: Proof[] = [];
      try {
        const planned = await this.planArguments(tool, decision, { argChoices, intent, steering, thinking, references });
        args = planned.args;
        extra = planned.extra;
        claimed = planned.proofs;
        if (planned.problems.length) {
          // A call that is known to fail is not run: Jev gets the precise reason instead of a
          // garbled tool error, and a write_file full of "..." never reaches the disk.
          const observation = `executor could not produce a valid ${toolName} call:\n${planned.problems.map((p) => `- ${p}`).join('\n')}`;
          this.record(step, toolName, args, false, observation, decision.progress);
          onEvent({ type: 'observation', step, tool: toolName, ok: false, output: observation, summary: 'rejected before running' });
          this.notes = `${toolName} was not run: ${planned.problems[0]}`;
          continue;
        }
      } catch (error) {
        const message = (error as Error).message;
        onEvent({ type: 'notice', level: 'error', message: `Executor failed: ${message}` });
        this.record(step, toolName, {}, false, `executor error: ${message}`, decision.progress);
        continue;
      }

      // --- approval and execution ---------------------------------------------------------------
      // Usually one call. A batchable tool may bring more from the same reply (a new app's files); each
      // is approved and run on its own, and one note covers them all.
      // The same search or listing again, with nothing changed since, can only return the same thing.
      const repeated = this.repeatedLook(tool, args);
      if (repeated !== undefined) {
        const observation = `Not run: the same ${toolName} call ran at step ${repeated} and no file has changed since, so its result is the same. Act on it.`;
        this.record(step, toolName, args, false, observation, decision.progress);
        onEvent({ type: 'observation', step, tool: toolName, ok: false, output: observation, summary: 'repeat skipped' });
        this.noteStep(observation);
        continue;
      }
      const ran: Array<{ args: Record<string, unknown>; result: ToolResult; observation: string }> = [];
      for (const callArgs of [args, ...extra]) {
        const preview = await this.preview(tool, callArgs, toolCtx);
        const needsApproval =
          tool.mutates &&
          !config.agent.autoApprove &&
          !this.allowAlways.has(tool.name) &&
          decision.risk >= 0.5;

        if (needsApproval) {
          const { choice } = normaliseApproval(
            await this.options.approve({
              tool: tool.name,
              args: callArgs,
              preview,
              risk: decision.risk,
              reason: `Jev picked ${tool.name} (confidence ${decision.confidence.toFixed(2)}, risk ${decision.risk.toFixed(1)}/4).`,
            })
          );
          if (choice === 'deny') {
            this.record(step, tool.name, callArgs, false, 'user denied this action', decision.progress);
            onEvent({
              type: 'observation',
              step,
              tool: tool.name,
              ok: false,
              output: 'The user denied this action. Choose a different approach or stop.',
              summary: 'denied by user',
            });
            break;
          }
          if (choice === 'allow-always') this.allowAlways.add(tool.name);
        }

        onEvent({ type: 'phase', phase: 'executing' });
        onEvent({
          type: 'tool-call',
          step,
          tool: tool.name,
          args: callArgs,
          fromFallback: tool.name !== decision.tool,
        });

        let result: ToolResult;
        try {
          result = await tool.execute(callArgs, toolCtx);
        } catch (error) {
          result = { ok: false, output: `Error: ${(error as Error).message}`, summary: `failed: ${tool.name}` };
        }

        // What an edit changed, for Jev and the next call: "edited x.py" alone left Jev unable to
        // tell one edit from the next, and it made the same one three times.
        const changes = tool.mutates && result.ok && result.diff ? compactDiff(result.diff) : '';
        const observation = clamp(changes ? `${result.output}\n${changes}` : result.output, config.agent.maxObservationChars);
        // Otherwise a file written this step is missing from workspace_files for up to three steps.
        if (tool.mutates) this.fileCacheStep = -1;
        this.record(step, tool.name, callArgs, result.ok, observation, decision.progress);
        this.steps.push({
          step,
          decision,
          tool: tool.name,
          args: callArgs,
          ok: result.ok,
          observation,
        });

        onEvent({
          type: 'observation',
          step,
          tool: tool.name,
          ok: result.ok,
          output: changes ? clamp(result.output, config.agent.maxObservationChars) : observation,
          summary: result.summary,
          diff: result.diff,
        });
        ran.push({ args: callArgs, result, observation });
      }
      // Denied before anything ran: the step is recorded, there is nothing to narrate.
      if (!ran.length) continue;
      this.freshLines = ran.flatMap((call) =>
        call.result.ok && call.result.diff && typeof call.args['path'] === 'string'
          ? addedLines(call.result.diff).map((line) => ({ path: String(call.args['path']), line }))
          : [],
      );

      // --- narration ------------------------------------------------------------------------
      // --- the step's note -------------------------------------------------------------------
      // Only a failed command's output needs reading to know what it showed. A read is already in the
      // history; a change said in its own call which criteria it meets, and the quotes are checked
      // against the file here. Both get their result line as the note, at no model call.
      const summary = ran.map((call) => call.result.summary).join('; ');
      const proving = ran
        .filter((call) => call.result.ok && PROVING_TOOLS.has(tool.name) && typeof call.args['path'] === 'string')
        .map((call) => ({ path: String(call.args['path']), content: this.readWorkspaceFile(String(call.args['path'])) }))
        .filter((file): file is { path: string; content: string } => file.content !== undefined);
      // A command that succeeded is said by its exit code, and its output is in the history; only a
      // failure needs reading to say what went wrong.
      const failedCommand = tool.name === 'run_shell' && !ran.every((call) => call.result.ok);
      const change = tool.mutates && tool.name !== 'run_shell' && ran.some((call) => call.result.ok);
      if (this.options.narrate !== false && failedCommand) {
        onEvent({ type: 'phase', phase: 'verifying' });
        const { note, facts } = splitFacts(await this.narrate(tool, ran, intent));
        this.setFinding(note || `${tool.name} → ${summary}`);
        this.ledger.addFacts(step, facts, []);
      } else if (this.options.narrate !== false && change) {
        // After a change Jev needs to hear what the goal still lacks: without it, it went back to
        // reading files it cannot see whole, and looped. The note sees the diff, not the file.
        onEvent({ type: 'phase', phase: 'verifying' });
        const { note, facts, proofs } = splitFacts(await this.narrate(tool, ran, intent));
        this.noteStep(note || `${tool.name} → ${summary}`);
        this.ledger.addFacts(step, facts, ran.map((call) => call.args['path']).filter((p): p is string => typeof p === 'string'));
        if (proving.length && proofs.length) this.acceptProofs(step, proving, proofs);
      } else {
        if (tool.name === 'run_shell') this.setFinding('');
        this.noteStep(`${tool.name} → ${summary}`);
      }
      if (proving.length && claimed.length) this.acceptProofs(step, proving, claimed);
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
      dynamicOptions: await this.dynamicOptions(goal),
      steering: this.steering,
      excludeTools: [...this.excludedTools],
      criteria: this.ledger.criteria.map(({ id, text, evidence }) => ({ id, text, ...(evidence ? { proven: true } : {}) })),
      autoApprove: config.agent.autoApprove,
      freshLines: this.freshLines,
      referenceCandidates: this.referenceCandidates(),
      askEffort: Boolean(config.llm.quickExtraBody) && config.llm.executorThinking === 'jev',
      criterionMetThreshold: config.agent.criterionMetThreshold,
      ledger: this.ledger.view(step),
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
    const scripts = await detectScripts(workspace, this.testCommand());

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
   *
   * The brief carries what the call needs to be right the first time — the purpose Jev gave the
   * step, the target file's current contents, the last results in full — and a call that would
   * fail anyway is sent back with the concrete problem instead of being run.
   */
  private async planArguments(
    tool: ToolSpec,
    decision: JevDecision,
    jev: {
      argChoices: Record<string, string>;
      intent: string | undefined;
      steering: string[];
      thinking?: number | undefined;
      references: string[];
    },
  ): Promise<{ args: Record<string, unknown>; problems: string[]; extra: Array<Record<string, unknown>>; proofs: Proof[] }> {
    const { config, goal } = this.options;
    const { workspace } = config.agent;
    const settled: Record<string, string> = {};
    for (const [key, value] of Object.entries(jev.argChoices)) {
      if (key.startsWith(`${tool.name}.`)) settled[key.slice(tool.name.length + 1)] = value;
    }

    // Jev settled every argument the call needs: a path it picked from the workspace, a command the
    // project defines. The executor would only copy them out again, at the price of a whole brief. It
    // runs when something is left to write, or when steering could change the call.
    const required = (tool.parameters['required'] ?? []) as string[];
    if (!jev.steering.length && required.length && required.every((key) => key in settled)) {
      const direct: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(settled)) direct[key] = coerce(value, tool, key);
      if (!validateArgs(tool, direct, workspace).length) return { args: direct, problems: [], extra: [], proofs: [] };
    }

    const budget = config.llm.contextChars;
    const candidates = rankFiles(this.fileCache, goal).slice(0, 8);
    const scripts = tool.commandArgs?.length ? await detectScripts(workspace, this.testCommand()) : [];
    const stage = decision.progressLegend[String(Math.round(decision.progress))];
    const gather = (paths: Record<string, string>) =>
      gatherFiles({ tool, settled: paths, history: this.history, candidates, workspace, budget: Math.floor(budget * 0.6), references: jev.references });

    let files = gather(settled);
    this.announceContext(files, jev.intent);

    const forced = (this.options.toolMode ?? 'forced') === 'forced';
    // A change can say which criteria it meets in the same call: whoever writes the line knows what it
    // is for. That replaced a note call after every change whose main job was finding those lines.
    const open = PROVING_TOOLS.has(tool.name) && tool.mutates ? this.ledger.criteria.filter((criterion) => !criterion.evidence) : [];
    let proofs: Proof[] = [];
    let args: Record<string, unknown> = {};
    let problems: string[] = [];
    let more: Array<Record<string, unknown>> = [];
    // Retries skip thinking when the config says how: fixing a rejected call is mechanical, and a
    // reply cut off by runaway thinking is not cured by a bigger budget to think in. With that retry
    // available, the first attempt only gets room for its answer plus a thinking allowance.
    const quickBody = config.llm.quickExtraBody;
    const thinkingBudget = () => Math.min(config.llm.maxTokens, config.llm.thinkingAllowance + answerEstimate(tool, files));
    // Thinking is kept for the calls that need it: after a failure, or a step Jev calls a repair.
    // `jev`: Jev judged whether this step needs careful reasoning. Either way, a rejected quick
    // attempt is retried with thinking.
    const mode = config.llm.executorThinking;
    const thinkOnFailure = Boolean(quickBody) && mode !== 'always';
    const struggling =
      mode === 'jev' && jev.thinking !== undefined
        ? jev.thinking >= 0.5
        : this.history.at(-1)?.ok === false || jev.intent === 'repair';
    // Only a call that writes code has anything to think about; a path, a pattern or a command is
    // copied from the brief, and grep once thought for 800 tokens to answer in 13.
    const writesCode = tool.mutates && Boolean(tool.pathArgs?.length);
    let quick = Boolean(quickBody) && (!writesCode || (thinkOnFailure && !struggling));
    let maxTokens = quick || !quickBody ? config.llm.maxTokens : thinkingBudget();

    for (let attempt = 0; attempt <= MAX_ARG_REPAIRS; attempt++) {
      const messages: LlmMessage[] = [
        { role: 'system', content: executorSystem(tool, this.options.systemPrompt) },
        {
          role: 'user',
          content: buildBrief({
            goal,
            workspace,
            ...(jev.intent ? { intent: jev.intent } : {}),
            ...(stage ? { stage } : {}),
            steering: jev.steering,
            notes: this.notes,
            history: this.history,
            candidates,
            scripts,
            files,
            observationChars: Math.floor(budget * 0.15),
            ledger: this.ledger.view(this.budget.steps, Math.floor(budget * 0.1)),
          }),
        },
        { role: 'user', content: callMessage(tool, settled, problems, open) },
      ];

      let parsed: Record<string, unknown> | undefined;
      let truncated = false;
      const extraBody = quick ? quickBody : undefined;
      if (forced) ({ parsed, truncated, more } = await this.llmCall(messages, tool, 'forced', maxTokens, extraBody, open.length > 0));
      // The JSON fallback would be cut off at the same budget; go straight to a bigger one instead.
      if (!parsed && !truncated) ({ parsed, truncated } = await this.llmCall(messages, tool, 'prompt', maxTokens, extraBody, open.length > 0));

      proofs = [parsed, ...more].flatMap((call) => parseProofs(call?.[PROOF_ARG]));
      args = schemaKeys(tool, parsed ?? {});
      const proposed = typeof args['path'] === 'string' ? args['path'] : undefined;
      for (const [key, value] of Object.entries(settled)) {
        args[key] = coerce(value, tool, key);
      }
      // A change aimed at another file than the one Jev settled would be applied to the settled one,
      // and fail there as an old_string that "does not occur". When the executor names a file it was
      // shown, it has read the code and Jev has not: the fix for a crash in one file is often in the
      // module it calls. Its choice stands. A file it was not shown is sent back.
      const proposedRel = proposed ? relative(workspace, resolve(workspace, proposed)) : undefined;
      const retarget = tool.mutates && settled['path'] && proposedRel && proposedRel !== settled['path'];
      const seen = retarget && files.some((file) => file.path === proposedRel && file.exists);
      if (seen) args['path'] = proposedRel;
      const elsewhere = retarget && !seen;
      if (tool.name === 'edit_file' && !elsewhere) args = alignEdit(args, workspace);

      if (truncated && !parsed) {
        problems = [`The reply was cut off after ${maxTokens} tokens, before the tool call was complete.`];
      } else {
        problems = !parsed
          ? ['The reply contained no tool call and no JSON arguments.']
          : elsewhere
            ? [`This step changes ${settled['path']}, not ${proposed}; the other files are shown for reference. Put the change in ${settled['path']}.`]
            : validateArgs(tool, args, workspace);
      }
      if (!problems.length) break;
      if (attempt === MAX_ARG_REPAIRS) break;
      if (truncated && (quick || !quickBody)) {
        // Cut off even without thinking: the answer itself is long, so it needs the room.
        if (maxTokens >= MAX_TOKENS_CEILING) break;
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
        problems = [...problems, `Your token budget is now ${maxTokens}. Keep the reply to the tool call alone.`];
        quick = Boolean(quickBody);
      } else if (truncated) {
        // The capped first attempt ran out while thinking; without thinking it gets the full budget.
        maxTokens = config.llm.maxTokens;
        quick = true;
      } else if (thinkOnFailure && writesCode && quick && attempt === 0) {
        // A quick attempt got it wrong: the retry gets to think.
        quick = false;
        maxTokens = thinkingBudget();
      } else {
        quick = Boolean(quickBody);
      }

      this.options.onEvent({
        type: 'notice',
        level: 'info',
        message: `Executor's ${tool.name} call rejected, asking again: ${problems[0]}`,
      });
      // The executor may have named a file nobody showed it. Show it before the retry.
      const named = typeof args['path'] === 'string' ? args['path'] : undefined;
      if (named && !files.some((file) => file.path === named)) {
        files = gather({ ...settled, path: named });
        this.announceContext(files, jev.intent);
      }
    }
    const relativise = (call: Record<string, unknown>) => {
      // Models like absolute paths. Inside the workspace they are the same file, and a relative one is
      // ~100 characters shorter everywhere it is repeated: Jev's history, the ledger, the evidence.
      for (const key of tool.pathArgs ?? []) {
        const value = call[key];
        if (typeof value !== 'string' || !isAbsolute(value)) continue;
        const rel = relative(workspace, value);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) call[key] = rel;
      }
      return call;
    };
    relativise(args);

    // Further calls in the same reply: kept only when each one is valid on its own and targets a file
    // of its own. Anything doubtful is dropped rather than repaired — the main call is the step.
    const extra: Array<Record<string, unknown>> = [];
    if (tool.batchable && !problems.length) {
      const seen = new Set([String(args['path'] ?? '')]);
      for (const raw of more) {
        const call = relativise(schemaKeys(tool, raw));
        const path = String(call['path'] ?? '');
        if (!path || seen.has(path) || validateArgs(tool, call, workspace).length) continue;
        seen.add(path);
        extra.push(call);
      }
    }
    return { args, problems, extra, proofs };
  }

  private announceContext(files: FileContext[], intent: string | undefined): void {
    if (!files.length) return;
    this.options.onEvent({
      type: 'llm-context',
      paths: files.map((file) => (file.exists ? file.path : `${file.path} (new)`)),
      why: intent ? (STEP_INTENTS[intent] ?? intent) : '',
    });
  }

  private async llmCall(
    messages: LlmMessage[],
    tool: ToolSpec,
    mode: ToolMode,
    maxTokens: number,
    extraBody?: Record<string, unknown>,
    withProofs = false,
  ): Promise<{ parsed: Record<string, unknown> | undefined; truncated: boolean; more: Array<Record<string, unknown>> }> {
    let buffer = '';
    const onToken = (token: string) => {
      buffer += token;
      this.options.onEvent({ type: 'llm-stream', channel: 'reasoning', text: buffer });
    };
    const spec = {
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: withProofs ? withProofArg(tool.parameters) : tool.parameters },
    };

    const result =
      mode === 'forced'
        ? await this.options.llm.complete({
            messages,
            tools: [spec],
            toolChoice: 'required',
            maxTokens,
            ...(extraBody ? { extraBody } : {}),
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
                  `No markdown fence, no explanation.\n\nTool schema for ${tool.name}:\n${JSON.stringify(tool.parameters, null, 2)}`,
              },
            ],
            maxTokens,
            ...(extraBody ? { extraBody } : {}),
            onToken,
            signal: this.options.signal,
          });

    this.budget.llmCalls += 1;
    this.budget.llmPromptTokens += result.usage.promptTokens;
    this.budget.llmCompletionTokens += result.usage.completionTokens;
    this.options.onEvent({ type: 'budget', budget: { ...this.budget } });

    const truncated = result.finishReason === 'length';
    const call = result.toolCalls.find((entry) => entry.function.name === tool.name) ?? result.toolCalls[0];
    if (call) {
      const parsed = safeJson(call.function.arguments);
      const more = result.toolCalls
        .filter((entry) => entry !== call && entry.function.name === tool.name)
        .map((entry) => safeJson(entry.function.arguments))
        .filter((args): args is Record<string, unknown> => Boolean(args));
      if (parsed) return { parsed, truncated, more };
    }
    if (mode === 'prompt') {
      const parsed = extractJsonObject(result.content);
      if (parsed) {
        const args = parsed['arguments'] ?? parsed;
        if (typeof args === 'object' && args !== null) return { parsed: args as Record<string, unknown>, truncated, more: [] };
      }
    }
    return { parsed: undefined, truncated, more: [] };
  }

  private async narrate(
    tool: ToolSpec,
    ran: Array<{ args: Record<string, unknown>; result: ToolResult; observation: string }>,
    intent: string | undefined,
  ): Promise<string> {
    const changed = tool.mutates && PROVING_TOOLS.has(tool.name) && ran.some((call) => call.result.ok);
    const open = changed ? this.ledger.criteria.filter((criterion) => !criterion.evidence) : [];
    const fallback = ran
      .map((call) => `${tool.name} ${call.result.ok ? 'succeeded' : 'failed'}: ${call.observation.slice(0, 200)}`)
      .join('\n');
    // The note says what the goal still lacks. Seeing only this one step, the reporter used to claim
    // that files written two steps earlier were still missing, and Jev went back to re-read them.
    const workspaceFiles = await listWorkspaceFiles(this.options.config.agent.workspace, 200).catch(() => []);
    const earlier = this.history.slice(-(6 + ran.length), -ran.length);
    const messages: LlmMessage[] = [
      { role: 'system', content: REPORTER_SYSTEM },
      {
        role: 'user',
        content: [
          `Goal: ${this.options.goal}`,
          `Files in the workspace now: ${workspaceFiles.length ? workspaceFiles.join(', ') : '(none)'}`,
          ...(earlier.length
            ? ['Earlier steps:', ...earlier.map((entry) => `  step ${entry.step}: ${entry.tool}(${summariseArgs(entry.args)}) → ${entry.ok ? 'ok' : 'failed'}`)]
            : []),
          '',
          ...(intent ? [`Purpose of this step: ${STEP_INTENTS[intent] ?? intent}`] : []),
          ...ran.flatMap((call) => [
            `Tool: ${tool.name}(${summariseArgs(call.args)})`,
            `Result: ${call.result.ok ? 'success' : 'failure'}`,
            '',
            call.observation,
            '',
          ]),
          // A change's observation carries its diff: enough to say what it did and which criteria the
          // lines it added prove, without the whole file.
          ...(open.length
            ? [
                'Open acceptance criteria:',
                ...open.map((criterion) => `  ${criterion.id}. ${criterion.text}`),
                '',
                'After the note, for each open criterion a line added above proves, add a line',
                'MET <id>: <that line, copied character for character without the leading +>',
                'Only criteria the added lines really prove; no line for the others.',
              ]
            : []),
        ].join('\n'),
      },
    ];

    let text = '';
    try {
      const result = await this.options.llm.complete({
        messages,
        maxTokens: this.options.config.llm.noteMaxTokens,
        ...(this.options.config.llm.quickExtraBody ? { extraBody: this.options.config.llm.quickExtraBody } : {}),
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
      // Cut off means a draft — a thinking model's scratchpad, bullet lists and all. Jev scores
      // progress from this note, so a plain fact beats half an essay.
      if (result.finishReason === 'length') return fallback;
      return (result.content || text).trim() || fallback;
    } catch {
      return fallback;
    }
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
    const entry = { step, tool, args, ok, observation, progress };
    this.history.push(entry);
    this.ledger.observe(entry);
  }

  /**
   * Turn the goal into acceptance criteria, once, before the first step. This is what gives Jev a
   * trajectory to score against. It never fails the run: without a usable list the goal itself is
   * the single criterion, which is exactly the behaviour from before criteria existed.
   */
  private async planCriteria(): Promise<string[]> {
    const { goal } = this.options;
    try {
      const result = await this.options.llm.complete({
        messages: [
          { role: 'system', content: CRITERIA_SYSTEM },
          { role: 'user', content: await this.criteriaBrief(goal) },
        ],
        maxTokens: this.options.config.llm.noteMaxTokens,
        ...(this.options.config.llm.quickExtraBody ? { extraBody: this.options.config.llm.quickExtraBody } : {}),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
      this.budget.llmCalls += 1;
      this.budget.llmPromptTokens += result.usage.promptTokens;
      this.budget.llmCompletionTokens += result.usage.completionTokens;
      // A cut-off reply is a thinking draft, and its numbered lines are not the criteria.
      const criteria = result.finishReason === 'length' ? [] : parseCriteria(result.content);
      if (criteria.length) return criteria;
    } catch (error) {
      this.options.onEvent({
        type: 'notice',
        level: 'info',
        message: `Could not plan acceptance criteria (${(error as Error).message}); scoring against the goal alone.`,
      });
    }
    return [goal];
  }

  /**
   * What the criteria are planned from: the goal, the project's files, and the ones the goal names.
   * Planned from the goal alone, criteria on an existing project were guesses — one asked for a
   * `calculateTotal` that never existed, and none for the rule the named file's own docs stated.
   */
  private async criteriaBrief(goal: string): Promise<string> {
    const files = await listWorkspaceFiles(this.options.config.agent.workspace, 200).catch(() => [] as string[]);
    const lines = [`Goal: ${goal}`];
    if (!files.length) return [...lines, '', 'The workspace is empty: everything will be new.'].join('\n');
    lines.push('', `Files in the workspace: ${files.join(', ')}`);
    let budget = Math.floor(this.options.config.llm.contextChars / 2);
    for (const path of files.filter((file) => goalNames(goal, file))) {
      const content = this.readWorkspaceFile(path);
      if (content === undefined || content.length > budget) continue;
      budget -= content.length;
      lines.push('', `${path}, which the goal names:`, '```', content.replace(/\n$/, ''), '```');
    }
    return lines.join('\n');
  }

  private applyCriteria(step: number, decision: JevDecision): void {
    if (!decision.criteria) return;
    const answers: Record<number, number> = {};
    for (const [id, p] of Object.entries(decision.criteria)) answers[Number(id)] = p;
    const changed = this.ledger.applyCriteria(answers, step, this.options.config.agent.criterionMetThreshold);
    if (changed.length) this.emitCriteria(step, changed);
    if (decision.criteriaVeto) {
      const open = this.ledger.firstOpen();
      this.options.onEvent({
        type: 'notice',
        level: 'info',
        message: `Jev scored the goal as reached, but ${open ? `criterion ${open.id} (${open.text})` : 'a criterion'} is still open — continuing.`,
      });
    }
  }

  /**
   * Run the project's tests as a step of their own, recorded like any run_shell call so the ledger
   * and Jev see the result. Approval follows run_shell's rules.
   */
  private async runTests(step: number, command: string, toolCtx: ToolContext): Promise<'passed' | 'failed' | 'denied'> {
    const { config, onEvent } = this.options;
    const tool = TOOLS_BY_NAME.get('run_shell')!;
    const args = { command };
    if (!config.agent.autoApprove && !this.allowAlways.has(tool.name)) {
      const { choice } = normaliseApproval(
        await this.options.approve({
          tool: tool.name,
          args,
          preview: `$ ${command}`,
          risk: 1,
          reason: 'Every acceptance criterion is proven in the files; running the tests before finishing.',
        }),
      );
      if (choice === 'deny') return 'denied';
      if (choice === 'allow-always') this.allowAlways.add(tool.name);
    }
    onEvent({ type: 'phase', phase: 'executing' });
    onEvent({ type: 'tool-call', step, tool: tool.name, args, fromFallback: false });
    let result: ToolResult;
    try {
      result = await tool.execute(args, toolCtx);
    } catch (error) {
      result = { ok: false, output: `Error: ${(error as Error).message}`, summary: `failed: ${command}` };
    }
    const observation = clamp(result.output, config.agent.maxObservationChars);
    this.record(step, tool.name, args, result.ok, observation, 0);
    onEvent({ type: 'observation', step, tool: tool.name, ok: result.ok, output: observation, summary: result.summary });
    this.setFinding(
      result.ok ? '' : `Every criterion's code is in the files, but \`${command}\` fails, so something is wrong. Output:\n${clamp(result.output, 1500)}`,
    );
    if (result.ok) this.noteStep(`\`${command}\` passes.`);
    // A baseline or gate run is a fact about the project, not a failed attempt by the agent.
    if (!result.ok) this.ledger.forgetFailure('run_shell', args);
    return result.ok ? 'passed' : 'failed';
  }

  /** Jev's picks from the lines the last step wrote, checked like any other proof. */
  private acceptJevProofs(step: number, proofs: Array<{ id: number; path: string; quote: string }>): void {
    const byPath = new Map<string, Array<{ id: number; quote: string }>>();
    for (const proof of proofs) byPath.set(proof.path, [...(byPath.get(proof.path) ?? []), proof]);
    for (const [path, claims] of byPath) {
      const content = this.readWorkspaceFile(path);
      if (content !== undefined) this.acceptProofs(step, [{ path, content }], claims);
    }
  }

  /** What the likeliest targets import: the files Jev is asked about before they cost executor tokens. */
  private referenceCandidates(): string[] {
    const { workspace } = this.options.config.agent;
    const candidates = rankFiles(this.fileCache, this.options.goal).slice(0, 3);
    const found: string[] = [];
    for (const path of candidates) {
      const content = this.readWorkspaceFile(path);
      if (content === undefined) continue;
      for (const imported of localImports(workspace, path, content)) {
        if (!found.includes(imported) && !candidates.includes(imported)) found.push(imported);
      }
    }
    return found.slice(0, 4);
  }

  private setFinding(finding: string): void {
    this.finding = finding;
    this.sinceFinding = [];
    this.notes = finding;
  }

  /** A step's one-line note, kept under the standing finding when there is one. */
  private noteStep(line: string): void {
    if (!this.finding) {
      this.notes = line;
      return;
    }
    this.sinceFinding = [...this.sinceFinding, line].slice(-3);
    this.notes = `${this.finding}\nSince then:\n${this.sinceFinding.map((entry) => `- ${entry}`).join('\n')}`;
  }

  /** An earlier successful run of exactly this read-only call, with no change to any file since. */
  private repeatedLook(tool: ToolSpec, args: Record<string, unknown>): number | undefined {
    if (tool.mutates) return undefined;
    const canonical = (value: Record<string, unknown>) => JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
    const signature = canonical(args);
    for (let index = this.history.length - 1; index >= 0; index--) {
      const entry = this.history[index]!;
      if (MUTATING_TOOLS.has(entry.tool) && entry.ok) return undefined;
      if (entry.tool === tool.name && entry.ok && canonical(entry.args) === signature) return entry.step;
    }
    return undefined;
  }

  /** The configured test command, else the detected one; `false` in the config turns it off. */
  private testCommand(): string | undefined {
    const configured = this.options.config.agent.testCommand;
    if (configured === false) return undefined;
    return configured || detectTestCommand(this.options.config.agent.workspace);
  }

  /** The earlier read of `path`, when it succeeded and no step has changed the file since. */
  private unchangedRead(path: string | undefined): { path: string; step: number } | undefined {
    if (!path || path === EXECUTOR_DECIDES) return undefined;
    const same = (other: unknown) => typeof other === 'string' && normalisePath(other) === normalisePath(path);
    let read: HistoryEntry | undefined;
    for (const entry of this.history) {
      if (entry.tool === 'read_file' && entry.ok && same(entry.args['path'])) read = entry;
      else if (read && entry.ok && MUTATING_TOOLS.has(entry.tool)) {
        // A write to this file, or any shell command (it may have rewritten it), makes it stale.
        if (entry.tool === 'run_shell' || same(entry.args['path'])) read = undefined;
      }
    }
    return read ? { path, step: read.step } : undefined;
  }

  /** Take the reporter's MET lines only where the quote is really in the file. */
  private acceptProofs(step: number, files: Array<{ path: string; content: string }>, proofs: Array<{ id: number; quote: string }>): void {
    const changed: number[] = [];
    const rejected: number[] = [];
    for (const { id, quote } of proofs) {
      const criterion = this.ledger.criteria.find((c) => c.id === id)?.text ?? '';
      const existing = new Set([...this.fileCache, ...files.map((file) => file.path)].map(baseName));
      const source = files.find((file) => namesFile(criterion, file.path, existing) && containsQuote(file.content, quote));
      if (!source) {
        rejected.push(id);
        continue;
      }
      if (this.ledger.prove(id, source.path, quote, step)) changed.push(id);
    }
    if (changed.length) this.emitCriteria(step, changed);
    // One criterion often gets several MET lines; only report those none of them proved.
    const unproven = [...new Set(rejected)].filter((id) => !this.ledger.criteria.find((c) => c.id === id)?.evidence);
    if (unproven.length) {
      this.options.onEvent({
        type: 'notice',
        level: 'info',
        message: `Ignored the claim that ${files.map((file) => file.path).join(', ')} proves criteria ${unproven.join(', ')}: the quote is not in the file, or the criterion is about another file.`,
      });
    }
  }

  private readWorkspaceFile(path: string): string | undefined {
    const root = this.options.config.agent.workspace;
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    try {
      if (!statSync(absolute).isFile()) return undefined;
      return readFileSync(absolute, 'utf8');
    } catch {
      return undefined;
    }
  }

  private emitCriteria(step: number, changed: number[]): void {
    this.options.onEvent({
      type: 'criteria',
      step,
      criteria: this.ledger.criteria.map(({ id, text, met }) => ({ id, text, met })),
      changed,
    });
  }
}

/* ------------------------------------------------------------------ helpers */

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
/**
 * Commands the workspace defines. The project's test command comes first, and is the only spelling
 * of it: with `npm run test` also on offer, Jev picked that as often as `npm test`, and the ledger
 * never matched the two, so the gate ran the tests again.
 */
async function detectScripts(root: string, tests?: string): Promise<string[]> {
  const commands: string[] = tests ? [tests] : [];
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.scripts ?? {})) {
      if (!(tests && name === 'test')) commands.push(`npm run ${name}`);
    }
  } catch {
    // no package.json, or it is unreadable
  }
  if (existsSync(join(root, 'Makefile'))) commands.push('make');
  if (!tests && existsSync(join(root, 'pyproject.toml'))) commands.push('python -m pytest');
  return [...new Set(commands)].slice(0, 8);
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

/**
 * A criterion that names files ("app.js saves the count…") can only be proven from one of them: a real
 * quote from style.css proves nothing about app.js. One that names no file can be proven from any.
 */
function namesFile(criterion: string, path: string, existing: Set<string>): boolean {
  // Only names of files that exist count: a criterion that misnames its file ("src/todo.js" for
  // src/todos.js) once had every correct proof rejected, and the run could never finish.
  const named = [...criterion.matchAll(/[\w./-]+\.[A-Za-z]{1,5}\b/g)].map((m) => baseName(m[0])).filter((name) => existing.has(name));
  if (!named.length) return true;
  return named.includes(baseName(path));
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!.toLowerCase();
}

type Proof = { id: number; quote: string };

/** The extra argument a change may carry: which open criteria it meets, and the line that shows it. */
const PROOF_ARG = 'criteria_met';

function withProofArg(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = (parameters['properties'] ?? {}) as Record<string, unknown>;
  return {
    ...parameters,
    properties: {
      ...properties,
      [PROOF_ARG]: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For each open acceptance criterion this call makes true: "<id>: <one line of the file after this call, copied exactly>". Leave it empty when the call meets none.',
      },
    },
  };
}

function parseProofs(value: unknown): Proof[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
  return entries.flatMap((entry) => {
    const match = /^\s*#?(\d+)\s*[:.)-]\s*(.+)$/s.exec(String(entry));
    return match?.[1] && match[2] ? [{ id: Number(match[1]), quote: unwrapQuote(match[2]) }] : [];
  });
}

/** The lines a diff adds, long enough to prove something, each once. */
function addedLines(diff: string): string[] {
  const lines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.replace(/\s/g, '').length >= 8);
  return [...new Set(lines)];
}
