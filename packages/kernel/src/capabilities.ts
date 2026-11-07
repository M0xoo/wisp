// Capability sets (plan §6.5, §7.2.4): who may do what, as data. A call speaks for one set; the
// command's permission is checked against it at the boundary. Everything not allowed is denied, and a
// deny always beats an allow, with the reason the caller reads.
//
// `agent:capped` is v1's server/capped.js and the refusals in routes/control.js, internal.js and
// connectors.js, as a list: each deny keeps v1's wording, so an agent reads what it read before.
import type { DeepReadonly, Manifest } from './contract.ts';
import { ownerPrefix } from './ids.ts';
import { covers, parsePermission } from './permissions.ts';

export interface Deny {
  permission: string;
  /** what the caller reads, finishing "…, so it can't <why>" for capped sets */
  why: string;
}

export interface CapabilitySet {
  id: string;
  allow: readonly string[];
  deny?: readonly Deny[];
}

export type Mode = 'plan' | 'edits' | 'auto';
export const MODE_RANK: Readonly<Record<Mode, number>> = { plan: 0, edits: 1, auto: 2 };
export const MODE_LABEL: Readonly<Record<Mode, string>> = { plan: 'Plan', edits: 'Edits', auto: 'Full auto' };
const MODES: readonly Mode[] = ['plan', 'edits', 'auto'];

/** v1's cappedRefusal text, word for word. */
export const cappedRefusal = (what: string): string =>
  `Refused: this task was started from a channel with a mode cap, so it can't ${what}. Say so in your report; the user can do it in wisp.`;

export const USER_FULL: CapabilitySet = { id: 'user:full', allow: ['*'] };

/** A task's agent, speaking through its session's MCP token. */
export const AGENT_SESSION: CapabilitySet = {
  id: 'agent:session',
  allow: [
    'runtime:*', 'session:*', 'stuff:*', 'crew:*', 'git:*', 'fs:*', 'topic:read', 'ask:*', 'later:*', 'goal:*',
    'connectors:*', 'machines:*', 'sandbox:*', 'prs:*', 'notice:send', 'plugins:read', 'blob:*', 'budget:read',
  ],
  deny: [
    { permission: 'plugins:install', why: 'install a plugin: the user installs plugins' },
    { permission: 'secrets:*', why: 'read the user’s secrets' },
    { permission: 'settings:write{scope:server}', why: 'change wisp’s settings' },
  ],
};

// What a session may not start or switch to, by its own mode: nothing it starts goes above it.
const aboveMode = (mode: Mode): Deny[] =>
  MODES.filter((m) => MODE_RANK[m] > MODE_RANK[mode]).flatMap((m) => [
    { permission: `runtime:start{mode:${m}}`, why: `start a task at ${MODE_LABEL[m]}, above this task’s ${MODE_LABEL[mode]}` },
    { permission: `session:mode{to:${m}}`, why: `switch a task to ${MODE_LABEL[m]}, above this task’s ${MODE_LABEL[mode]}` },
  ]);

/** `agent:session` narrowed to a mode (`agent:session:plan`). */
export function sessionSet(mode: Mode): CapabilitySet {
  return { id: `agent:session:${mode}`, allow: AGENT_SESSION.allow, deny: [...(AGENT_SESSION.deny ?? []), ...aboveMode(mode)] };
}

const capped = (permission: string, what: string): Deny => ({ permission, why: cappedRefusal(what) });

/** v1 capped.js: the routes' refusals for a task a channel started below Full auto. */
export const CAPPED_DENY: readonly Deny[] = [
  capped('machines:*', 'run anything on another machine or in a sandbox'),
  capped('sandbox:*', 'start a sandbox'),
  capped('runtime:delegate{to:machine}', 'send work to another machine'),
  capped('runtime:start{project:other}', 'start a task in another project'),
  capped('session:read{project:other}', 'read a task of another project'),
  capped('session:act{started:other}', 'act on a task it didn’t start'),
  capped('session:mode{task:other}', 'change another task’s mode'),
  capped('connectors:*', "read or change the user's connectors"),
  capped('stuff:publish', 'put anything on a public link, or take one down'),
  capped('stuff:save{project:other}', 'change an item of another project'),
  capped('stuff:save{from:outside}', 'save a file from outside its folder'),
  capped('stuff:read{project:other}', 'read an item of another project'),
  capped('fs:read{scope:outside}', 'show a file from outside its folders'),
  capped('prs:read{by:url}', 'read a PR by URL: give its number in this task’s repo'),
  capped('crew:write', 'change the user’s crew'),
  capped('crew:read{project:other}', 'read a member of another project'),
  capped('session:list{project:other}', 'read a task of another project'),
];

/** `agent:capped` at a cap (v1 `session.capped.mode`): agent:session at that mode, minus the capped list. */
export function cappedSet(cap: Mode = 'edits'): CapabilitySet {
  const base = sessionSet(cap);
  return { id: cap === 'edits' ? 'agent:capped' : `agent:capped:${cap}`, allow: base.allow, deny: [...CAPPED_DENY, ...(base.deny ?? [])] };
}

