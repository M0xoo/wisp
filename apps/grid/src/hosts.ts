// The edge's routing table (plan §7.2.5): which part of the grid a Host header is for. One process,
// many kinds of address, all on the grid's one port:
//
//   <domain>                     the grid itself: sign in, your account, the device API
//   <handle>.<domain>            the edge: that user's own wisp, started on demand by hostd and
//                                proxied (HTTP + SSE) in trusted-proxy mode
//   <name>--<handle>.<domain>    a computer the user added, through the tunnel it holds open
//   p<port>--<handle>.<domain>   a page the agent left running in that user's box (boxes only:
//                                hostd.previews; a process wisp's loopback is the grid's own)
//   p<port>--<name>--<handle>    the same for a computer, through its tunnel
//   sb-<id>--<handle>.<domain>   a sandbox: a box of its own for one task; p<port>--sb-… its pages
//   <slug>--app--<handle>        an app published from My Stuff, served by the grid itself
//
// and on them, by path: <handle>/_in/<token> (a channel's webhook, held for the box), <domain>/_mail/
// <provider> (the mail provider's webhook), <domain>/_route/<token> (a bot the grid owns, for `on
// laptop`), and /_grid/* (the edge's own: auth, signout, keys, preview, state, stop, tls-ask, a).
//
// Cookies never span subdomains, so one user's wisp page can't read or set another's.
// The order of LABELS is the order labels are tried: the first that matches decides.

import type { ComputerRow, SandboxRow, SiteRow } from './rows.ts';

export const SITE_LABEL = /^([a-z0-9-]+)--app--([a-z0-9-]+)$/;
export const SANDBOX_LABEL = /^sb-([a-f0-9]{8})--([a-z0-9-]+)$/;
export const PREVIEW_LABEL = /^p(\d{1,5})--([a-z0-9-]+)$/;
export const HANDLE_LABEL = /^[a-z0-9-]+$/;

export type HostKind =
  | { kind: 'root' }
  | { kind: 'site'; site: SiteRow | undefined }
  | { kind: 'sandbox'; sandbox: SandboxRow }
  | { kind: 'computer'; computer: ComputerRow }
  | { kind: 'preview'; port: number; label: string; sandbox: SandboxRow }
  | { kind: 'preview'; port: number; label: string; computer: ComputerRow }
  | { kind: 'preview'; port: number; label: string; handle: string }
  | { kind: 'edge'; handle: string }
  | { kind: 'unknown' };

export type PreviewKind = Extract<HostKind, { kind: 'preview' }>;

/** What the resolver may look up: the rows a label names. */
export interface HostLookups {
  domain: string;
  /** the grid's own Host values: <domain>, with its public port suffix, with its listen port */
  rootHosts: ReadonlySet<string>;
  /** pages in boxes (hostd.previews; on by default for containers) */
  previews: boolean;
  site(label: string): SiteRow | undefined;
  sandbox(label: string): SandboxRow | undefined;
  computer(label: string): ComputerRow | undefined;
}

export interface LabelRule {
  kind: HostKind['kind'];
  pattern: string;
  note: string;
}

/** The table, for people and tests: what hostKind does, in order. */
export const LABELS: readonly LabelRule[] = [
  { kind: 'root', pattern: '<domain>[:port]', note: 'the grid itself, by its exact Host' },
  { kind: 'site', pattern: '<slug>--app--<handle>', note: 'a published app; an unknown one is still a site (404 page), never an edge' },
  { kind: 'sandbox', pattern: 'sb-<8 hex>--<handle>', note: 'a sandbox that exists; otherwise read on' },
  { kind: 'computer', pattern: '<name>--<handle>', note: 'a computer that exists (a label with "--")' },
  { kind: 'preview', pattern: 'p<1-65535>--sb-<id>--<handle>', note: 'a sandbox’s page, only with previews on' },
  { kind: 'preview', pattern: 'p<1-65535>--<name>--<handle>', note: 'a computer’s page: the computer decides whether it shows' },
  { kind: 'preview', pattern: 'p<1-65535>--<handle>', note: 'a box’s page, only with previews on' },
  { kind: 'edge', pattern: '<handle>', note: 'any other label of a-z, 0-9 and "-": a user’s wisp (unknown handles answer 404 there)' },
  { kind: 'unknown', pattern: '*', note: 'another domain, or a label with other characters: 421' },
];

