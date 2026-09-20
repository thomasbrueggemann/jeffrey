import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { Agent } from '../src/core/agent.js';
import { MockDecider, type MockScript } from '../src/core/deciders/mock.js';
import { MockLlmClient } from '../src/core/llm.js';
import type { AgentEvent, ApprovalChoice, ApprovalRequest, ApprovalResponse, DoneReason } from '../src/types.js';

/**
 * Regressions for the two ways a live run failed:
 *
 *  1. Jev declared a loop and the agent died with "stuck — no progress" instead of improvising.
 *  2. Jev chose the `ask_user` escape hatch with a low `needs_user` score and the run ended with
 *     `Jev selected an unknown tool "ask_user"`.
 *
 * Both are routing decisions, so both are pinned here against the mock decider rather than a live
 * model: the answers are scripted, the agent is real.
 */

interface RunResult {
  reason: DoneReason;
  summary: string;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  states: Array<Record<string, unknown>>;
}

type Notice = Extract<AgentEvent, { type: 'notice' }>;
type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;
type DoneEvent = Extract<AgentEvent, { type: 'done' }>;

async function scratchWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-recovery-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# scratch\n');
  await writeFile(join(dir, 'src', 'index.ts'), 'export const answer = 41;\n');
  return dir;
}

async function run(
  script: MockScript,
  goal = 'fix the off-by-one in src/index.ts',
  approve: ApprovalChoice | ((request: ApprovalRequest) => ApprovalResponse) = 'allow',
  agent: Partial<Config['agent']> = {},
): Promise<RunResult> {
  return runWith(new MockDecider(script), goal, approve, agent);
}

/** The same run, driven by a decider the test built itself — one that fails a question, say. */
async function runWith(
  jev: MockDecider,
  goal = 'fix the off-by-one in src/index.ts',
  approve: ApprovalChoice | ((request: ApprovalRequest) => ApprovalResponse) = 'allow',
  agent: Partial<Config['agent']> = {},
): Promise<RunResult> {
  const config: Config = {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, workspace: await scratchWorkspace(), ...agent },
  };
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const instance = new Agent({
    goal,
    config,
    llm: new MockLlmClient(),
    jev,
    onEvent: (event) => events.push(event),
    approve: async (request) => {
      approvals.push(request);
      return typeof approve === 'function' ? approve(request) : approve;
    },
  });
  const { reason, summary } = await instance.run();
  return {
    reason: reason as DoneReason,
    summary,
    events,
    approvals,
    states: jev.seenStates as Array<Record<string, unknown>>,
  };
}

const notices = (result: RunResult, level?: Notice['level']): string[] =>
  result.events
    .filter((event): event is Notice => event.type === 'notice')
    .filter((event) => !level || event.level === level)
    .map((event) => event.message);

const decisions = (result: RunResult): DecisionEvent[] =>
  result.events.filter((event): event is DecisionEvent => event.type === 'decision');

/** The tool names Jev could pick on that decision — what the state advertised, not what it chose. */
const offeredTools = (state: Record<string, unknown>): string[] =>
  ((state.tools_available as Array<{ name: string }>) ?? []).map((tool) => tool.name);

