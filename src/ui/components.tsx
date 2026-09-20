import React from 'react';
import { Box, Text } from 'ink';
import type { ApprovalRequest, Budget, DoneReason, JevDecision } from '../types.js';
import type { Block, StepView } from './view.js';
import { colorForProbability, formatTokens, glyph, meter, percent, scoreMeter, theme, truncate } from './theme.js';

/*
 * Which decision model is answering, for the one place it is printed per step. One run has one
 * decider, so this is set once at startup rather than threaded through every block — the blocks
 * are rendered from a flat list, and a prop would have to cross all of it to say one word.
 */
let currentDecider = 'JEV';

export function setDeciderName(name: string): void {
  currentDecider = name.toUpperCase();
}

export function deciderName(): string {
  return currentDecider;
}

/* ------------------------------------------------------------------ header */

export function Header({
  workspace,
  llmLabel,
  jevLabel,
  version,
}: {
  workspace: string;
  llmLabel: string;
  jevLabel: string;
  version: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        width="100%"
        justifyContent="space-between"
      >
        <Text>
          <Text color={theme.accent} bold>
            {glyph.brand} jeffrey
          </Text>
          <Text color={theme.dim}> {version}</Text>
        </Text>
        <Text color={theme.muted}>{truncate(workspace, 44)}</Text>
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text>
          <Text color={theme.muted}>router </Text>
          <Text color={theme.jev}>{jevLabel}</Text>
          <Text color={theme.dim}> · </Text>
          <Text color={theme.muted}>executor </Text>
          <Text color={theme.llm}>{llmLabel}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ goal */

export function GoalBlock({ text }: { text: string }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.accent}>{glyph.prompt} </Text>
        <Text color={theme.muted}>goal </Text>
        <Text color={theme.text} bold>
          {text}
        </Text>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ Jev decision */

export function JevPanel({ decision, explain }: { decision: JevDecision; explain: boolean }) {
  const ranked = Object.entries(decision.probabilities)
    .filter(([name]) => name !== decision.tool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, explain ? 8 : 2);

  const riskLevels = Object.keys(decision.riskLegend).length || 1;
  const progressLevels = Object.keys(decision.progressLegend).length || 1;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.jev}>{glyph.jev} {deciderName()} </Text>
          <Text color={theme.jev} bold>
            {decision.tool}
          </Text>
          {decision.route !== 'act' ? <Text color={theme.warn}> [{decision.route}]</Text> : null}
        </Text>
        <Text color={theme.muted}>confidence {decision.confidence.toFixed(2)}</Text>
      </Box>

      <Box>
        <Text color={colorForProbability(decision.confidence)}>{meter(decision.confidence, 8)} </Text>
        <Text color={theme.muted}>goal </Text>
        <Text color={colorForProbability(decision.goalReached)}>{percent(decision.goalReached)}</Text>
        <Text color={theme.dim}> │ </Text>
        <Text color={theme.muted}>progress </Text>
        <Text color={theme.text}>
          {decision.progress.toFixed(1)}/{Math.max(1, progressLevels - 1)}
        </Text>
        <Text color={theme.dim}> │ </Text>
        <Text color={theme.muted}>stuck </Text>
        <Text color={decision.stuck >= 0.5 ? theme.danger : theme.muted}>{percent(decision.stuck)}</Text>
        <Text color={theme.dim}> │ </Text>
        <Text color={theme.muted}>needs-user </Text>
        <Text color={decision.needsUserInput >= 0.5 ? theme.warn : theme.muted}>
          {percent(decision.needsUserInput)}
        </Text>
        <Text color={theme.dim}> │ </Text>
        <Text color={theme.muted}>risk </Text>
        <Text color={decision.risk >= 2 ? theme.warn : theme.muted}>
          {decision.risk.toFixed(1)}/{Math.max(1, riskLevels - 1)}
        </Text>
      </Box>

      <Box>
        <Text color={theme.dim}>runner-up </Text>
        <Text color={theme.muted}>{decision.fallbackTool}</Text>
        {ranked.map(([name, probability]) => (
          <Text key={name} color={theme.dim}>
            {' '}
            {glyph.bullet} {name} {percent(probability).trim()}
          </Text>
        ))}
      </Box>

      {explain ? (
        <Box flexDirection="column">
          <Text color={theme.dim}>
            progress legend: {Object.values(decision.progressLegend).join(' │ ') || 'n/a'}
          </Text>
          <Text color={theme.dim}>risk legend: {Object.values(decision.riskLegend).join(' │ ') || 'n/a'}</Text>
          {Object.keys(decision.toolRelevance).length > 0 ? (
            <Text color={theme.dim}>
              relevance:{' '}
              {Object.entries(decision.toolRelevance)
                .sort((a, b) => b[1] - a[1])
                .map(([name, probability]) => `${name} ${percent(probability).trim()}`)
                .join(' · ')}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

/* ------------------------------------------------------------------ tool call */

export function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'path' || key === 'command') {
      parts.push(String(value));
      continue;
    }
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${truncate(rendered, 40)}`);
  }
  return truncate(parts.join(' '), 100);
}

export function ToolCallLine({ tool, args, fromFallback }: { tool: string; args?: Record<string, unknown>; fromFallback?: boolean }) {
  return (
    <Box paddingLeft={2}>
      <Text color={theme.llm}>{glyph.tool} </Text>
      <Text color={theme.llm} bold>
        {tool}
      </Text>
      <Text color={theme.text}> {formatArgs(args)}</Text>
      {fromFallback ? <Text color={theme.warn}> (prompt fallback)</Text> : null}
    </Box>
  );
}

/* ------------------------------------------------------------------ diff */

export function DiffBlock({ diff, maxLines = 30 }: { diff: string; maxLines?: number }) {
  const raw = diff.split('\n').filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ '));
  const lines: Array<{ sign: string; text: string }> = [];
  let skipped = 0;

  for (const line of raw) {
    const sign = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
    if (sign === ' ') {
      skipped += 1;
      continue;
    }
    lines.push({ sign, text: line.slice(1) });
  }

  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;

  return (
    <Box flexDirection="column" paddingLeft={3}>
      {shown.map((line, index) => (
        <Text key={index}>
          <Text color={line.sign === '+' ? theme.add : theme.del}>
            {line.sign === '+' ? '+ ' : '- '}
          </Text>
          <Text color={line.sign === '+' ? theme.add : theme.del}>{truncate(line.text, 160)}</Text>
        </Text>
      ))}
      {hidden > 0 ? <Text color={theme.dim}> … {hidden} more changed lines</Text> : null}
      {lines.length === 0 ? <Text color={theme.dim}>(no line changes{skipped ? '; file content identical' : ''})</Text> : null}
    </Box>
  );
}

/* ------------------------------------------------------------------ observation */

export function OutputBlock({ output, ok, maxLines = 14 }: { output: string; ok: boolean; maxLines?: number }) {
  const lines = output.replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;

  return (
    <Box flexDirection="column" paddingLeft={3}>
      <Box flexDirection="column" borderStyle="single" borderColor={ok ? theme.border : theme.danger} paddingLeft={1} width="100%">
        {shown.map((line, index) => (
          <Text key={index} color={theme.muted} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
        {hidden > 0 ? <Text color={theme.dim}> … {hidden} more lines</Text> : null}
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ step */

export function StepBlock({ view, explain }: { view: StepView; explain: boolean }) {
  const running = view.phase !== 'idle';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={running ? theme.accent : theme.dim}>{glyph.running} </Text>
        <Text color={theme.muted}>step </Text>
        <Text color={theme.text} bold>
          {view.step}
        </Text>
        {view.decision ? <Text color={theme.dim}> · {view.decision.route}</Text> : null}
        <Text color={theme.dim}> · {view.phase}</Text>
      </Box>

      {view.decision ? <JevPanel decision={view.decision} explain={explain} /> : null}

      {view.context ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>
            context: {view.context.paths.join(', ')} — {truncate(view.context.why, 60)}
          </Text>
        </Box>
      ) : null}

      {view.earlier?.map((call, index) => (
        <Box key={index} flexDirection="column">
          <ToolCallLine tool={call.tool} args={call.args} />
          <Box paddingLeft={3}>
            <Text color={call.ok ? theme.dim : theme.danger}>{truncate(call.summary, 120)}</Text>
          </Box>
        </Box>
      ))}

      {view.tool ? <ToolCallLine tool={view.tool} args={view.args} fromFallback={view.fromFallback} /> : null}

      {view.reasoning && !view.tool ? (
        <Box paddingLeft={3}>
          <Text color={theme.dim}>{glyph.reasoning} </Text>
          <Text color={theme.dim}>{truncate(view.reasoning, 220)}</Text>
        </Box>
      ) : null}

      {view.observation?.diff ? <DiffBlock diff={view.observation.diff} /> : null}

      {view.observation && !view.observation.diff ? (
        <OutputBlock output={view.observation.output || view.observation.summary} ok={view.observation.ok} />
      ) : null}

      {view.narration ? (
        <Box paddingLeft={2}>
          <Text color={theme.llm}>{glyph.narration} </Text>
          <Text color={theme.text}>{truncate(view.narration, 300)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/* ------------------------------------------------------------------ notice + final */

export function NoticeBlock({ level, message }: { level: 'info' | 'warn' | 'error'; message: string }) {
  const color = level === 'error' ? theme.danger : level === 'warn' ? theme.warn : theme.muted;
  const mark = level === 'error' ? glyph.fail : level === 'warn' ? '!' : glyph.bullet;
  return (
    <Box paddingLeft={2}>
      <Text color={color}>
        {mark} {message}
      </Text>
    </Box>
  );
}

export function CriteriaBlock({
  step,
  criteria,
  changed,
}: {
  step: number;
  criteria: Array<{ id: number; text: string; met: boolean }>;
  changed: number[];
}) {
  const met = criteria.filter((criterion) => criterion.met).length;
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={step === 0 ? 1 : 0}>
      <Text color={theme.muted}>
        {step === 0 ? 'done means' : `criteria before step ${step}`} · {met}/{criteria.length} met
      </Text>
      {criteria.map((criterion) => (
        <Text
          key={criterion.id}
          color={criterion.met ? theme.success : theme.text}
          bold={changed.includes(criterion.id)}
        >
          {'  '}
          {criterion.met ? glyph.done : '○'} {criterion.id}. {truncate(criterion.text, 160)}
        </Text>
      ))}
    </Box>
  );
}

const REASON_TITLE: Record<DoneReason, string> = {
  'goal-reached': 'goal reached',
  finished: 'finished',
  'max-steps': 'step budget exhausted',
  aborted: 'aborted',
  error: 'failed',
  stuck: 'stuck — no progress',
  'needs-input': 'needs your input',
};

export function FinalBlock({
  reason,
  summary,
  steps,
  budget,
  decision,
}: {
  reason: DoneReason;
  summary: string;
  steps: number;
  budget: Budget;
  decision?: JevDecision;
}) {
  const good = reason === 'goal-reached' || reason === 'finished';
  const held = reason === 'needs-input';
  const color = good ? theme.success : reason === 'aborted' ? theme.muted : held ? theme.warn : theme.danger;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={color} paddingX={1} width="100%" flexDirection="column">
        <Box justifyContent="space-between">
          <Text color={color} bold>
            {good ? glyph.done : held ? '◐' : glyph.fail} {REASON_TITLE[reason]}
          </Text>
          {decision ? (
            <Text color={theme.muted}>
              Jev scored the goal at {(decision.goalReached * 100).toFixed(0)}% · progress{' '}
              {decision.progress.toFixed(1)}/{Math.max(1, Object.keys(decision.progressLegend).length - 1)}
            </Text>
          ) : null}
        </Box>
        {summary ? <Text color={theme.text}>{truncate(summary, 400)}</Text> : null}
        <Text color={theme.dim}>
          {steps} steps · {budget.jevCalls} Jev calls ({formatTokens(budget.jevInputTokens)} tok) · {budget.llmCalls} LLM calls (
          {formatTokens(budget.llmPromptTokens)}→{formatTokens(budget.llmCompletionTokens)} tok)
        </Text>
      </Box>
    </Box>
  );
}

export function renderBlock(block: Block, explain: boolean) {
  switch (block.kind) {
    case 'goal':
      return <GoalBlock text={block.text} />;
    case 'step':
      return <StepBlock view={block.view} explain={explain} />;
    case 'notice':
      return <NoticeBlock level={block.level} message={block.message} />;
    case 'criteria':
      return <CriteriaBlock step={block.step} criteria={block.criteria} changed={block.changed} />;
    case 'final':
      return (
        <FinalBlock
          reason={block.reason}
          summary={block.summary}
          steps={block.steps}
          budget={block.budget}
          {...(block.decision ? { decision: block.decision } : {})}
        />
      );
  }
}

/* ------------------------------------------------------------------ approval */

export function ApprovalBox({ request }: { request: ApprovalRequest }) {
  // `ask_user` carries its payload in `question`, and that question is the whole point of the box —
  // folding it into the one-line args preview would clip it to 40 characters and lose the ask.
  const args = { ...(request.args as Record<string, unknown> | undefined) };
  const question =
    request.question ?? (typeof args.question === 'string' ? args.question : null);
  delete args.question;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
      width="100%"
      marginTop={1}
    >
      <Text color={theme.warn} bold>
        {question ? 'the agent is asking you a question' : `approval needed — ${request.tool}`}
      </Text>
      <Text color={theme.muted}>{request.reason}</Text>
      {question ? <Text color={theme.text}>{truncate(question, 400)}</Text> : null}
      {question ? null : <Text color={theme.text}>{formatArgs(args)}</Text>}
      {request.preview ? <Text color={theme.muted}>{truncate(request.preview, 500)}</Text> : null}
      <Text color={theme.dim}>
        {question
          ? 'type your answer and press enter · esc to decline'
          : `risk ${request.risk.toFixed(1)} · [y] allow · [a] always allow ${request.tool} · [n] deny`}
      </Text>
    </Box>
  );
}

/* ------------------------------------------------------------------ footer */

export function StatusBar({
  phase,
  frame,
  budget,
  step,
  maxSteps,
  hint,
}: {
  phase: string;
  frame: string;
  budget: Budget;
  step: number;
  maxSteps: number;
  hint: string;
}) {
  return (
    <Box paddingX={1} width="100%" justifyContent="space-between">
      <Text>
        <Text color={theme.accent}>{frame} </Text>
        <Text color={theme.muted}>{phase}</Text>
        <Text color={theme.dim}> · step {step}/{maxSteps}</Text>
      </Text>
      <Text color={theme.dim}>{hint}</Text>
      <Text color={theme.dim}>
        jev {budget.jevCalls} · llm {budget.llmCalls} · {formatTokens(budget.llmPromptTokens + budget.jevInputTokens)} in /{' '}
        {formatTokens(budget.llmCompletionTokens)} out
      </Text>
    </Box>
  );
}

export { scoreMeter, meter, percent };
