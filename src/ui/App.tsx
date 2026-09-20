import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentEvent, ApprovalRequest, ApprovalResponse } from '../types.js';
import { Header, ApprovalBox, StatusBar, StepBlock, renderBlock } from './components.js';
import { initialState, reduce, type StepView } from './view.js';
import { isExitCommand } from './slash.js';
import { glyph, spinnerFrame, theme } from './theme.js';

export interface RunnerOptions {
  onEvent: (event: AgentEvent) => void;
  approve: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  signal: AbortSignal;
}

export type Runner = (goal: string, options: RunnerOptions) => Promise<void>;

export interface AppProps {
  workspace: string;
  version: string;
  llmLabel: string;
  jevLabel: string;
  /** Short name of the decision model in use, e.g. JEV or LAYA. */
  deciderName: string;
  maxSteps: number;
  explain: boolean;
  /** Start this goal as soon as the TUI mounts, as if it had been typed. */
  initialGoal?: string;
  runner: Runner;
  /** Fired once the Ink instance should unmount. */
  onExit: () => void;
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'ready',
  deciding: 'asking the decider what to do next',
  planning: 'executor filling in arguments',
  executing: 'running tool',
  verifying: 'asking the decider whether the goal is met',
  approving: 'waiting for approval',
};

export function App(props: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const approvalResolver = useRef<((response: ApprovalResponse) => void) | null>(null);
  const goalsRef = useRef<string[]>([]);

  useEffect(() => {
    // Only the spinner reads `tick`, and it only renders while a run is in flight — so an
    // unconditional interval would re-render the whole tree ~11x/second forever at the idle prompt.
    if (!running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  const resolveApproval = useCallback((response: ApprovalResponse) => {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setApproval(null);
    setInput('');
    resolve?.(response);
  }, []);

  const approve = useCallback(
    (request: ApprovalRequest) =>
      new Promise<ApprovalResponse>((resolve) => {
        approvalResolver.current = resolve;
        // The agent's last phase is whatever preceded the request ("planning" for a tool approval),
        // so without this the transcript and status read as though the executor were still busy.
        dispatch({ type: 'phase', phase: 'approving' });
        setApproval(request);
      }),
    [],
  );

  const run = useCallback(
    async (goal: string) => {
      if (running) return;
      const trimmed = goal.trim();
      if (!trimmed) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setElapsed(0);
      goalsRef.current = [...goalsRef.current, trimmed];
      dispatch({ type: 'goal', text: trimmed });

      try {
        await props.runner(trimmed, {
          onEvent: (event) => dispatch(event),
          approve,
          signal: controller.signal,
        });
      } catch (error) {
        dispatch({
          type: 'notice',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        dispatch({
          type: 'done',
          reason: 'error',
          summary: '',
          steps: 0,
          budget: { jevCalls: 0, jevInputTokens: 0, llmCalls: 0, llmPromptTokens: 0, llmCompletionTokens: 0, steps: 0 },
        });
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    },
    [approve, props, running],
  );

  const abort = useCallback(() => {
    if (approvalResolver.current) resolveApproval('deny');
    abortRef.current?.abort();
  }, [resolveApproval]);

  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    if (props.initialGoal) void run(props.initialGoal);
  }, [props.initialGoal, run]);

  const quit = useCallback(() => {
    abort();
    exit();
    props.onExit();
  }, [abort, exit, props]);

  const asking = approval?.question !== undefined;

  useInput(
    (char, key) => {
      if (key.ctrl && char === 'c') {
        // Claimed first and unconditionally: this handler used to be inactive at the idle prompt, so
        // ctrl-c there fell through to `TextInput`, which ignores it — a silent no-op. Ink's own
        // exit-on-ctrl-c is off (`exitOnCtrlC: false`), so quitting is entirely our job. `quit()`
        // aborts a run (and its child process) on the way out, so ctrl-c always means "leave" and
        // `esc` remains the way to stop a run without leaving.
        quit();
        return;
      }
      if (asking) {
        // A question is answered with the prompt's text input, not with y/n — so no keys are claimed
        // here and typed characters reach the input. Only the escape hatch is handled.
        if (key.escape) resolveApproval('deny');
        return;
      }
      if (approval) {
        if (char === 'y' || char === 'Y' || key.return) resolveApproval('allow');
        else if (char === 'a' || char === 'A') resolveApproval('allow-always');
        else if (char === 'n' || char === 'N' || key.escape) resolveApproval('deny');
        return;
      }
      if (running && key.escape) abort();
    },
    { isActive: true },
  );

  const live = state.live;
  const hint = useMemo(() => {
    if (asking) return 'type your answer · enter send · esc decline';
    if (approval) return 'y allow · a always · n deny';
    if (running) return 'esc abort · ctrl-c quit';
    return 'enter run · /exit quit · ctrl-c quit';
  }, [approval, asking, running]);

  return (
    <Box flexDirection="column">
      <Header
        workspace={props.workspace}
        llmLabel={props.llmLabel}
        jevLabel={props.jevLabel}
        version={props.version}
      />

      {state.blocks.length === 0 && !live ? (
        <Welcome explain={props.explain} deciderName={props.deciderName} />
      ) : null}

      <Static items={state.blocks}>
        {(block) => (
          <Box key={block.key} flexDirection="column">
            {renderBlock(block, props.explain)}
          </Box>
        )}
      </Static>

      {live ? (
        <Box flexDirection="column">
          <StepLive view={live} explain={props.explain} />
        </Box>
      ) : null}

      {approval ? <ApprovalBox request={approval} /> : null}

      {asking ? (
        // Only a question gets a text input. A y/n approval is answered with a single key, and an
        // input there both reads as "type something" and swallows the key into the next prompt.
        <Box marginTop={1} flexDirection="column">
          <Box borderStyle="round" borderColor={theme.warn} paddingX={1} width="100%">
            <Text color={theme.warn}>{glyph.prompt} </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value) => {
                const answer = value.trim();
                // Enter on an empty answer means "no answer" — treat it as declining rather than
                // handing Jev a blank instruction it cannot act on.
                if (answer) resolveApproval({ choice: 'allow', answer });
                else resolveApproval('deny');
              }}
              placeholder="answer the agent…"
              focus
            />
          </Box>
          <Box paddingX={1}>
            <Text color={theme.dim}>{hint}</Text>
          </Box>
        </Box>
      ) : approval ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.warn}>{hint}</Text>
        </Box>
      ) : null}

      {running && !approval ? (
        // Hidden while waiting on the user: a spinning "executor filling in arguments" and a
        // climbing elapsed counter make a paused run look like a hung one.
        <Box marginTop={1} flexDirection="column">
          <StatusBar
            phase={PHASE_LABEL[state.phase] ?? state.phase}
            frame={spinnerFrame(tick)}
            budget={state.budget}
            step={state.budget.steps}
            maxSteps={props.maxSteps}
            hint={hint}
          />
          <Box paddingX={1}>
            <Text color={theme.dim}>
              {elapsed}s elapsed
              {state.budget.llmCalls > 0 ? ` · ${state.budget.llmCalls} executor calls` : ''}
            </Text>
          </Box>
        </Box>
      ) : null}

      {!running && !approval ? (
        <Box marginTop={1} flexDirection="column">
          <Box borderStyle="round" borderColor={theme.accent} paddingX={1} width="100%">
            <Text color={theme.accent}>{glyph.prompt} </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value) => {
                setInput('');
                // `/exit` (and friends) leave the session; anything else is a goal. An unknown
                // slash command is still a goal — the agent may well have a reason to see it.
                if (isExitCommand(value)) quit();
                else void run(value);
              }}
              placeholder={
                goalsRef.current.length === 0
                  ? 'describe what you want the agent to do…'
                  : 'another goal — the session context carries over…'
              }
              focus
            />
          </Box>
          <Box paddingX={1} justifyContent="space-between">
            <Text color={theme.dim}>{hint}</Text>
            <Text color={theme.dim}>
              jev {state.budget.jevCalls} · llm {state.budget.llmCalls} · {state.budget.steps} steps
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function Welcome({ explain, deciderName }: { explain: boolean; deciderName: string }) {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text color={theme.muted}>
        Two models, one loop: <Text color={theme.jev}>{deciderName}</Text> decides the next action, the{' '}
        <Text color={theme.llm}>executor LLM</Text> writes the code.
      </Text>
      <Text color={theme.dim}>
        every step it answers: which tool, whether the goal is reached, how far along, whether we are stuck.
      </Text>
      {!explain ? <Text color={theme.dim}>run with --explain to show full probability legends.</Text> : null}
    </Box>
  );
}

/** The in-flight step, rendered by the same component tree as the frozen ones. */
function StepLive({ view, explain }: { view: StepView; explain: boolean }) {
  return <StepBlock view={view} explain={explain} />;
}
