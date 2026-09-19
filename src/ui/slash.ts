/**
 * Slash commands typed at the idle prompt.
 *
 * Parsing lives here as a pure function so the TUI and the tests cannot drift apart: a line that
 * starts with `/` is a command, anything else is a goal. `/exit` is the documented one; `/quit`
 * and `/q` are accepted because someone who types them plainly means to leave, and having that
 * silently become a goal sent to the agent is the worst possible outcome.
 */

const EXIT_COMMANDS = new Set(['/exit', '/quit', '/q']);

export interface SlashCommand {
  /** Lower-cased command including the leading slash, e.g. `/exit`. */
  name: string;
  /** Everything after the command word, whitespace-joined. */
  arg: string;
}

/** Parse a prompt line into a command, or `null` when it is an ordinary goal. */
export function parseSlashCommand(value: string): SlashCommand | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head = '', ...rest] = trimmed.split(/\s+/);
  return { name: head.toLowerCase(), arg: rest.join(' ') };
}

/** Whether this prompt line should end the session instead of starting a run. */
export function isExitCommand(value: string): boolean {
  const command = parseSlashCommand(value);
  return command !== null && EXIT_COMMANDS.has(command.name);
}
