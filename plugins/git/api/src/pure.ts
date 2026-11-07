// Pure helpers other plugins need without a git process: how a repo URL is spelled (projects, issues,
// clone), a branch slug, and which paths are generated. No I/O, no node: imports (api rule).

export interface ParsedRepo {
  url: string;
  host: string;
  name: string;
  /** owner/repo on GitHub, else null */
  gh: string | null;
  path: string;
}

const strip = (p: string): string => p.replace(/\/+$/, '').replace(/\.git$/i, '');

function of(url: string, host: string, repoPath: string): ParsedRepo | null {
  const parts = strip(repoPath).split('/').filter(Boolean);
  const last = parts.at(-1);
  if (last === undefined) return null;
  const gh = host === 'github.com' && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return { url, host, name: gh ? (parts[1] ?? last) : last, gh, path: parts.join('/') };
}

function fromUrl(s: string): ParsedRepo | null {
  let u: URL;
  try {
    u = new URL(/^\w+:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (u.protocol === 'file:') return of(u.href, '', decodeURIComponent(u.pathname));
  if (!host) return null;
  // A GitHub page inside the repo (/tree/main, /pull/3) still means the repo.
  if (host === 'github.com') {
    const [o, r] = u.pathname.split('/').filter(Boolean);
    return o && r ? of(`https://github.com/${o}/${strip(r)}.git`, host, `${o}/${r}`) : null;
  }
  return u.pathname.split('/').filter(Boolean).length >= 2 || u.protocol !== 'https:' ? of(s, host, u.pathname) : null;
}

/**
 * A repo the user pasted: https://github.com/o/r(/tree/…), github.com/o/r, git@host:o/r.git,
 * ssh:// git:// file:// URLs, and (shorthand) o/r for GitHub. Null when it's not a repo, e.g. a path.
 */
export function parseRepo(input: unknown, { shorthand = false }: { shorthand?: boolean } = {}): ParsedRepo | null {
  const s = String(input ?? '').trim();
  if (/^(https?|ssh|git|file):\/\//i.test(s) || /^(www\.)?github\.com\//i.test(s)) return fromUrl(s);
  let m = s.match(/^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/);
  if (m?.[1] && m[2]) return of(s, m[1].toLowerCase(), m[2]);
  m = shorthand ? s.match(/^([\w-]+)\/([\w.-]+)$/) : null;
  if (m?.[1] && m[2]) return of(`https://github.com/${m[1]}/${strip(m[2])}.git`, 'github.com', `${m[1]}/${m[2]}`);
  return null;
}

// An absolute path, as the file URL git would print for it (an origin can be a folder).
const fileUrl = (p: string): string => `file://${p.startsWith('/') ? '' : '/'}${encodeURI(p.replace(/\\/g, '/'))}`;
const absolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/** parseRepo, plus a plain path to a repo on disk. */
const repoOf = (u: unknown): ParsedRepo | null => parseRepo(u) ?? (absolute(String(u ?? '')) ? parseRepo(fileUrl(String(u))) : null);

/** One key per repo, however it was spelled (https vs ssh, .git or not, case of the host). */
export function repoKey(u: unknown): string | null {
  const r = repoOf(u);
  return r && (r.gh ? `github.com/${r.gh.toLowerCase()}` : `${r.host}/${r.path}`);
}

export const sameRepo = (a: unknown, b: unknown): boolean => {
  const k = repoKey(a);
  return !!k && k === repoKey(b);
};

/** A branch-name slug of a title: lowercase words joined by dashes, at most 32 characters. */
export const slug = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$|\.lock$|\.min\.(js|css)$|(^|\/)(dist|build)\//;
/** Lockfiles, minified bundles and build output: Changes folds them away. */
export const generatedPath = (p: unknown): boolean => GENERATED.test(String(p ?? ''));
