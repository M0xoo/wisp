// My shares (ADR-0038 "My shares", F-share-3), DOM-free: what `grid-client.shares` lists (the grid's own view of
// each share), as rows: the live ones first, newest first, each with what it is, who may open it, and its counts.

export interface Share {
  readonly id: string;
  readonly url: string;
  readonly kind: string;
  readonly title: string;
  readonly version?: number;
  readonly access?: { readonly kind?: string; readonly people?: readonly string[]; readonly teams?: readonly string[] };
  readonly expiresAt?: number | null;
  readonly revoked?: boolean;
  readonly views?: number;
  readonly imports?: number;
  readonly updatedAt?: number;
}

type T = (k: string, vars?: Readonly<Record<string, string | number>>) => string;

/** The grid's answer (an array, or `{shares}`) as shares; anything else is none. */
export function sharesOf(v: unknown): Share[] {
  const list = Array.isArray(v) ? v : Array.isArray((v as { shares?: unknown } | null)?.shares) ? (v as { shares: unknown[] }).shares : [];
  return list.filter((s): s is Share => !!s && typeof s === 'object' && typeof (s as Share).id === 'string' && typeof (s as Share).url === 'string');
}

/** Live ones first (not revoked, not expired at `now`), newest first within each. */
export function ordered(list: readonly Share[], now: number): Share[] {
  const live = (s: Share): boolean => !s.revoked && !(s.expiresAt && s.expiresAt <= now);
  return [...list].sort((a, b) => Number(live(b)) - Number(live(a)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** The line under a share's title: kind · who may open it · views · imports · version, or why it's gone. */
export function shareLine(s: Share, now: number, t: T): string {
  if (s.revoked) return t('grid-client.shares.revoked');
  if (s.expiresAt && s.expiresAt <= now) return t('grid-client.shares.expired');
  const kind = s.access?.kind ?? 'anyone';
  const who =
    kind === 'people'
      ? t('grid-client.shares.access.people', { count: s.access?.people?.length ?? 0 })
      : kind === 'teams'
        ? t('grid-client.shares.access.teams', { count: s.access?.teams?.length ?? 0 })
        : t(`grid-client.shares.access.${kind === 'password' ? 'password' : 'anyone'}`);
  return [
    t(`grid-client.shares.kind.${['task', 'setup', 'stuff', 'app', 'plugin', 'report'].includes(s.kind) ? s.kind : 'other'}`),
    who,
    t('grid-client.shares.views', { count: s.views ?? 0 }),
    t('grid-client.shares.imports', { count: s.imports ?? 0 }),
    s.version ? `v${s.version}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
