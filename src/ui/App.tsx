import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentEvent, ApprovalRequest, ApprovalResponse } from '../types.js';
import { Header, ApprovalBox, StatusBar, StepBlock, renderBlock } from './components.js';
import { initialState, reduce, type StepView } from './view.js';
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
  deciding: 'asking Jev what to do next',
  planning: 'executor filling in arguments',
  executing: 'running tool',
  verifying: 'asking Jev whether the goal is met',
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
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, []);

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
      if (key.ctrl && char === 'c') {
        if (running) {
          dispatch({ type: 'notice', level: 'warn', message: 'aborting — sending SIGINT to the running tool' });
          abort();
        } else {
          quit();
        }
        return;
      }
      if (running && key.escape) abort();
    },
    { isActive: approval !== null || running },
  );

  const live = state.live;
  const hint = useMemo(() => {
    if (asking) return 'type your answer · enter send · esc decline';
    if (approval) return 'y allow · a always · n deny';
    if (running) return 'esc abort · ctrl-c quit';
    return 'enter run · ctrl-c quit';
  }, [approval, asking, running]);

  return (
    <Box flexDirection="column">
      <Header
        workspace={props.workspace}
        llmLabel={props.llmLabel}
        jevLabel={props.jevLabel}
        version={props.version}
      />

      {state.blocks.length === 0 && !live ? <Welcome explain={props.explain} /> : null}

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

      {approval ? (
        <Box marginTop={1} flexDirection="column">
          <Box borderStyle="round" borderColor={theme.warn} paddingX={1} width="100%">
            <Text color={theme.warn}>{glyph.prompt} </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value) => {
                if (asking) {
                  const answer = value.trim();
                  // Enter on an empty answer means "no answer" — treat it as declining rather than
                  // handing Jev a blank instruction it cannot act on.
                  if (answer) resolveApproval({ choice: 'allow', answer });
                  else resolveApproval('deny');
                  return;
                }
                resolveApproval('allow');
              }}
              placeholder="answer the agent…"
              focus
            />
          </Box>
          <Box paddingX={1}>
            <Text color={theme.dim}>{hint}</Text>
          </Box>
        </Box>
      ) : null}

      {running && !asking ? (
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

      {approval && !asking ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.dim}>{hint}</Text>
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
                void run(value);
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

function Welcome({ explain }: { explain: boolean }) {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text color={theme.muted}>
        Two models, one loop: <Text color={theme.jev}>Jev</Text> decides the next action, the{' '}
        <Text color={theme.llm}>executor LLM</Text> writes the code.
      </Text>
      <Text color={theme.dim}>
        every step Jev answers: which tool, whether the goal is reached, how far along, whether we are stuck.
      </Text>
      {!explain ? <Text color={theme.dim}>run with --explain to show full probability legends.</Text> : null}
    </Box>
  );
}

/** The in-flight step, rendered by the same component tree as the frozen ones. */
function StepLive({ view, explain }: { view: StepView; explain: boolean }) {
  return <StepBlock view={view} explain={explain} />;
}
