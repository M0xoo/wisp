// Inline Markdown: code spans, emphasis, strike, links, autolinks, bare URLs, escapes, breaks.
import { safeHref, type Inline } from './ast.ts';

interface Step {
  readonly node: Inline | readonly Inline[];
  readonly end: number;
}

const PUNCT = /[!-/:-@[-`{-~]/;
// Characters that may start a token; text between them is taken in one slice. Sticky state is
// safe: lastIndex is set right before each exec.
const SPECIAL = /[\\`<[!*_~hH\n]/g;
const WORD = /[\p{L}\p{N}]/u;

/** Appends, merging neighbouring text so the tree stays small. */
function push(out: Inline[], node: Inline | readonly Inline[]): void {
  if (Array.isArray(node)) {
    for (const n of node as readonly Inline[]) push(out, n);
    return;
  }
  const n = node as Inline;
  const last = out[out.length - 1];
  if (n.t === 'text' && last?.t === 'text') out[out.length - 1] = { t: 'text', v: last.v + n.v };
  else out.push(n);
}

const text = (v: string): Inline => ({ t: 'text', v });

function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/** Index just past the code span opening at `i`, or -1 if its backticks never close. */
function codeSpanEnd(s: string, i: number): number {
  const n = runLength(s, i, '`');
  for (let j = s.indexOf('`', i + n); j !== -1; j = s.indexOf('`', j)) {
    const m = runLength(s, j, '`');
    if (m === n) return j + n;
    j += m;
  }
  return -1;
}

function codeSpan(s: string, i: number): Step {
  const n = runLength(s, i, '`');
  const end = codeSpanEnd(s, i);
  // An unmatched run of backticks is literal text.
  if (end < 0) return { node: text('`'.repeat(n)), end: i + n };
  let v = s.slice(i + n, end - n).replace(/\n/g, ' ');
  if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
  return { node: { t: 'code', v }, end };
}

/** Where `delim` closes the span opened before `from`, skipping escapes and code spans. */
function findCloser(s: string, from: number, delim: string): number {
  const ch = delim[0] ?? '';
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '`') {
      const end = codeSpanEnd(s, j);
      if (end > 0) j = end - 1;
      continue;
    }
    if (s[j] !== ch || j === from || /\s/.test(s[j - 1] ?? '')) continue;
    const run = runLength(s, j, ch);
    if (run !== delim.length && !(run > delim.length && delim.length === 3)) {
      // A shorter or longer run belongs to another span (`*a **b** c*`): step over it.
      j += run - 1;
      continue;
    }
    // `snake_case_names`: an underscore inside a word never closes.
    if (ch === '_' && WORD.test(s[j + delim.length] ?? '')) continue;
    return j;
  }
  return -1;
}

function emphasis(s: string, i: number, links: boolean): Step | undefined {
  const ch = s[i] ?? '';
  const run = Math.min(runLength(s, i, ch), 3);
  if (ch === '~' && run < 2) return undefined;
  const n = ch === '~' ? 2 : run;
  if (ch === '_' && i > 0 && WORD.test(s[i - 1] ?? '')) return { node: text(ch.repeat(runLength(s, i, ch))), end: i + runLength(s, i, ch) };
  const after = s[i + n];
  const literal: Step = { node: text(ch.repeat(n)), end: i + n };
  if (after === undefined || /\s/.test(after)) return literal;
  const close = findCloser(s, i + n, ch.repeat(n));
  if (close < 0) return literal;
  const inner = parseInline(s.slice(i + n, close), links);
  const node: Inline =
    ch === '~' ? { t: 'del', c: inner } : n === 1 ? { t: 'em', c: inner } : n === 2 ? { t: 'strong', c: inner } : { t: 'strong', c: [{ t: 'em', c: inner }] };
  return { node, end: close + n };
}

