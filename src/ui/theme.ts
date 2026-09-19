/** One place for every colour and glyph, so the whole UI can be re-skinned from here. */
export const theme = {
  accent: '#7c9cff',
  jev: '#c792ea',
  llm: '#82d2a0',
  muted: '#6b7280',
  dim: '#4b5563',
  text: '#e5e7eb',
  success: '#4ade80',
  warn: '#fbbf24',
  danger: '#f87171',
  add: '#4ade80',
  del: '#f87171',
  border: '#374151',
} as const;

export const glyph = {
  brand: '◆',
  jev: '◈',
  tool: '▸',
  reasoning: '∴',
  narration: '✎',
  done: '✓',
  fail: '✗',
  running: '●',
  prompt: '❯',
  bullet: '·',
} as const;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(tick: number): string {
  return SPINNER[tick % SPINNER.length]!;
}

/** A ten-cell probability bar. Cheap to read at a glance in a terminal. */
export function meter(probability: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, probability));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function percent(probability: number): string {
  return `${Math.round(probability * 100)
    .toString()
    .padStart(3, ' ')}%`;
}

export function scoreMeter(score: number, levels: number, width = 10): string {
  return meter(score / Math.max(1, levels - 1), width);
}

export function colorForProbability(probability: number): string {
  if (probability >= 0.7) return theme.success;
  if (probability >= 0.4) return theme.warn;
  return theme.danger;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function clock(date = new Date()): string {
  return date.toTimeString().slice(0, 8);
}
