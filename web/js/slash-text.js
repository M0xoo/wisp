// Slash commands in a follow-up box, DOM-free: what the / menu offers and how a message reads as
// one. The server knows /btw too (server/btw.js), so the CLI and the phone can use it.

export const SLASH = [
  { name: 'btw', args: 'question', hint: 'Ask on the side. The agent keeps working' },
  { name: 'goal', args: 'what has to be true', hint: 'Keep going until it holds. /goal drop stops', bare: true }, // alone: opens the goal's popover
  { name: 'spell', args: 'what to change', hint: 'Cast a spell: change wisp itself' },
  { name: 'feedback', args: 'note', hint: 'Tell the wisp team what works or breaks', bare: true }, // alone: opens the dialog
];
// The new-task box: there's no run to ask on the side yet, and a goal starts a task.
export const HOME_SLASH = SLASH.filter((c) => c.name !== 'btw').map((c) => (c.name === 'goal' ? { ...c, hint: 'Start a task that keeps going until it holds' } : c));

const BTW_CMD = /^\/btw(?:\s+|$)/i;
export const isBtw = (text) => BTW_CMD.test(String(text || '').trimStart());

// The question in "/btw did you …" ('' for a bare /btw), or null when the text isn't a /btw.
export function btwQuestion(text) {
  const t = String(text || '').trim();
  return BTW_CMD.test(t) ? t.replace(BTW_CMD, '').trim() : null;
}

// What to change in "/spell a floating PR button" ('' for a bare /spell), or null when it isn't one.
const SPELL_CMD = /^\/spell(?:\s+|$)/i;
export function spellAsk(text) {
  const t = String(text || '').trim();
  return SPELL_CMD.test(t) ? t.replace(SPELL_CMD, '').trim() : null;
}
export const SPELL_HINT = 'Say what to change after /spell, like “/spell a floating button that opens my PRs”';

// The condition in "/goal all tests pass" ('' for a bare /goal), or null when it isn't one.
// The server reads it the same way (server/goal.js), for the CLI and the phone.
const GOAL_CMD = /^\/goal(?:\s+|$)/i;
export function goalAsk(text) {
  const t = String(text || '').trim();
  return GOAL_CMD.test(t) ? t.replace(GOAL_CMD, '').trim() : null;
}
export const isGoalDrop = (rest) => /^(drop|clear|off|none)$/i.test(rest || '');

// The commands a half-typed "/b" could be. Only while the box holds nothing but the command.
export function slashMatches(text, list = SLASH) {
  const m = /^\/([a-z]*)$/i.exec(String(text || ''));
  return m ? list.filter((c) => c.name.startsWith(m[1].toLowerCase())) : [];
}