function preview(label: string, look: HostLookups): PreviewKind | null {
  const pv = PREVIEW_LABEL.exec(label);
  const port = Number(pv?.[1]);
  const rest = pv?.[2];
  if (!rest || !(port >= 1 && port <= 65535)) return null;
  const sb = SANDBOX_LABEL.test(rest) ? look.sandbox(rest) : undefined;
  if (sb && look.previews) return { kind: 'preview', port, label: rest, sandbox: sb };
  const c = rest.includes('--') ? look.computer(rest) : undefined;
  if (c) return { kind: 'preview', port, label: rest, computer: c };
  if (look.previews && !rest.includes('--')) return { kind: 'preview', port, label: rest, handle: rest };
  return null;
}

/** Which part of the grid a Host header is for. Pure but for the lookups it is given. */
export function hostKind(rawHost: unknown, look: HostLookups): HostKind {
  const host = String(rawHost || '').toLowerCase();
  if (look.rootHosts.has(host)) return { kind: 'root' };
  const bare = host.replace(/:\d+$/, '');
  if (!bare.endsWith(`.${look.domain}`)) return { kind: 'unknown' };
  const label = bare.slice(0, -look.domain.length - 1);
  if (SITE_LABEL.test(label)) return { kind: 'site', site: look.site(label) };
  const sandbox = SANDBOX_LABEL.test(label) ? look.sandbox(label) : undefined;
  if (sandbox) return { kind: 'sandbox', sandbox };
  const computer = label.includes('--') ? look.computer(label) : undefined;
  if (computer) return { kind: 'computer', computer };
  const pv = preview(label, look);
  if (pv) return pv;
  if (HANDLE_LABEL.test(label)) return { kind: 'edge', handle: label };
  return { kind: 'unknown' };
}

/** The grid's own Host values for a config. */
export function rootHosts(cfg: { domain: string; portSuffix: string; listen: { port: number } }): Set<string> {
  return new Set([cfg.domain, `${cfg.domain}${cfg.portSuffix}`, `${cfg.domain}:${cfg.listen.port}`]);
}

// --- paths that belong to the edge itself, on any address ------------------------------------------

/** A channel's webhook at <handle>/_in/<token> (inbox.ts). */
export const IN_PREFIX = '/_in';
/** A bot the grid owns, at <domain>/_route/<token> (route.ts). */
export const ROUTE_PREFIX = '/_route';
export const ASSET_PATH = /^\/_grid\/a\/([a-z0-9-]+)\.(webp|svg|png)$/;
export const TLS_ASK = '/_grid/tls-ask';
export const isUnder = (p: string, prefix: string): boolean => p === prefix || p.startsWith(`${prefix}/`);

/**
 * Caddy's on-demand TLS check: only the grid itself and names that exist. `look` answers for the
 * label alone (a handle, a site, a computer, a sandbox, or a preview of one).
 */
export function tlsAllowed(domain: string, ask: string, look: HostLookups & { handle(label: string): boolean }): boolean {
  const d = ask.toLowerCase();
  if (d === domain) return true;
  if (!d.endsWith(`.${domain}`)) return false;
  const label = d.slice(0, -domain.length - 1);
  if (look.handle(label) || look.site(label) || look.computer(label) || look.sandbox(label)) return true;
  const pv = /^p\d{1,5}--([a-z0-9-]+)$/.exec(label)?.[1];
  if (!pv) return false;
  return (look.previews && (look.handle(pv) || !!look.sandbox(pv))) || !!look.computer(pv);
}
