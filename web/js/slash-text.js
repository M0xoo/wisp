// Slash commands in a follow-up box, DOM-free: what the / menu offers and how a message reads as
// one. The server knows /btw too (server/btw.js), so the CLI and the phone can use it.

export const SLASH = [
  { name: 'btw', args: 'question', hint: 'Ask on the side. The agent keeps working' },
  { name: 'feedback', args: 'note', hint: 'Tell the wisp team what works or breaks', bare: true }, // alone: opens the dialog
];

const BTW_CMD = /^\/btw(?:\s+|$)/i;
export const isBtw = (text) => BTW_CMD.test(String(text || '').trimStart());

// The question in "/btw did you …" ('' for a bare /btw), or null when the text isn't a /btw.
export function btwQuestion(text) {
  const t = String(text || '').trim();
  return BTW_CMD.test(t) ? t.replace(BTW_CMD, '').trim() : null;
}

// The commands a half-typed "/b" could be. Only while the box holds nothing but the command.
export function slashMatches(text, list = SLASH) {
  const m = /^\/([a-z]*)$/i.exec(String(text || ''));
  return m ? list.filter((c) => c.name.startsWith(m[1].toLowerCase())) : [];
}
