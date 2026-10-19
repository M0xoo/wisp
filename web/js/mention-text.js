// Task mentions in prompts, without the DOM. A prompt stores one as `@[Title](wisp:<id>)`; the
// prompt box shows `@Title` and keeps the ids aside (mentions = [{ id, title }]). The server reads
// the same form (server/mentions.js).

export const MENTION = /@\[([^\]\n]{1,200})\]\(wisp:([a-z0-9]{6,40})\)/g;

// Titles go inside [...], so no ] or newlines.
export const cleanTitle = (t) => String(t || 'Untitled task').replace(/[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled task';

// Stored form → what the box shows, plus the mentions in it.
export function decode(text = '') {
  const mentions = [];
  const shown = String(text).replace(MENTION, (_, title, id) => {
    if (!mentions.some((m) => m.id === id)) mentions.push({ id, title });
    return `@${title}`;
  });
  return { text: shown, mentions };
}

// Where each mention sits in the shown text: every `@Title` of a known mention, longest titles
// first so one title that starts another doesn't steal it. Sorted, non-overlapping.
export function spans(text = '', mentions = []) {
  const out = [];
  for (const m of [...mentions].sort((a, b) => b.title.length - a.title.length)) {
    const needle = `@${m.title}`;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      const end = i + needle.length;
      if (!out.some((s) => i < s.end && end > s.start)) out.push({ start: i, end, id: m.id, title: m.title });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Shown text → stored form. A mention the user edited into something else is just text again.
export function encode(text = '', mentions = []) {
  let out = '';
  let at = 0;
  for (const s of spans(text, mentions)) {
    out += text.slice(at, s.start) + `@[${s.title}](wisp:${s.id})`;
    at = s.end;
  }
  return out + text.slice(at);
}

// For people: titles, no ids (card titles while a launch is pending).
export const plain = (text = '') => String(text).replace(MENTION, '@$1');

// Already-escaped HTML of a stored prompt → mentions as chips. link: chips open the task.
export const mentionHtml = (html, { link = true } = {}) =>
  html.replace(MENTION, (_, title, id) => (link ? `<a class="mn" href="#/s/${id}" title="Open this task">@${title}</a>` : `<span class="mn">@${title}</span>`));

// Pasted text that is only task references (ids, `wisp:<id>`, `#/s/<id>` links), each a task
// `known(id)` finds → those ids; anything else → null (pasted as ordinary text).
export function pastedTasks(text, known) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 10) return null;
  const ids = parts.map((p) => (p.match(/^(?:wisp:)?([a-f0-9]{12})$/) || p.match(/#\/s\/([a-z0-9]{6,40})\/?$/))?.[1]);
  return ids.every((id) => id && known(id)) ? [...new Set(ids)] : null;
}
