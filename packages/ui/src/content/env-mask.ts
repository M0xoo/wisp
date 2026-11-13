// .env masking on screen (v1 server/env-mask.js, the transcript half; Changes' git rows are masked by wisp-git's
// core/mask.rs with the same rules). What a task shows of a `.env` / `.env.*` file reads `KEY=••••`: a step's output
// when it read one (`cat .env`), a code block about one, a diff block's before/after or unified diff. Reveal shows
// that one view as it is. It's for screens, screen shares and phones on a table, not a wall: the text is on the page.
// Pure: no DOM, no state.

export const DOTS = '••••';

/** `.env`, `.env.local`, `.env.production`…; not the templates people commit (`.env.example`, `.env.sample`). */
export function isEnvFile(file: unknown): boolean {
  const base = String(file ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  return /^\.env(\.[\w.-]+)?$/.test(base) && !/\.(example|sample)$/i.test(base);
}

// KEY=value, export KEY=value, KEY: value. The value goes (quotes and all), a trailing comment too. Any other line but
// a comment or a blank one goes whole: an edit's snippet can be a bare value, and a command's output can be anything.
const LINE = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*)(\S.*)$/;
const KEPT = /^\s*(#.*|(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*)?$/; // blank, a comment, KEY= with no value

export function maskLine(line: string): string {
  if (KEPT.test(line)) return line;
  const m = LINE.exec(line);
  return m ? `${m[1] ?? ''}${DOTS}` : line.replace(/^(\s*).*$/, `$1${DOTS}`);
}

export function maskText(text: string): string;
export function maskText(text: unknown): unknown;
export function maskText(text: unknown): unknown {
  return typeof text === 'string' ? text.split('\n').map(maskLine).join('\n') : text;
}

/** One edit's before/after masked on both sides. A line it changed that masks the same as a line it replaced says
 *  `(changed)`, so the diff still has a line to show. */
export function maskEdit<E extends { readonly before?: unknown; readonly after?: unknown }>(e: E): E {
  const was = String(e.before ?? '').split('\n');
  const raw = new Set(was);
  const masked = new Set(was.map(maskLine));
  const after =
    typeof e.after === 'string'
      ? e.after
          .split('\n')
          .map((l) => {
            const m = maskLine(l);
            return m !== l && !raw.has(l) && masked.has(m) ? `${m} (changed)` : m;
          })
          .join('\n')
      : e.after;
  return { ...e, before: maskText(e.before), after };
}

// A command line that names a .env file (cat .env, head -5 apps/web/.env.local, Get-Content .env).
const ENV_WORD = /(?:^|[\s'"`=(<>|;&/\\])(\.env(?:\.[\w.-]+)?)(?=$|[\s'"`)|;&>])/g;
export function namesEnvFile(cmd: unknown): boolean {
  for (const m of String(cmd ?? '').matchAll(ENV_WORD)) if (isEnvFile(m[1])) return true;
  return false;
}

/** A step whose output is a .env file's text: it read one, or its command names one. */
export const readsEnvFile = (a: { readonly file?: unknown; readonly detail?: unknown; readonly label?: unknown }): boolean =>
  isEnvFile(a.file) || namesEnvFile(a.detail) || namesEnvFile(a.label);

/** The .env file a command names (`cat apps/web/.env.local` → `.env.local`), or undefined. */
export function envFileNamed(cmd: unknown): string | undefined {
  for (const m of String(cmd ?? '').matchAll(ENV_WORD)) if (isEnvFile(m[1])) return m[1];
  return undefined;
}

const headPath = (rest: string): string | undefined => {
  const p = rest.split('\t')[0]?.trim() ?? '';
  return p === '/dev/null' ? undefined : p.replace(/^[ab]\//, '');
};

/**
 * A unified diff with a .env file's +/− lines masked; its headers and every other file's lines as they are. The file
 * comes from `diff --git`, `--- ` or `+++ ` (with or without `a/`/`b/`, `/dev/null` for an added or deleted one);
 * `whole`: a diff that names no file is the .env file's. Hunks are walked by their counts, so a changed line that
 * reads like a header (`---token=x`) is still masked.
 */
export function maskDiffs(text: string, whole = false): string {
  let env = whole;
  let old = 0;
  let neu = 0;
  return text
    .split('\n')
    .map((l) => {
      if (old > 0 || neu > 0) {
        const c = l[0] ?? ' ';
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          if (c !== '+' && c !== '\\') old--;
          if (c !== '-' && c !== '\\') neu--;
          return env && (c === '+' || c === '-') ? c + maskLine(l.slice(1)) : l;
        }
        old = 0;
        neu = 0;
      }
      // a bare snippet with no hunk header (`-K=old` / `+K=new`): every changed line is the file's
      if (whole && (l[0] === '+' || l[0] === '-')) return (l[0] ?? '') + maskLine(l.slice(1));
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
      if (hunk) {
        old = hunk[1] === undefined ? 1 : Number(hunk[1]);
        neu = hunk[2] === undefined ? 1 : Number(hunk[2]);
        return l;
      }
      const git = /^diff --git a\/.+ b\/(.+)$/.exec(l);
      if (git) env = isEnvFile(git[1]);
      else if (l.startsWith('--- ')) {
        const p = headPath(l.slice(4));
        env = p !== undefined && isEnvFile(p);
      } else if (l.startsWith('+++ ')) {
        const p = headPath(l.slice(4));
        if (p !== undefined) env = isEnvFile(p);
      }
      return l;
    })
    .join('\n');
}

/** A `diff` or `code` answer block about a .env file, masked; undefined when there's nothing to hide. */
export function maskBlock<B extends Readonly<Record<string, unknown>>>(b: B): B | undefined {
  if (!isEnvFile(b['file'] ?? b['path'])) return undefined;
  if (b['type'] === 'code') return typeof b['code'] === 'string' ? { ...b, code: maskText(b['code']) } : undefined;
  if (b['type'] !== 'diff') return undefined;
  const own = b['before'] !== undefined || b['after'] !== undefined;
  const diff = typeof b['diff'] === 'string' ? b['diff'] : undefined;
  if (!own && !diff) return undefined;
  // a hand-picked snippet's diff names no file: every line of it is the .env file's
  const masked: B = own ? maskEdit(b) : b;
  if (diff === undefined) return masked;
  return { ...masked, diff: maskDiffs(diff, !/^(diff --git |--- |\+\+\+ )/m.test(diff)) };
}
