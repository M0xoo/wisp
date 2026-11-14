// A sent prompt's comments, read back (v1 web/js/comment-text.js readComments): the envelope a follow-up carries at
// its top (wisp.shell-task's withComments writes it) becomes the notes the turn draws as cards, and the rest is the
// prompt as typed. A prompt whose head isn't ours stays as it was typed. DOM-free.
//
//   <comments>
//   1. On "src/math.js", line 2:
//   >   return a + b;
//   Why plus?
//   </comments>
//
//   Also run the tests.

export interface SentNote {
  readonly n: number;
  /** a diff line's file:line ("src/math.js:2"), or the block it's on ("Diff · server/auth.js") */
  readonly label: string;
  readonly kind: 'line' | 'text' | 'point' | 'block';
  /** a removed line, numbered as before the change */
  readonly removed: boolean;
  readonly quote: string;
  readonly note: string;
}

const HEAD = /^(\d+)\. On "([^"\n]*)"(.*):$/;

export function readComments(prompt: string): { notes: SentNote[]; rest: string } {
  const m = /^<comments>\n([\s\S]*?)\n<\/comments>(?:\n+|$)/.exec(prompt);
  if (!m) return { notes: [], rest: prompt };
  const notes: SentNote[] = [];
  for (const chunk of (m[1] ?? '').split(/\n\n(?=\d+\. On ")/)) {
    const [head = '', ...lines] = chunk.split('\n');
    const h = HEAD.exec(head);
    if (!h) return { notes: [], rest: prompt }; // not ours after all: show it as it was typed
    let i = 0;
    const quote: string[] = [];
    // a blank line of code is a bare '>' once its trailing space is trimmed on the way
    while (i < lines.length && ((lines[i] ?? '').startsWith('> ') || lines[i] === '>')) quote.push((lines[i++] ?? '').slice(2));
    const place = h[3] ?? '';
    const note = lines.slice(i).join('\n').trim();
    const ln = /^, (removed )?lines? (\d+)(?:–(\d+))?(?: \(|$)/.exec(place);
    if (ln) {
      const from = Number(ln[2]);
      const to = Number(ln[3] ?? ln[2]);
      notes.push({ n: Number(h[1]), label: `${h[2]}:${from}${to !== from ? `–${to}` : ''}`, kind: 'line', removed: ln[1] !== undefined, quote: quote.join('\n'), note });
      continue;
    }
    const pt = /at (?:(\d+:\d\d), )?the spot (\d+)% across and (\d+)% down$/.test(place);
    notes.push({ n: Number(h[1]), label: h[2] ?? '', kind: quote.length ? 'text' : pt ? 'point' : 'block', removed: false, quote: quote.join('\n'), note });
  }
  return { notes, rest: prompt.slice(m[0].length) };
}

const KIND: Readonly<Record<string, string>> = {
  hero: 'Summary', markdown: 'Text', steps: 'Steps', stats: 'Numbers', files: 'Files', tree: 'Files', diff: 'Diff', code: 'Code',
  compare: 'Comparison', flow: 'Flow', chart: 'Chart', terminal: 'Terminal', tests: 'Tests', commits: 'Commits', graph: 'Branches',
  checklist: 'Checklist', callout: 'Callout', image: 'Image', video: 'Video', preview: 'Preview', map: 'Map', doc: 'Doc', task: 'Task', app: 'App',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "Diff · server/auth.js": what kind of block a comment is on and which one (v1 comment-text.js blockLabel): the words
 * the agent reads, so English as v1 sends them. A picture or video by its caption (wisp keeps its own copy, under a
 * name the agent never chose); no double quotes (the label sits in them), one line, at most 72 characters. */
export function blockLabel(b: { readonly type?: unknown; readonly [k: string]: unknown }): string {
  const type = str(b.type);
  const kind = KIND[type] ?? (type ? `${type[0]?.toUpperCase() ?? ''}${type.slice(1)}` : 'Answer');
  const media = (type === 'image' || type === 'video') && (str(b['caption']) || str(b['title']));
  const path = str(b['path']);
  const which = media || str(b['file']) || (path && (path.split('/').pop() ?? '')) || str(b['command']) || str(b['url']) || str(b['title']);
  const out = `${kind}${which ? ` · ${which}` : ''}`.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  return out.length > 72 ? `${out.slice(0, 71)}…` : out;
}
