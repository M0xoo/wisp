// @wisp-plugin/grid-client-api: the contract of wisp.grid-client, this wisp's side of a wisp Grid
// (grid/, plan §7.2): signing in to a grid (RFC 8628 device flow), this computer on the grid through
// the tunnel it holds, your cloud computers and sandboxes as peers (the `grid` and `grid-tunnel`
// transports of machines.transport@1), API keys, publishing an app from My Stuff and sharing a task.
//
// v1: server/grid-client.js, grid-tunnel.js, services/{cloud,computer,sandbox,api-keys,publish,share}.js
// and routes/cloud.js. Grid peers are machines rows (`@wisp-plugin/machines-api`), their tokens in the
// secrets service under `machines.<id>`; nothing here keeps a token in a row.

import type { Json, ServiceRef } from '@wisp/kernel';

export const PLUGIN = 'wisp.grid-client';

// ---------- commands ----------
// Ids are plugin-local; each names its permission explicitly, in a namespace the capability sets
// already decide about: `machines:grid.*` (a box and a capped task get none of `machines:*`),
// `sandbox:*`, `apikeys:*` (an API key is refused them) and `stuff:publish`.

export const COMMANDS = {
  signin: 'grid-client.signin', // { url, addComputer? } → SigninView
  signinGet: 'grid-client.signin.get', // { id } → SigninView   (read-only)
  signinCancel: 'grid-client.signin.cancel', // { id } → SigninView
  computer: 'grid-client.computer', // {} → ComputerView   (read-only; looks your computers up again when stale)
  computerSet: 'grid-client.computer.set', // { on?, account?, previews? } → ComputerView
  computerSync: 'grid-client.computer.sync', // {} → {}   (your other computers, as peers here)
  keysList: 'grid-client.keys.list', // {} → KeysView   (read-only)
  keysCreate: 'grid-client.keys.create', // { name } → the grid's answer (the key, once)
  keysRevoke: 'grid-client.keys.revoke', // { id } → the grid's answer
  sandbox: 'grid-client.sandbox', // {} → SandboxView   (read-only)
  sandboxEnvSet: 'grid-client.sandbox.env.set', // { key, value } → { env: string[] }
  sandboxEnvDrop: 'grid-client.sandbox.env.drop', // { key } → { env: string[] }
  sandboxLogin: 'grid-client.sandbox.login', // {} → LoginView   (`claude setup-token` here)
  sandboxLoginInput: 'grid-client.sandbox.login.input', // { code } → LoginView
  sandboxLoginCancel: 'grid-client.sandbox.login.cancel', // {} → LoginView
  sandboxLogout: 'grid-client.sandbox.logout', // { agent } → { logins }
  sandboxBrowser: 'grid-client.sandbox.browser', // { task, width?, height? } → { url }
  sandboxDesktop: 'grid-client.sandbox.desktop', // { width?, height? } → { port, size }   (in a sandbox)
  sandboxSeed: 'grid-client.sandbox.seed', // SeedArgs → { cwd, setup }   (in a sandbox)
  sandboxRemove: 'grid-client.sandbox.remove', // { id } → SandboxView
  sandboxLaunch: 'grid-client.sandbox.launch', // LaunchArgs → the far side's summaries (ids `<id>@<peer>`)
  publishTargets: 'grid-client.publish.targets', // {} → PublishTarget[]   (read-only)
  publish: 'grid-client.publish', // { id, account? } → StuffItemView (with `published`)
  unpublish: 'grid-client.unpublish', // { id } → StuffItemView
  sharePreview: 'grid-client.share.preview', // { id } → SharePreview   (read-only)
  share: 'grid-client.share', // { id, passkey?, work?, account? } → Shared & { notes }
  unshare: 'grid-client.unshare', // { id } → { ok }
  sharePeek: 'grid-client.share.peek', // { url, passkey? } → ShareCard   (read-only)
  shareImport: 'grid-client.share.import', // ImportArgs → ImportResult
} as const;

