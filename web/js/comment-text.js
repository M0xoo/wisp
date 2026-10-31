// Comments on an answer, as text: how they go out at the top of a follow-up (what the agent reads)
// and how the page reads them back out of a sent prompt to draw them as cards. DOM-free.
//
//   <comments>
//   1. On "Diff · server/auth.js", where it says:
//   > const ttl = 60
//   Make this configurable.
//
//   2. On "Image · after.png", at the spot 42% across and 61% down:
//   The button is cut off here.
//   </comments>
//
//   Also run the tests.

const KIND = {
  hero: 'Summary', markdown: 'Text', steps: 'Steps', stats: 'Numbers', files: 'Files', tree: 'Files', diff: 'Diff', code: 'Code',
  compare: 'Comparison', flow: 'Flow', chart: 'Chart', terminal: 'Terminal', tests: 'Tests', commits: 'Commits', graph: 'Branches',
  checklist: 'Checklist', callout: 'Callout', image: 'Image', video: 'Video', preview: 'Preview', map: 'Map', doc: 'Doc', task: 'Task', app: 'App',
};

const base = (p) => String(p).split('/').pop();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// "Diff · server/auth.js": what kind of block it is and which one, to say where a comment is.
export function blockLabel(b = {}) {
  const kind = KIND[b.type] || (b.type ? b.type[0].toUpperCase() + b.type.slice(1) : 'Answer');
  // A picture or video by its caption: wisp keeps its own copy, under a name the agent never chose.
  const media = (b.type === 'image' || b.type === 'video') && (b.caption || b.title);
  const which = media || b.file || (b.path && base(b.path)) || b.command || b.url || b.title || '';
  // The label sits in double quotes in the text: none inside it, and one line.
  return clip(`${kind}${which ? ` · ${which}` : ''}`.replace(/"/g, "'").replace(/\s+/g, ' ').trim(), 72);
}

export const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Where in the block, after its label: the words the agent reads.
function where(c) {
  const of = c.of ? ` in your answer to "${clip(c.of.replace(/"/g, "'").replace(/\s+/g, ' '), 48)}"` : '';
  if (c.kind === 'text') return `${of}, where it says`;
  if (c.kind === 'point') return `${of}, at ${c.at != null ? `${fmtTime(c.at)}, ` : ''}the spot ${Math.round(c.x)}% across and ${Math.round(c.y)}% down`;
  return of;
}

// c: { label, kind: 'text' | 'point' | 'block', quote, x, y, at (a video's second), note, of (the
// prompt of an earlier answer; unset for the latest) }.
export function withComments(list, text = '') {
  if (!list?.length) return text;
  const items = list.map((c, i) => {
    const lines = [`${i + 1}. On "${c.label}"${where(c)}:`];
    if (c.kind === 'text' && c.quote) lines.push(...c.quote.split('\n').map((l) => `> ${l}`));
    if (c.note?.trim()) lines.push(c.note.trim());
    return lines.join('\n');
  });
  return `<comments>\n${items.join('\n\n')}\n</comments>${text.trim() ? `\n\n${text.trim()}` : ''}`;
}

const HEAD = /^(\d+)\. On "([^"\n]*)"(.*):$/;

// A sent prompt back into { notes, rest }; notes is empty for a prompt without comments.
export function readComments(prompt = '') {
  const m = /^<comments>\n([\s\S]*?)\n<\/comments>(?:\n+|$)/.exec(prompt);
  if (!m) return { notes: [], rest: prompt };
  const notes = [];
  for (const chunk of m[1].split(/\n\n(?=\d+\. On ")/)) {
    const [head, ...lines] = chunk.split('\n');
    const h = HEAD.exec(head);
    if (!h) return { notes: [], rest: prompt }; // not ours after all: show it as it was typed
    let i = 0;
    const quote = [];
    while (i < lines.length && lines[i].startsWith('> ')) quote.push(lines[i++].slice(2));
    const place = h[3];
    const pt = /at (?:(\d+:\d\d), )?the spot (\d+)% across and (\d+)% down$/.exec(place);
    notes.push({
      n: Number(h[1]),
      label: h[2],
      kind: quote.length ? 'text' : pt ? 'point' : 'block',
      quote: quote.join('\n'),
      at: pt?.[1] || '',
      x: pt ? Number(pt[2]) : null,
      y: pt ? Number(pt[3]) : null,
      earlier: / in your answer to "/.test(place),
      note: lines.slice(i).join('\n').trim(),
    });
  }
  return { notes, rest: prompt.slice(m[0].length) };
}
