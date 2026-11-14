// Where a comment's words are in its block (v1 comments.js findRange), pure: the block's text nodes as strings in
// order, and the quote the selection gave. A selection and the text nodes disagree on whitespace (line breaks between
// paragraphs, a list's indent), so both are compared with every run of whitespace as one space. DOM-free.

/** A spot in the text nodes: the node's index and the offset in it. `to` is just past the last character. */
export interface Located {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

const WS = /\s/;

export function locate(texts: readonly string[], quote: string): Located | undefined {
  const want = quote.replace(/\s+/g, ' ').trim();
  if (!want) return undefined;
  const starts: number[] = [];
  let all = '';
  for (const t of texts) {
    starts.push(all.length);
    all += t;
  }
  // `flat` is `all` with whitespace runs as one space; `map[k]` is where flat's k-th character came from
  const map: number[] = [];
  let flat = '';
  for (let k = 0; k < all.length; k++) {
    const ch = all[k] ?? '';
    const ws = WS.test(ch);
    if (ws && WS.test(all[k - 1] ?? '')) continue;
    map.push(k);
    flat += ws ? ' ' : ch;
  }
  const at = flat.indexOf(want);
  if (at < 0) return undefined;
  const first = map[at] ?? 0;
  const last = map[at + want.length - 1] ?? 0;
  const node = (k: number): number => {
    let j = starts.length - 1;
    while (j > 0 && (starts[j] ?? 0) > k) j--;
    return j;
  };
  const a = node(first);
  const b = node(last);
  return { from: [a, first - (starts[a] ?? 0)], to: [b, last - (starts[b] ?? 0) + 1] };
}

/** What a selection gave, as a comment keeps it: trimmed, at most 600 characters (v1). Too short: nothing. */
export function quoteOf(text: string): string | undefined {
  const q = text.trim();
  if (q.length < 2) return undefined;
  return q.length > 600 ? `${q.slice(0, 599)}…` : q;
}