/** The permission each command (and the v1 route that calls it) names. */
export const PERMISSIONS = {
  signin: 'machines:grid.signin',
  read: 'machines:grid.read',
  computer: 'machines:grid.computer',
  keysList: 'apikeys:list',
  keysWrite: 'apikeys:write',
  sandboxRead: 'sandbox:read',
  sandboxEnv: 'sandbox:env',
  sandboxLogin: 'sandbox:login',
  sandboxUse: 'sandbox:use',
  sandboxStart: 'sandbox:start',
  sandboxRemove: 'sandbox:remove',
  stuffRead: 'stuff:read',
  publish: 'stuff:publish',
} as const;

// ---------- views (v1 shapes, field for field) ----------

export type SigninState = 'waiting' | 'done' | 'expired' | 'denied' | 'failed' | 'cancelled';
export interface SigninView {
  id: string;
  grid: string;
  state: SigninState;
  userCode: string;
  verifyUrl: string;
  expiresAt: number;
  error: string;
  machineId: string | null;
  user: Json;
}

export interface AccountRef {
  /** the cloud computer's peer id here */
  id: string;
  grid: string;
  handle: string;
}

export type TunnelState = 'off' | 'connecting' | 'online' | 'retrying' | 'gone';
export interface ComputerView {
  on: boolean;
  state: TunnelState;
  error: string;
  name: string;
  url: string;
  previews: boolean;
  previewUrl: string;
  grid: string;
  account: AccountRef | null;
  accounts: AccountRef[];
  /** this wisp is a cloud computer itself (WISP_PUBLIC_URL): it's on its grid already */
  cloud: boolean;
}

export interface KeysView {
  grid: { host: string; handle: string } | null;
  keys: Json[];
}

export interface LoginView {
  state: 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  url?: string;
  needsInput?: boolean;
  checking?: boolean;
  retry?: boolean;
  error?: string;
}

export interface SandboxItem {
  id: string;
  name: string;
  createdAt: number;
  owner: Json;
  state: string;
  here: boolean;
}
export interface SandboxView {
  grid: { host: string; handle: string } | null;
  enabled?: boolean;
  logins: Json;
  env?: string[];
  login: LoginView;
  sandboxes: number;
  list?: SandboxItem[];
  error?: string;
}

/** Where this wisp can publish or share: never a token. */
export interface PublishTarget {
  id: string;
  host: string;
  handle: string;
}

export interface Published {
  url: string;
  account: string;
  host: string;
  handle: string;
  rev: number;
  at: number;
}

export interface Shared {
  id: string;
  url: string;
  account: string;
  host: string;
  locked: boolean;
  work: boolean;
  at: number;
}

export interface SeedArgs {
  upload: string;
  name?: string;
  ref: string;
  branch?: string;
  origin?: string;
  author?: { name?: string; email?: string };
  keep?: boolean;
}

/** A /sandbox launch: v1's POST /sessions body whose prompt starts with /sandbox. */
export interface LaunchArgs {
  prompt: string;
  agent?: string;
  cwd?: string;
  scratch?: boolean;
  progress?: string;
  [field: string]: Json | undefined;
}

// ---------- the peer's `data` (machines-api PeerRow.data) ----------

/** What a grid peer's row keeps in `data`: v1's machine fields for kind 'grid'. */
export interface GridData {
  grid: string;
  handle: string;
  user: Json;
  /** another of your computers: its id on the grid (transport grid-tunnel) */
  computer?: string;
  /** a sandbox: its id on the grid, and what it is for */
  sandbox?: string;
  owner?: SandboxOwner;
  /** its delete on the grid failed: hidden, the sweep tries again */
  dropping?: boolean;
  /** how the project's .wisp/sandbox.sh went */
  setup?: Json;
  /** project folder here → its folder there, set up once */
  seeded?: Record<string, string>;
}

export interface SandboxOwner {
  task?: string;
  job?: string;
  crew?: string;
  lead?: string;
  delegate?: string;
  pending?: number;
  doneAt?: number;
}

// ---------- notices (ephemeral; the notify service) and the computer's topic ----------