/** Index of the `]` matching the `[` at `i`, or -1. */
function matchBracket(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '`') {
      const end = codeSpanEnd(s, j);
      if (end > 0) j = end - 1;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

interface Destination {
  readonly href: string;
  readonly title: string | null;
  readonly end: number;
}

/** `(url "title")` starting just after the `(`. */
function destination(s: string, start: number): Destination | undefined {
  let j = start;
  while (s[j] === ' ') j++;
  let href = '';
  if (s[j] === '<') {
    const close = s.indexOf('>', j);
    if (close < 0) return undefined;
    href = s.slice(j + 1, close);
    j = close + 1;
  } else {
    let depth = 0;
    const from = j;
    for (; j < s.length && !/\s/.test(s[j] ?? ''); j++) {
      if (s[j] === '(') depth++;
      if (s[j] === ')' && depth-- === 0) break;
    }
    href = s.slice(from, j);
  }
  while (s[j] === ' ') j++;
  let title: string | null = null;
  const q = s[j];
  if (q === '"' || q === "'") {
    const close = s.indexOf(q, j + 1);
    if (close < 0) return undefined;
    title = s.slice(j + 1, close);
    j = close + 1;
    while (s[j] === ' ') j++;
  }
  return s[j] === ')' ? { href, title, end: j + 1 } : undefined;
}

function link(s: string, i: number, links: boolean): Step | undefined {
  if (!links) return undefined;
  const close = matchBracket(s, i);
  if (close < 0 || s[close + 1] !== '(') return undefined;
  const dest = destination(s, close + 2);
  if (!dest) return undefined;
  // A link's text can't hold another link: nested anchors are invalid HTML.
  const children = parseInline(s.slice(i + 1, close), false);
  const href = safeHref(dest.href);
  return { node: href === undefined ? children : { t: 'link', href, title: dest.title, c: children }, end: dest.end };
}

function autolink(s: string, i: number, links: boolean): Step | undefined {
  const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(s.slice(i, i + 2048));
  if (!m || !links) return undefined;
  const raw = m[1] ?? '';
  const href = safeHref(raw.includes(':') ? raw : `mailto:${raw}`);
  return { node: href === undefined ? text(m[0]) : { t: 'link', href, title: null, c: [text(raw)] }, end: i + m[0].length };
}

function bareUrl(s: string, i: number, links: boolean): Step | undefined {
  if (!links || (i > 0 && WORD.test(s[i - 1] ?? ''))) return undefined;
  const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i, i + 2048));
  if (!m) return undefined;
  let url = m[0];
  // Trailing punctuation ends the sentence, not the URL; a `)` stays only if it closes a `(`.
  for (;;) {
    const last = url[url.length - 1] ?? '';
    if (/[.,:;!?*_~'"]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    else break;
  }
  return { node: { t: 'link', href: url, title: null, c: [text(url)] }, end: i + url.length };
}

function escape(s: string, i: number): Step | undefined {
  const next = s[i + 1];
  if (next === '\n') return { node: { t: 'br' }, end: i + 2 };
  if (next !== undefined && PUNCT.test(next)) return { node: text(next), end: i + 2 };
  return undefined;
}

function token(s: string, i: number, links: boolean): Step | undefined {
  switch (s[i]) {
    case '\\': return escape(s, i);
    case '`': return codeSpan(s, i);
    case '<': return autolink(s, i, links);
    case '[': return link(s, i, links);
    // An image becomes a link to it: the kit shows no remote images from text.
    case '!': return s[i + 1] === '[' ? link(s, i + 1, links) : undefined;
    case '*': case '_': case '~': return emphasis(s, i, links);
    case 'h': case 'H': return bareUrl(s, i, links);
    default: return undefined;
  }
}

/** Parses one paragraph's (or cell's) text. `links: false` inside link text. */
export function parseInline(s: string, links = true): Inline[] {
  const out: Inline[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\n') {
      // Two trailing spaces make a hard break; otherwise the newline is a space.
      const last = out[out.length - 1];
      const hard = last?.t === 'text' && / {2,}$/.test(last.v);
      if (last?.t === 'text') out[out.length - 1] = text(last.v.replace(/ +$/, ''));
      push(out, hard ? { t: 'br' } : text('\n'));
      i++;
      continue;
    }
    const step = token(s, i, links);
    if (step) {
      push(out, step.node);
      i = step.end;
    } else {
      SPECIAL.lastIndex = i + 1;
      const next = SPECIAL.exec(s)?.index ?? s.length;
      push(out, text(s.slice(i, next)));
      i = next;
    }
  }
  return out;
}
