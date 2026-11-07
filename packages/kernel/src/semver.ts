// A tiny semver: exact versions and the ranges manifests use (`^1`, `~1.2`, `>=1.2.0 <2`, `1.x`, `*`,
// `a || b`). npm's rules for 0.x carets and for pre-releases; nothing else.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: readonly (string | number)[];
}

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// a partial version in a range: '1', '1.2', '1.x', '1.2.*'
const PARTIAL = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(v: string): SemVer | undefined {
  const m = VERSION.exec(v.trim());
  if (!m) return undefined;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

export const validVersion = (v: unknown): v is string => typeof v === 'string' && parseVersion(v) !== undefined;

export function majorOf(v: string): number | undefined {
  return parseVersion(v)?.major;
}

function comparePre(a: SemVer['pre'], b: SemVer['pre']): number {
  if (!a.length || !b.length) return b.length - a.length; // a release sorts after its pre-releases
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compare(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

type Op = '>=' | '<' | '>' | '<=' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}

const v3 = (major: number, minor: number, patch: number, pre: SemVer['pre'] = []): SemVer => ({ major, minor, patch, pre });
const wild = (s: string | undefined): boolean => s === undefined || s === 'x' || s === '*';

/** One term of a range ('^1.2', '>=1', '1.x') as comparators, or undefined when it doesn't parse. */
function term(t: string): Comparator[] | undefined {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(t);
  const op = m?.[1] ?? '';
  const p = PARTIAL.exec(m?.[2] ?? '');
  if (!p) return undefined;
  const [, ma, mi, pa, preS] = p;
  if (wild(ma)) return op === '<' || op === '>' ? [{ op: '<', v: v3(0, 0, 0) }] : [];
  const pre = preS ? (parseVersion(`0.0.0-${preS}`)?.pre ?? []) : [];
  const M = Number(ma);
  const n = Number(mi);
  const pt = Number(pa);
  const full = !wild(mi) && !wild(pa);
  const low = v3(M, wild(mi) ? 0 : n, wild(pa) ? 0 : pt, pre);
  // the first version past this partial: '1' → 2.0.0, '1.2' → 1.3.0
  const next = wild(mi) ? v3(M + 1, 0, 0) : wild(pa) ? v3(M, n + 1, 0) : v3(M, n, pt + 1);
  switch (op) {
    case '^': {
      const up = M > 0 || wild(mi) ? v3(M + 1, 0, 0) : n > 0 || wild(pa) ? v3(0, n + 1, 0) : v3(0, 0, pt + 1);
      return [{ op: '>=', v: low }, { op: '<', v: up }];
    }
    case '~':
      return [{ op: '>=', v: low }, { op: '<', v: wild(mi) ? v3(M + 1, 0, 0) : v3(M, n + 1, 0) }];
    case '>=':
      return [{ op: '>=', v: low }];
    case '<':
      return [{ op: '<', v: low }];
    case '>':
      return [full ? { op: '>', v: low } : { op: '>=', v: next }];
    case '<=':
      return [full ? { op: '<=', v: low } : { op: '<', v: next }];
    default:
      return full ? [{ op: '=', v: low }] : [{ op: '>=', v: low }, { op: '<', v: next }];
  }
}

function test(c: Comparator, v: SemVer): boolean {
  const d = compare(v, c.v);
  return c.op === '>=' ? d >= 0 : c.op === '<' ? d < 0 : c.op === '>' ? d > 0 : c.op === '<=' ? d <= 0 : d === 0;
}

/** A range as OR-sets of AND-ed comparators, or undefined when it doesn't parse. */
export function parseRange(range: string): Comparator[][] | undefined {
  const sets: Comparator[][] = [];
  for (const alt of range.split('||')) {
    // '>= 1.2' is one term: glue an operator to the version after it
    const terms = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const set: Comparator[] = [];
    for (const t of terms.length ? terms : ['*']) {
      const cs = term(t);
      if (!cs) return undefined;
      set.push(...cs);
    }
    sets.push(set);
  }
  return sets;
}

export const validRange = (r: unknown): r is string => typeof r === 'string' && r.trim() !== '' && parseRange(r) !== undefined;

/**
 * Does `version` satisfy `range`? A pre-release only matches a set whose comparators name a
 * pre-release of the same major.minor.patch (npm's rule), so `^1` never picks `2.0.0-beta`.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const sets = parseRange(range);
  if (!v || !sets) return false;
  return sets.some((set) => {
    if (!set.every((c) => test(c, v))) return false;
    if (!v.pre.length) return true;
    return set.some((c) => c.v.pre.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
  });
}