export const NOTICES = {
  /** a sign-in moved (v1 broadcast 'cloud'): SigninView */
  cloud: 'cloud',
  /** the sandboxes' Claude sign-in moved (v1 broadcast 'sandbox'): { login, logins? } */
  sandbox: 'sandbox',
  /** a /sandbox launch's placeholder card (v1 'sandbox-step'): { key, live } */
  sandboxStep: 'sandbox-step',
} as const;

/** This computer on the grid: one row, entity `grid-client.computer`, id 'this'. */
export const TOPIC_COMPUTER = 'plugin:wisp.grid-client:computer';
export const ENTITY_COMPUTER = 'grid-client.computer';

export const EVENTS = {
  /** this computer's place on the grid changed: { on, state } */
  computer: 'grid-client.computer',
} as const;

// ---------- services ----------

/** `grid-client.grid@1`: what the edge and channels need from this plugin. */
export interface GridService {
  /** grids this wisp is signed in to, for publish and share (never a token) */
  targets(): Promise<PublishTarget[]>;
  /** this wisp's local pages through the grid ('https://p{port}--…'), '' while previews are off */
  previewUrl(): string;
  /** this computer is on a grid (its tunnel configured) */
  onGrid(): boolean;
  /** a report on a message the grid routed here (`on laptop`): thread is all this holds of that chat */
  reply(thread: Json, text: string): Promise<Json>;
  /** this request came through this computer's tunnel (x-wisp-tunnel carries the process's mark) */
  fromTunnel(headers: Record<string, string | string[] | undefined>): boolean;
}
export const GRID_SERVICE: ServiceRef<GridService> = {
  id: 'grid-client.grid',
  major: 1,
  permissions: { targets: 'machines:grid.read', previewUrl: 'machines:grid.read', onGrid: 'machines:grid.read', reply: 'machines:grid.reply', fromTunnel: 'machines:grid.read' },
  readOnly: ['targets', 'previewUrl', 'onGrid', 'fromTunnel'],
};

/** A delegate whose place is Sandbox (v1 services/relay.js). */
export interface DelegateAsk {
  lead: string;
  child: string;
  title?: string;
  name?: string;
}
/** A crew member whose jobs run in a sandbox (v1 crew.js): 'own' keeps one, 'job' makes one per job. */
export interface CrewMemberAsk {
  id: string;
  name: string;
  agent?: string;
  cwd?: string;
  sandbox: 'own' | 'job';
}

/** `grid-client.sandbox@1`: sandboxes for the runtime (delegates, task deletes) and the crew. */
export interface SandboxService {
  /** a grid is signed in, so sandboxes can be made */
  available(): Promise<boolean>;
  /** throws (400) for a harness that can't sign in to sandboxes */
  harnessOk(agent: string): void;
  /** the sandbox peer a task (`<id>@<peer>`) runs in, if it is that task's own */
  ownedBy(task: string): string | null;
  forDelegate(ask: DelegateAsk): Promise<{ machine: string }>;
  seedDelegate(machine: string, pack: { upload: string; ref: string }, dir: string): Promise<string>;
  forCrew(member: CrewMemberAsk, o?: { title?: string }): Promise<{ machine: string; cwd: string }>;
  crewJob(machine: string, job: string): Promise<void>;
  jobFiled(job: string): Promise<void>;
  crewMachines(member: string): string[];
  leadGone(lead: string): Promise<void>;
  crewGone(member: string): Promise<void>;
  taskGone(task: string): Promise<boolean>;
}
export const SANDBOX_SERVICE: ServiceRef<SandboxService> = {
  id: 'grid-client.sandbox',
  major: 1,
  permissions: {
    available: 'sandbox:read',
    harnessOk: 'sandbox:read',
    ownedBy: 'sandbox:read',
    forDelegate: 'sandbox:start',
    seedDelegate: 'sandbox:start',
    forCrew: 'sandbox:start',
    crewJob: 'sandbox:start',
    jobFiled: 'sandbox:remove',
    crewMachines: 'sandbox:read',
    leadGone: 'sandbox:remove',
    crewGone: 'sandbox:remove',
    taskGone: 'sandbox:remove',
  },
  readOnly: ['available', 'harnessOk', 'ownedBy', 'crewMachines'],
};

export * from './ports.ts';