/** A crew member's agent: a session's power, but it can't rewrite the crew. */
export const crewSet = (name: string): CapabilitySet => ({
  id: `crew:${name}`,
  allow: AGENT_SESSION.allow,
  deny: [...(AGENT_SESSION.deny ?? []), { permission: 'crew:write', why: 'change the crew it belongs to' }],
});

/** A grid tenant's box: everything but other machines, wisp updates and the host's notifications. */
export const BOX: CapabilitySet = {
  id: 'box',
  allow: ['*'],
  deny: [
    { permission: 'machines:*', why: 'reach other machines from a grid box' },
    { permission: 'update:*', why: 'update wisp on a grid box: the grid does' },
    { permission: 'notify:native', why: 'show a desktop notification on a grid box' },
    { permission: 'proc:spawn{sandbox:none}', why: 'run a process outside the box sandbox' },
  ],
};

/** An API key, for scripting a cloud wisp: tasks and reads, never keys, plugins or secrets. */
export const APIKEY: CapabilitySet = {
  id: 'apikey',
  allow: ['runtime:*', 'session:*', 'stuff:read', 'stuff:save', 'topic:read', 'crew:read', 'budget:read'],
  deny: [
    { permission: 'apikeys:*', why: 'make or revoke API keys' },
    { permission: 'plugins:*', why: 'change plugins' },
    { permission: 'secrets:*', why: 'read secrets' },
  ],
};

/** A shared preview link: reads only. */
export const PREVIEW: CapabilitySet = { id: 'preview', allow: ['topic:read', 'session:read', 'stuff:read', 'blob:read'] };

/**
 * wisp Grid delivering a channel message it held while this box slept (v1 routes/channels.js): the
 * edge gives this set only to a request behind the grid's proxy mark with x-wisp-proxy-via: inbox.
 */
export const GRID_INBOX: CapabilitySet = { id: 'grid:inbox', allow: ['channels:inbound'] };
/** A message the grid routed to this computer (`on laptop`): only through its tunnel, x-wisp-route: grid. */
export const GRID_ROUTE: CapabilitySet = { id: 'grid:route', allow: ['channels:routed'] };

/**
 * What only the local user reaches (user:full's '*'), named so default deny is checked, not assumed:
 * Settings → Notifications and the phone's own answers (wisp.channels).
 */
export const USER_ONLY: readonly string[] = [
  'channels:view', 'channels:update', 'channels:test', 'channels:act', 'channels:rotate', 'channels:extra', 'channels:refresh',
];
/** What other plugins ask of the phone (budget's drain warning, an early reset, a reminder): in their manifests. */
export const PHONE_NOTICE: readonly string[] = ['channels:send', 'channels:notify'];

/** A pane or app iframe: what the user allowed from its bar, nothing by default. */
export const paneSet = (id: string, allow: readonly string[] = []): CapabilitySet => ({ id: `pane:${id}`, allow });

/** A plugin speaking for itself: its manifest's permissions plus its own commands. */
export function pluginSet(m: DeepReadonly<Manifest> | Manifest): CapabilitySet {
  return { id: `plugin:${m.id}`, allow: [...(m.permissions ?? []), `${ownerPrefix(m.id)}:*`] };
}

export type Decision = { ok: true } | { ok: false; why: string };

/** Allowed, or the reason it isn't. Default deny. */
export function explain(set: CapabilitySet, permission: string): Decision {
  if (!parsePermission(permission)) return { ok: false, why: `"${permission}" is not a permission` };
  const deny = set.deny?.find((d) => covers(d.permission, permission));
  if (deny) return { ok: false, why: deny.why };
  if (set.allow.some((g) => covers(g, permission))) return { ok: true };
  return { ok: false, why: `${set.id} may not ${permission}` };
}

export const allowed = (set: CapabilitySet, permission: string): boolean => explain(set, permission).ok;

/** Every set by id. Parametrised families (`crew:<name>`, `pane:<id>`, `agent:session:<mode>`) are made on demand. */
export class CapabilityRegistry {
  readonly #sets = new Map<string, CapabilitySet>();
  constructor(sets: readonly CapabilitySet[] = [USER_FULL, AGENT_SESSION, ...MODES.map(sessionSet), cappedSet('edits'), cappedSet('plan'), BOX, APIKEY, PREVIEW, GRID_INBOX, GRID_ROUTE]) {
    for (const s of sets) this.#sets.set(s.id, s);
  }
  /** Add or replace a set (a crew member's, a pane's allowed list). */
  define(set: CapabilitySet): void {
    this.#sets.set(set.id, set);
  }
  get(id: string): CapabilitySet | undefined {
    const known = this.#sets.get(id);
    if (known) return known;
    if (id.startsWith('crew:') && id.length > 5) return crewSet(id.slice(5));
    if (id.startsWith('pane:') && id.length > 5) return paneSet(id.slice(5));
    const mode = /^agent:(session|capped):(plan|edits|auto)$/.exec(id);
    if (mode) return mode[1] === 'session' ? sessionSet(mode[2] as Mode) : cappedSet(mode[2] as Mode);
    if (/^agent:session:/.test(id)) return AGENT_SESSION; // agent:session:<session id>: the session's own token
    return undefined;
  }
  ids(): string[] {
    return [...this.#sets.keys()];
  }
}
