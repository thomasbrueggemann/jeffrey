import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { Agent } from '../src/core/agent.js';
import { MockJevClient, type MockScript } from '../src/core/mock-jev.js';
import { MockLlmClient } from '../src/core/llm.js';
import type { AgentEvent, ApprovalChoice, ApprovalRequest, DoneReason } from '../src/types.js';

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
  approve: ApprovalChoice = 'allow',
  agent: Partial<Config['agent']> = {},
): Promise<RunResult> {
  const config: Config = {
    ...DEFAULT_CONFIG,
    agent: { ...DEFAULT_CONFIG.agent, workspace: await scratchWorkspace(), ...agent },
  };
  const jev = new MockJevClient(script);
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
      return approve;
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
  // re-ask, because the agent withheld the tool and told it what the loop looks like.
  const result = await run({
    tools: ['read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
    finalGoalReached: 0.94,
    stuck: 0.91,
    stuckFromStep: 4,
    stuckUntilCall: 4,
  });

  assert.equal(result.reason, 'goal-reached', `expected recovery to continue the run: ${result.summary}`);

  const diagnoses = notices(result, 'warn').filter((message) => /detected a loop/.test(message));
  assert.equal(diagnoses.length, 1, `expected one loop diagnosis, got ${JSON.stringify(notices(result))}`);
  assert.match(diagnoses[0]!, /read_file ran 4 of the last 4/);

  // The recovery has to reach Jev as steering, or it is just a log line.
  const steered = result.states.filter((state) => Array.isArray(state.steering) && state.steering.length > 0);
  assert.ok(steered.length >= 1, 'expected the loop diagnosis to be handed back to Jev');
  assert.match(String(steered[0]!.steering), /Repeating a call that did not move the goal/);

  // Withholding the tool is the lever that actually changes the answer, and the payload must not
  // then advertise the tool it just withheld.
  assert.ok(
    result.states.some((state) => !offeredTools(state).includes('read_file')),
    'expected read_file to be withheld from the choice set after the loop',
  );

  // A re-ask costs Jev calls, not steps: the run finished inside the step it got stuck on.
  const done = result.events.find((event): event is DoneEvent => event.type === 'done');
  assert.ok(done);
  assert.equal(done.steps, 5, 'the recovery should not consume a step of its own');
  assert.equal(decisions(result).length, 6, 'one extra decision for the recovery re-ask');
});

test('a persistent loop hands off to the user instead of failing', async () => {
  // Jev never stops reporting the loop, so the ladder runs out: improvise, hand off, stop — with
  // the user in the loop rather than a red "failed".
  const result = await run({
    tools: Array(16).fill('read_file'),
    stuck: 0.91,
    stuckFromStep: 4,
  });

  assert.equal(result.reason, 'needs-input', `expected a hand-off, got ${result.summary}`);
  const handoff = result.approvals.find((request) => request.tool === 'ask_user');
  assert.ok(handoff, 'expected the loop to be handed to the user with a question');
  assert.match(String(handoff.args.question), /widened the context/);
  assert.match(String(handoff.args.question), /What should I do differently\?/);
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

  // The correction has to name the valid moves, or the re-ask cannot fix anything.
  const steered = result.states.filter((state) => String(state.steering ?? '').includes('not a tool'));
  assert.equal(steered.length, 2);
  assert.match(String(steered[0]!.steering), /read_file, write_file, edit_file/);
  assert.match(String(steered[0]!.steering), /ask_user .*ask the user a question/);
});

test('maxRecoveries bounds the ladder', async () => {
  const result = await run(
    { tools: Array(16).fill('read_file'), stuck: 0.91, stuckFromStep: 4 },
    'fix the off-by-one',
    'allow',
    { maxRecoveries: 1 },
  );

  assert.equal(result.reason, 'needs-input');
  assert.equal(result.approvals.length, 1, 'one hand-off, then stop');
});
