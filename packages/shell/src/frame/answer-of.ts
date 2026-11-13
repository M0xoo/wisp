// What an answer reads off its task and turn (answer-ctx.ts): a named file's URL and what a turn's refusals allow.
// Plain, so their tests needn't compile the slot and the kit that answer-ctx.ts reaches.

/** A picture or video an answer named → a URL the page loads (v1 ctx.fileUrl): a link stays; a file comes from the
 *  task's own computer, this wisp's or another through it (`/api/peer/<machine>`). */
export function mediaUrl(home: string, key: string, path: string): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const peer = key.slice(0, key.indexOf(':'));
  const base = peer && peer !== home ? `/api/peer/${encodeURIComponent(peer)}` : '';
  return `${base}/api/sessions/${encodeURIComponent(key.slice(key.indexOf(':') + 1))}/file?path=${encodeURIComponent(path)}`;
}

/** What a turn's refusals allow (v1 #777): the server keeps them (`ext['wisp.runtime'].blocked`) only for a run that
 *  wasn't in Full auto; a Full auto run that its harness still refused can't be retried, and a card from before
 *  has nothing to allow. */
export function blockedOf(turn: unknown): 'allowable' | 'unallowed' | 'none' {
  const o = (turn ?? {}) as { readonly ext?: Readonly<Record<string, unknown>>; readonly mode?: unknown };
  const kept = (o.ext?.['wisp.runtime'] as { readonly blocked?: unknown } | undefined)?.blocked;
  if (Array.isArray(kept) && kept.length > 0) return 'allowable';
  return o.mode === 'auto' ? 'unallowed' : 'none';
}
