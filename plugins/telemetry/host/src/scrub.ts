// Paths in messages and stacks would leak usernames and project names (v1 server/telemetry.js): wisp's
// own files keep their package-relative path, the home folder becomes ~, and any other absolute path is
// cut down to its file name.
import type { Json } from '@wisp/kernel';

export interface ScrubOptions {
  /** the user's home folder */
  home: string;
  /** wisp's own install folder */
  root: string;
}

export function scrub(text: unknown = '', { home, root }: ScrubOptions): string {
  let s = String(text);
  if (root) s = s.split(root).join('<wisp>');
  if (home) s = s.split(home).join('~');
  return s.replace(/(?<![\w<>~.:/\\-])(?:~|[A-Za-z]:)?[/\\](?:[^\s'"`():/\\]+[/\\])+([^\s'"`():/\\]*)/g, (_m, base: string) => `…/${base}`).slice(0, 500);
}

const FRAME = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** A stack as PostHog's raw frames, innermost last. */
export function frames(stack: unknown, o: ScrubOptions): Json[] {
  const out: Json[] = [];
  for (const line of String(stack ?? '').split('\n').slice(1, 30)) {
    const m = FRAME.exec(line.trim());
    if (!m) continue;
    const [, fn, file = '', ln = '0', col = '0'] = m;
    out.push({
      platform: 'custom',
      lang: 'javascript',
      function: fn || '?',
      filename: scrub(file.replace(/^file:\/\//, ''), o),
      lineno: Number(ln),
      colno: Number(col),
      in_app: !!o.root && file.includes(o.root) && !file.includes('node_modules'),
    });
  }
  return out.reverse();
}
