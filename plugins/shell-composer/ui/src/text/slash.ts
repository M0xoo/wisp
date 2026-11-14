// Slash commands in the reply box and New task (v1 web/js/slash-text.js): what the / menu offers
// and how a message reads as one. Pure. The peer parses the same forms (the CLI and the phone send
// them as text), so these only decide what the box does locally before sending.

export interface SlashCommand {
  readonly name: string;
  /** i18n key of what goes after the command ("question") */
  readonly args: string;
  /** i18n key of the one-line hint */
  readonly hint: string;
  /** alone, it does something itself (opens a popover or a dialog) instead of needing text */
  readonly bare?: boolean;
}

const k = (name: string, what: 'args' | 'hint'): string => `shell-composer.slash.${name}.${what}`;
const cmd = (name: string, bare = false): SlashCommand => ({ name, args: k(name, 'args'), hint: k(name, 'hint'), ...(bare && { bare }) });

/** In an open task's reply box. */
export const SLASH: readonly SlashCommand[] = [
  cmd('btw'),
  cmd('side'),
  cmd('goal', true),
  cmd('spell'),
  cmd('feedback', true),
  cmd('bug', true),
  cmd('draft'),
  cmd('after'),
  cmd('login', true), // wisp's own, never sent to the agent
];

/** In New task: no run to ask on the side yet, and a goal starts a task. */
export const HOME_SLASH: readonly SlashCommand[] = [
  ...SLASH.filter((c) => c.name !== 'btw' && c.name !== 'side' && c.name !== 'login').map((c) =>
    c.name === 'goal' ? { ...c, hint: 'shell-composer.slash.goal.home-hint' } : c,
  ),
  cmd('terminal'),
  cmd('sandbox'),
];

/** The commands a half-typed "/b" could be; only while the box holds nothing but the command. */
export function slashMatches(text: string, list: readonly SlashCommand[] = SLASH): readonly SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(text);
  const typed = m?.[1]?.toLowerCase();
  return typed === undefined ? [] : list.filter((c) => c.name.startsWith(typed));
}

/** "/<name> rest" → rest ('' for a bare command), or null when the text isn't that command. */
export function slashArg(name: string, text: string): string | null {
  const re = new RegExp(`^/${name}(?:\\s+|$)`, 'i');
  const t = text.trim();
  return re.test(t) ? t.replace(re, '').trim() : null;
}

export const btwQuestion = (text: string): string | null => slashArg('btw', text);
export const sideAsk = (text: string): string | null => slashArg('side', text);
export const goalAsk = (text: string): string | null => slashArg('goal', text);
export const spellAsk = (text: string): string | null => slashArg('spell', text);
export const draftAsk = (text: string): string | null => slashArg('draft', text);
export const terminalAsk = (text: string): string | null => slashArg('terminal', text);
export const sandboxAsk = (text: string): string | null => slashArg('sandbox', text);
export const isBtw = (text: string): boolean => /^\/btw(?:\s+|$)/i.test(text.trimStart());
export const isLogin = (text: string): boolean => /^\/login$/i.test(text.trim());
export const isGoalDrop = (rest: string): boolean => /^(drop|clear|off|none)$/i.test(rest);
/** "make me a pane that…": a Make a pane task, not an ordinary one. */
export const isPaneAsk = (text: string): boolean => /^(please\s+)?make\s+(me\s+)?a\s+pane\b/i.test(text.trim());

// The task as a mention (`@[Title](wisp:<id>)`), a bare id, `wisp:<id>` or a `#/s/<id>` link.
const AFTER_TASK = /^(?:@\[[^\]\n]{1,200}\]\(wisp:([a-z0-9]{6,40})\)|(?:wisp:)?([a-f0-9]{12})|\S*#\/s\/([a-z0-9]{6,40})\/?)(?=\s|$)/;

/** "/after <task> <prompt>" → { id, prompt } ('' for what's missing), or null when it isn't one. */
export function afterAsk(text: string): { id: string; prompt: string } | null {
  const t = text.trim();
  const AFTER = /^\/after(?:\s+|$)/i;
  if (!AFTER.test(t)) return null;
  const rest = t.replace(AFTER, '');
  const m = AFTER_TASK.exec(rest);
  if (!m) return { id: '', prompt: rest.trim() };
  return { id: m[1] ?? m[2] ?? m[3] ?? '', prompt: rest.slice(m[0].length).trim() };
}

/** The other side of a clash card: lines compared trimmed (an edit's old text loses its indent). */
const trimmedLines = (t: string): string => t.split('\n').map((l) => l.trim()).join('\n').trim();
export const sameLines = (a: string, b: string | undefined): boolean => !!b && trimmedLines(a) === trimmedLines(b);
