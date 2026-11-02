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
//
//   3. On "server/auth.js", lines 40–41:
//   > if (!user) return
//   > const ttl = 60
//   Why not 401?
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

// A line or lines of a diff (the side panel's Changes), named by the file as it is now. Lines only
// removed have only their old numbers, and say so; a range that mixes them marks each line + or -.
const span = (c) => `line${c.to !== c.from ? `s ${c.from}–${c.to}` : ` ${c.from}`}`;
function lineWhere(c) {
  if (c.side === 'old') return `, removed ${span(c)} (numbered as before the change)`;
  return `, ${span(c)}${c.mixed ? ' (removed lines marked -, added +)' : ''}`;
}

const MAX_LINES = 40; // a longer range is cut: its numbers say the rest
// A comment on diff rows ({ op: '+' | '-' | ' ', text, a: old number, b: new number }, in order),
// without its note: what the tray, the marks and the text need.
export function lineComment(file, rows) {
  const old = rows.every((r) => r.op === '-');
  const nums = old ? rows.map((r) => r.a) : rows.filter((r) => r.op !== '-').map((r) => r.b);
  const from = nums[0];
  const to = nums.at(-1);
  const mixed = !old && rows.some((r) => r.op === '-');
  let lines = rows.map((r) => (mixed ? `${r.op} ${r.text}` : r.text));
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES - 1), '…'];
  return { kind: 'line', file, side: old ? 'old' : 'new', from, to, mixed, quote: lines.join('\n'), label: lineLabel(file, from, to) };
}
export const lineLabel = (file, from, to) => `${file}:${from}${to !== from ? `–${to}` : ''}`;

// Where in the block, after its label: the words the agent reads.
function where(c) {
  if (c.kind === 'line') return lineWhere(c);
  const of = c.of ? ` in your answer to "${clip(c.of.replace(/"/g, "'").replace(/\s+/g, ' '), 48)}"` : '';
  if (c.kind === 'text') return `${of}, where it says`;
  if (c.kind === 'point') return `${of}, at ${c.at != null ? `${fmtTime(c.at)}, ` : ''}the spot ${Math.round(c.x)}% across and ${Math.round(c.y)}% down`;
  return of;
}

// c: { label, kind: 'text' | 'point' | 'block' | 'line', quote, x, y, at (a video's second), note, of
// (the prompt of an earlier answer; unset for the latest); a line's: file, side, from, to, mixed }.
export function withComments(list, text = '') {
  if (!list?.length) return text;
  const items = list.map((c, i) => {
    const label = c.kind === 'line' ? String(c.file).replace(/"/g, "'").replace(/\s+/g, ' ') : c.label;
    const lines = [`${i + 1}. On "${label}"${where(c)}:`];
    if ((c.kind === 'text' || c.kind === 'line') && c.quote) lines.push(...c.quote.split('\n').map((l) => `> ${l}`));
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
    // A blank line of code is a bare '>' once its trailing space is trimmed on the way.
    while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) quote.push(lines[i++].slice(2));
    const place = h[3];
    const ln = /^, (removed )?lines? (\d+)(?:–(\d+))?(?: \(|$)/.exec(place);
    if (ln) {
      const [from, to] = [Number(ln[2]), Number(ln[3] || ln[2])];
      notes.push({ n: Number(h[1]), label: lineLabel(h[2], from, to), file: h[2], kind: 'line', side: ln[1] ? 'old' : 'new', from, to, quote: quote.join('\n'), at: '', x: null, y: null, earlier: false, note: lines.slice(i).join('\n').trim() });
      continue;
    }
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