test('a loop is improvised out of rather than ending the run', async () => {
  // Four identical read_file steps, then Jev calls the loop — and answers "not stuck" on the
  // re-ask, because the agent restricted the choice set to the approach Jev's own diagnosis named.
  const result = await run({
    tools: ['read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
    // Unsettled, so the executor picks the path: a settled re-read of an unchanged file is skipped outright.
    leaveArgsToExecutor: true,
    finalGoalReached: 0.94,
    stuck: 0.91,
    stuckFromStep: 4,
    stuckUntilCall: 4,
  });

  assert.equal(result.reason, 'goal-reached', `expected recovery to continue the run: ${result.summary}`);

  const diagnoses = notices(result, 'warn').filter((message) => /reported a loop/.test(message));
  assert.equal(diagnoses.length, 1, `expected one loop diagnosis, got ${JSON.stringify(notices(result))}`);
  assert.match(diagnoses[0]!, /read_file ran 4 of the last 4/);
  // The notice says what is being tried instead, not only what went wrong.
  assert.match(diagnoses[0]!, /Trying a different approach — run something and read the real output/);

  // The recovery has to reach Jev as steering, or it is just a log line — and what reaches it is
  // the instruction the tactic carries, not a generic "stop repeating yourself".
  const steered = result.states.filter((state) => Array.isArray(state.steering) && state.steering.length > 0);
  assert.ok(steered.length >= 1, 'expected the loop diagnosis to be handed back to Jev');
  assert.match(String(steered[0]!.steering), /Run the project's tests, build, or the program itself/);

  // Restricting the choice set is the lever that actually changes the answer: the tactic's tool is
  // the only one left, and the tool that was looping is not advertised.
  const restricted = result.states.find((state) => !offeredTools(state).includes('read_file'));
  assert.ok(restricted, 'expected read_file to be withheld from the choice set after the loop');
  assert.deepEqual(offeredTools(restricted), ['run_shell'], 'the approach Jev named is the only move on offer');

  // A re-ask costs Jev calls, not steps: the run finished inside the step it got stuck on.
  const done = result.events.find((event): event is DoneEvent => event.type === 'done');
  assert.ok(done);
  assert.equal(done.steps, 5, 'the recovery should not consume a step of its own');
  assert.equal(decisions(result).length, 6, 'one extra decision for the recovery re-ask');
});

test('each recovery tries a different approach, and a tried one is not offered again', async () => {
  // The point of asking Jev what the loop is: every rung is a different move, chosen from the
  // causes not yet spent, rather than the same re-ask with one more tool withheld.
  const result = await run({ tools: Array(16).fill('read_file'), stuck: 0.91, stuckFromStep: 4 });

  const attempts = notices(result, 'warn')
    .map((message) => /Trying a different approach — ([^.]+)\./.exec(message)?.[1])
    .filter((attempt): attempt is string => Boolean(attempt));
  assert.ok(attempts.length >= 3, `expected several approaches, got ${JSON.stringify(attempts)}`);
  assert.equal(new Set(attempts).size, attempts.length, `an approach was tried twice: ${JSON.stringify(attempts)}`);

  // Each one has to reach the choice set as a real restriction, and the restrictions must differ.
  const restrictions = result.states
    .map((state) => offeredTools(state).join(','))
    .filter((offered) => offered.length > 0 && offered.split(',').length <= 3);
  assert.ok(new Set(restrictions).size >= 2, `expected the restricted set to change: ${JSON.stringify(restrictions)}`);

  // And the run has to actually make the moves, not just narrate them.
  const tools = result.events.filter((event) => event.type === 'tool-call').map((event) => event.tool);
  assert.ok(tools.includes('run_shell'), `expected the "run it" approach to run: ${JSON.stringify(tools)}`);
});

test('a restriction lasts one decision, not the rest of the run', async () => {
  // A tactic that works must not leave the run locked inside one tool. The decision after the
  // restricted one sees the whole registry again.
  const result = await run({
    tools: ['read_file', 'read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
    leaveArgsToExecutor: true,
    stuck: 0.91,
    stuckFromStep: 4,
    stuckUntilCall: 4,
  });

  const offered = result.states.map((state) => offeredTools(state)).filter((tools) => tools.length > 0);
  const restrictedAt = offered.findIndex((tools) => tools.length === 1);
  assert.ok(restrictedAt >= 0, 'expected one decision restricted to the tactic');
  const after = offered.slice(restrictedAt + 1);
  assert.ok(after.length >= 1, 'expected the run to continue past the restricted decision');
  assert.ok(after.some((tools) => tools.length > 1), 'the restriction must not outlive the decision it shaped');
});

test('Jev can hand a loop straight to the user when no tool would break it', async () => {
  // The cause that is not a move: a missing fact only the user has. It spends the rung on the
  // person who can answer instead of on another tool that cannot.
  const result = await run(
    { tools: Array(8).fill('read_file'), stuck: 0.91, stuckFromStep: 4, loopCauses: ['needs-user'] },
    'fix the off-by-one',
    'deny',
  );

  assert.equal(result.reason, 'needs-input', `expected an immediate hand-off, got ${result.summary}`);
  const handoff = result.approvals.find((request) => request.tool === 'ask_user');
  assert.ok(handoff, 'expected the loop to be handed to the user');
  assert.match(String(handoff.reason), /missing fact or decision that no tool can supply/);
  // It is the first recovery, so nothing has been tried yet and the reason must not claim otherwise.
  assert.match(String(handoff.reason), /widened the context/);
});

test('a loop Jev has no reading of falls back to withholding what stopped working', async () => {
  // A diagnosis it is not sure of decides nothing. The subtractive ladder is what keeps the run
  // moving then: it proposes nothing, but it never leaves the loop spinning either.
  const result = await run(
    { tools: Array(8).fill('read_file'), stuck: 0.91, stuckFromStep: 4, loopCauseConfidence: 0.1 },
  );

  const diagnoses = notices(result, 'warn').filter((message) => /reported a loop/.test(message));
  assert.ok(diagnoses.length >= 1);
  assert.ok(
    diagnoses.every((message) => !/Trying a different approach/.test(message)),
    `an unsure diagnosis must not be acted on: ${JSON.stringify(diagnoses)}`,
  );
  const steered = result.states.map((state) => String(state.steering ?? '')).join('\n');
  assert.match(steered, /Repeating a call that did not move the goal/);
});

test('a decider that cannot answer the diagnosis says so once, then falls back', async () => {
  // Laya rejects a choice whose options exceed its head budget with a 400 (docs/deciders.md). The
  // ladder has to survive that, and the user has to learn why the approaches stopped appearing —
  // but once, not on every rung.
  const failing = new MockDecider({ tools: Array(12).fill('read_file'), stuck: 0.91, stuckFromStep: 4 });
  const ask = failing.ask.bind(failing);
  failing.ask = async (state, questions) => {
    if ('loop_cause' in questions) throw new Error('options exceed head_max_len — raise --head-max-len');
    return ask(state, questions);
  };

  const result = await runWith(failing);

  const complaints = notices(result, 'info').filter((message) => /Could not ask what the loop is/.test(message));
  assert.equal(complaints.length, 1, `expected the failure to be reported once, got ${JSON.stringify(complaints)}`);
  assert.match(complaints[0]!, /head_max_len/, 'the provider should say what is wrong in its own words');

  // And the run keeps going on the fallback rather than dying on a failed diagnosis.
  assert.ok(notices(result, 'warn').some((message) => /reported a loop/.test(message)));
  assert.notEqual(result.reason, 'error', `a failed diagnosis must not end the run: ${result.summary}`);
});

test('a persistent loop hands off to the user instead of failing', async () => {
  // Jev never stops reporting the loop and has no reading of why, so the ladder runs out:
  // improvise, hand off, stop — with the user in the loop rather than a red "failed".
  const result = await run({
    tools: Array(16).fill('read_file'),
    stuck: 0.91,
    stuckFromStep: 4,
    loopCauseConfidence: 0.1,
  });

  assert.equal(result.reason, 'needs-input', `expected a hand-off, got ${result.summary}`);
  const handoff = result.approvals.find((request) => request.tool === 'ask_user');
  assert.ok(handoff, 'expected the loop to be handed to the user with a question');

  // The box shows the reason above the question, so the two must not repeat each other: reason =
  // what was tried, question = the ask. Repeating the diagnosis in both wastes the box's width.
  assert.match(handoff.reason, /reported a loop/);
  assert.match(handoff.reason, /widened the context/);
  assert.equal(handoff.args.question, 'What should I do differently?');
  assert.match(result.summary, /widened the context/);
  assert.match(result.summary, /What should I do differently\?/);
});

test('each round of the fallback ladder withholds something new', async () => {
  // With no reading of the loop to act on, the ladder is subtractive again. The tool Jev keeps
  // re-selecting never executes, so it leaves no history entry. Ranking only on what ran would
  // withhold read_file again on every round and repeat the same improvise. Ranking on
  // re-selections too is what makes the ladder walk down the tool list instead.
  const result = await run({
    tools: Array(16).fill('read_file'),
    stuck: 0.91,
    stuckFromStep: 4,
    leaveArgsToExecutor: true,
    loopCauseConfidence: 0.1,
  });

  assert.equal(result.reason, 'needs-input', `expected a hand-off, got ${result.summary}`);

  const rounds = result.states.map((state) => offeredTools(state)).filter((tools) => tools.length > 0);
  const universe = rounds[0] ?? [];
  const withheldPerRound = rounds.map((offered) => universe.filter((name) => !offered.includes(name)));

  const distinct = new Set(withheldPerRound.map((names) => names.join(',')));
  assert.ok(
    distinct.size >= 3,
    `expected the withheld set to change each round, got ${JSON.stringify([...distinct])}`,
  );

  // Withholding more, never swapping one tool out for another.
  for (let i = 1; i < withheldPerRound.length; i += 1) {
    const before = withheldPerRound[i - 1]!;
    const after = withheldPerRound[i]!;
    assert.ok(
      before.every((name) => after.includes(name)),
      `round ${i} dropped a withheld tool: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  }

  // The diagnosis has to name the re-selection, or the improvised attempt is a guess.
  const diagnoses = notices(result, 'warn').filter((message) => /keeps choosing/.test(message));
  assert.ok(diagnoses.length >= 1, `expected the diagnosis to name the re-selection, got ${JSON.stringify(notices(result))}`);
  assert.match(diagnoses[0]!, /it keeps choosing \w+ instead of acting on it/);
});

test('ask_user is honoured even when needs_user is low', async () => {
  // The live regression: the selection was overruled by the needs_user threshold and fell through
  // to a route that expected a real tool, producing `unknown tool "ask_user"`.
  const result = await run({ tools: ['read_file', 'ask_user', 'read_file'], needsUser: 0.34 }, 'did you write the file?');

  assert.equal(result.approvals[0]?.tool, 'ask_user', 'expected Jev to be taken at its word');
  assert.match(String(result.approvals[0]?.reason), /needs information only you have/);
  assert.deepEqual(
    notices(result).filter((message) => /unknown tool/.test(message)),
    [],
    'a selected escape hatch is not an unknown tool',
  );

  const asked = decisions(result).find((event) => event.decision.tool === 'ask_user');
  assert.ok(asked, 'expected a decision routed to ask_user');
  assert.equal(asked.decision.route, 'ask-user');

  assert.equal(result.reason, 'goal-reached', `expected the run to resume after the question: ${result.summary}`);
});

test('a denied question stops the run cleanly', async () => {
  const result = await run({ tools: ['ask_user'] }, 'ship it', 'deny');
  assert.equal(result.reason, 'aborted');
  assert.match(result.summary, /declined/);
});

test('an unknown tool name falls back to the runner-up when it is real', async () => {
  const result = await run({ tools: [], hallucinations: { 0: 'apply_patch' } });

  const fallback = notices(result, 'info').find((message) => /unknown tool "apply_patch"/.test(message));
  assert.ok(fallback, `expected a runner-up substitution, got ${JSON.stringify(notices(result))}`);
  assert.match(fallback, /runner-up "read_file"/);
  assert.deepEqual(notices(result, 'error'), []);
});

test('exhausting tool-name corrections is a clean error', async () => {
  // next_action and fallback_action are both hallucinated on every attempt, so there is nothing to
  // substitute and the correction budget is what ends the run.
  const result = await run({
    tools: Array(10).fill('read_file'),
    hallucinations: { 0: 'apply_patch', 1: 'apply_patch', 2: 'apply_patch' },
    hallucinateFallback: true,
  });

  assert.equal(result.reason, 'error');
  assert.match(result.summary, /unknown tool "apply_patch"/);
  assert.equal(
    notices(result, 'warn').filter((message) => /asking again with the valid names/.test(message)).length,
    2,
    'expected exactly two corrections before giving up',
  );

  // The correction has to name the valid moves, or the re-ask cannot fix anything. Each decision
  // reaches Jev twice (routing, then arguments), so compare the distinct corrections, not states.
  const steered = result.states
    .map((state) => String(state.steering ?? ''))
    .filter((steering) => steering.includes('not a tool'));
  assert.ok(steered.length >= 2, 'the correction must reach Jev on every attempt');
  assert.match(steered[0]!, /read_file, write_file, edit_file/);
  assert.match(steered[0]!, /ask_user .*ask the user a question/);
});

test('maxRecoveries bounds the ladder', async () => {
  const result = await run(
    { tools: Array(16).fill('read_file'), stuck: 0.91, stuckFromStep: 4 },
    'fix the off-by-one',
    'allow',
    { maxRecoveries: 1 },
  );

  assert.equal(result.reason, 'needs-input');
  // A recovery now runs the move Jev picks next, so tool approvals appear between the hand-offs.
  const handoffs = result.approvals.filter((request) => request.tool === 'ask_user');
  assert.equal(handoffs.length, 1, 'one hand-off, then stop');
  assert.ok(
    result.events.some((event) => event.type === 'tool-call' && event.tool !== 'read_file'),
    'the recovery must try a different move, not climb the ladder without acting',
  );
});

test('the answer to a question reaches Jev instead of being discarded', async () => {
  // The hand-off asked "What should I do differently?" and the only thing the UI could send back was
  // allow/deny — the typed answer was dropped. It must arrive as steering on the next decision.
  const result = await run(
    { tools: Array(16).fill('read_file'), stuck: 0.91, stuckFromStep: 4, loopCauseConfidence: 0.1 },
    'fix the off-by-one',
    (request) => ({ choice: 'allow', answer: 'stop reading and write the test first' }),
  );

  assert.equal(result.reason, 'needs-input');
  const handoffs = result.approvals.filter((request) => request.tool === 'ask_user');
  assert.ok(handoffs.length >= 1);
  assert.ok(
    handoffs.every((request) => typeof request.question === 'string' && request.question.length > 0),
    'a hand-off approval must carry the question it is asking',
  );

  const steered = result.states
    .map((state) => String(state.steering ?? ''))
    .filter((steering) => steering.includes('stop reading and write the test first'));
  assert.ok(steered.length >= 1, 'the answer must reach Jev as steering');
  assert.match(steered[0]!, /stop reading and write the test first/);
});

test('an answered question resumes the run and can reach the goal', async () => {
  // ask_user on step 1: answering it must let the loop continue rather than dead-end, which is what
  // "gracefully improvise" means for this route. The goal is then scored reached, so the run can only
  // get there if the answer unblocked the next decision.
  const result = await run(
    { tools: ['ask_user'], goalReached: 0.9 },
    'did you write the file?',
    (request) => ({ choice: 'allow', answer: 'yes, write it' }),
  );

  assert.equal(result.reason, 'goal-reached');
  assert.equal(result.approvals[0]?.tool, 'ask_user');
  const steered = result.states.map((state) => String(state.steering ?? '')).join('\n');
  assert.match(steered, /yes, write it/);
});

test('declining a question still stops cleanly', async () => {
  const result = await run({ tools: ['ask_user'], goalReached: 0.9 }, 'did you write the file?', 'deny');

  assert.equal(result.reason, 'aborted');
  assert.equal(result.approvals.length, 1);
});

test('an open acceptance criterion vetoes goal-reached', async () => {
  // Jev scores the goal as reached and progress as complete, but says a criterion is unmet. The
  // goal-reached route must not fire; choosing `done` stays authoritative, so the run finishes that way.
  const result = await run({ tools: ['read_file'], criteriaMet: 0.1 });

  assert.equal(result.reason, 'finished', `expected the veto to hold: ${result.summary}`);
  const vetoed = decisions(result).find((event) => event.decision.criteriaVeto);
  assert.ok(vetoed, 'expected a decision flagged as vetoed by the criteria');
  assert.notEqual(vetoed.decision.route, 'goal-reached');
  assert.ok(notices(result, 'info').some((message) => /criterion 1 .* is still open/.test(message)));
});

test('Jev scores against the criteria and sees the ledger', async () => {
  const result = await run({ tools: ['read_file', 'run_shell'] }, 'fix the off-by-one in src/index.ts', 'allow', {
    autoApprove: true,
  });
  assert.equal(result.reason, 'goal-reached', result.summary);

  const criteria = result.events.filter((event) => event.type === 'criteria');
  assert.ok(criteria.length >= 2, 'expected the planned criteria and at least one change');
  assert.equal(criteria[0]!.type === 'criteria' && criteria[0].criteria.length, 2, 'the mock executor plans two');

  const routing = result.states.filter((state) => 'tools_available' in state);
  const ledger = routing[0]!.ledger as Record<string, unknown>;
  assert.match(String(ledger.focus), /^criterion 1: /);

  // After run_shell, the command and its result are in the ledger Jev scores from.
  const last = routing.at(-1)!.ledger as { verification?: Array<{ command: string }> };
  assert.equal(last.verification?.[0]?.command, 'echo mock-executor-ran');
});

test('choosing done ends the run even when the goal score is low', async () => {
  // The live failure: Jev picked `done` while its separate goal-reached score sat at 0.16–0.23.
  // Routed as a low-confidence action, `done` ran as a no-op tool and the loop kept going.
  // With criteria still open, the first `done` is sent back once; the repeated `done` is final.
  const result = await run({ tools: ['read_file', 'done', 'done', 'read_file'], goalReached: 0.1 });

  assert.equal(result.reason, 'finished', `expected done to end the run: ${result.summary}`);
  assert.ok(notices(result, 'info').some((message) => /chose "done" with .* still open .* asking once more/.test(message)));
  const challenged = result.states.find((state) => String(state.steering ?? '').includes('You chose done, but'));
  assert.ok(challenged, 'the open criteria reach Jev as steering');
  assert.ok(
    !result.events.some((event) => event.type === 'tool-call' && event.tool === 'done'),
    'done is a verdict, never an executed tool',
  );
  const done = result.events.find((event): event is DoneEvent => event.type === 'done');
  assert.equal(done?.steps, 2, 'the run should stop on the step Jev chose done');
  assert.ok(notices(result, 'warn').some((message) => /goal score/.test(message)));
});

test('re-reading a file that has not changed is skipped for Jev\'s runner-up, without asking again', async () => {
  // Jev settles read_file on the same path twice in a row; the second is never run.
  const result = await run({ tools: ['read_file', 'read_file', 'list_dir', 'list_dir'] });

  const reads = result.events.filter((event) => event.type === 'tool-call' && event.tool === 'read_file');
  assert.equal(reads.length, 1, 'the unchanged file is read once');
  assert.ok(notices(result, 'info').some((message) => /Skipped re-reading .* unchanged since/.test(message)));
  const reread = result.events.find((event) => event.type === 'tool-call' && event.step === 2 && event.tool === 'read_file');
  assert.equal(reread, undefined, 'step 2 goes to the runner-up instead');
  assert.equal(result.states.length, result.events.filter((event) => event.type === 'decision').length, 'one Jev call per decision');
});

test('the same search again, with no file changed since, is not run', async () => {
  const result = await run({ tools: ['grep', 'grep', 'list_dir'] });
  const greps = result.events.filter((event) => event.type === 'tool-call' && event.tool === 'grep');
  assert.equal(greps.length, 1, 'the identical grep runs once');
  assert.ok(result.events.some((event) => event.type === 'observation' && event.summary === 'repeat skipped'));
});
