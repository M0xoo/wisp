// You, in the avatar's menu (v1 split.js meInfo/paintMe): the account this wisp is on a grid with, read from
// wisp.machines' rows (a grid peer that isn't another of your computers or a sandbox). Signed in: your name, handle
// and grid, and a click opens the grid's account page. Never signed in: "wisp Grid · Not connected · Sign in", and
// a click opens Settings → Cloud. Pure: the frame passes the rows in.

export interface PeerDoc {
  readonly id: string;
  readonly body?: { readonly transport?: string; readonly name?: string; readonly data?: Readonly<Record<string, unknown>> };
}
export interface StatusDoc {
  readonly id: string;
  readonly body?: { readonly id?: string; readonly state?: string };
}

export interface Me {
  /** the row's first line: your name, else your handle, else "wisp Grid" (key `shell.me.grid`) */
  readonly who: string;
  /** the row's second line: `handle · host`, or the host; '' when signed out (the frame says "Not connected · Sign in") */
  readonly sub: string;
  readonly state: 'on' | 'off' | 'out';
  readonly initial?: string;
  readonly avatar?: string;
  /** the grid's account page (signed in) */
  readonly href?: string;
  readonly handle?: string;
  readonly host?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function hostOf(g: string): string {
  try {
    return new URL(/^https?:/.test(g) ? g : `https://${g}`).host;
  } catch {
    return '';
  }
}

export function meOf(peers: readonly PeerDoc[], statuses: readonly StatusDoc[]): Me {
  const grid = peers.find((p) => {
    const t = p.body?.transport;
    const d = p.body?.data ?? {};
    return (t === 'grid' || t === 'grid-tunnel') && !d['computer'] && !d['sandbox'];
  });
  if (!grid) return { who: '', sub: '', state: 'out' };
  const d = grid.body?.data ?? {};
  const user = (typeof d['user'] === 'object' && d['user'] !== null ? d['user'] : {}) as Record<string, unknown>;
  const handle = str(user['handle']) || str(d['handle']);
  const name = str(user['name']);
  const avatar = str(user['avatar']);
  const host = hostOf(str(d['grid']) || str(d['url']));
  const online = statuses.find((s) => (s.body?.id ?? s.id) === grid.id)?.body?.state === 'online';
  const who = name || handle;
  return {
    who,
    sub: name && handle ? `${handle} · ${host}` : host,
    state: online ? 'on' : 'off',
    ...(who.trim() && { initial: who.trim().charAt(0).toUpperCase() }),
    ...(avatar && { avatar }),
    ...(host && { href: `https://${host}/account` }),
    ...(handle && { handle }),
    ...(host && { host }),
  };
}
