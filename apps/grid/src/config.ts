// wisp Grid's settings: grid.json in the data folder, then GRID_* environment variables, then what
// the command line passes. Secrets never sit in grid.json itself: a provider's client secret is a
// file (clientSecretFile, mode 0600) or an env var, and *_FILE env vars point at files (Docker and
// systemd credentials), so they stay out of `ps` and env dumps.
//
// Read once at start (sync fs is fine here: nothing is serving yet).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RESERVED: ReadonlySet<string> = new Set(['www', 'api', 'app', 'admin', 'auth', 'grid', 'mail', 'static', 'status', 'docs', 'help', 'root', 'wisp', 'edge', 'login', 'signin']);

export interface ProviderConfig {
  clientId: string;
  clientSecret?: string;
  clientSecretFile?: string;
  clientSecretEnv?: string;
  enabled?: boolean;
  label?: string;
  /** OIDC: the issuer; Google's is built in. */
  issuer?: string;
  /** GitHub: where to send the browser and call the API (tests point them at a fake). */
  authBase?: string;
  apiBase?: string;
  [k: string]: unknown;
}

export interface Seats {
  min: number;
  cap: number;
  target: number;
  everyHours: number;
  holdDays: number;
}

export interface AuthConfig {
  dev: boolean;
  providers: Record<string, ProviderConfig>;
  signup: 'open' | 'closed';
  allow: { emails?: string[]; domains?: string[]; githubOrgs?: string[]; accounts?: string[] };
  admins: string[];
  seats: Seats;
  maxUsers?: number | 'auto';
}

/** The container driver's settings (boxd.ts CONTAINER has the defaults). */
export interface ContainerConfig {
  image?: string;
  runtime?: string;
  network?: string;
  memory?: string;
  memorySwap?: string;
  cpus?: number;
  pids?: number;
  uid?: number;
  dns?: string[];
  /** boxd's socket: with it, boxd runs the containers and the grid needs no Docker. */
  boxd?: string;
  sandbox?: { memory?: string; memorySwap?: string; cpus?: number; pids?: number };
  [k: string]: unknown;
}

export interface HostdConfig {
  driver: 'process' | 'container';
  idleMs: number;
  checkMs: number;
  startMs: number;
  maxRunning: number;
  env: Record<string, string>;
  path: string;
  admit?: false | { boxMb?: number; reserveMb?: number };
  previews?: boolean;
  evictAfterMs?: number;
  queueMs?: number;
  sampleMs?: number;
  container?: ContainerConfig;
  /** The box's entry: apps/server's bin by default; tests run a stand-in. */
  wispBin?: string;
}

export interface ChannelsConfig {
  enabled?: boolean;
  maxRows?: number;
  maxBytes?: number;
  route?: boolean;
  retryMs?: number;
  wakeRetryMs?: number;
  deliverMs?: number;
  ttlMs?: number;
  telegramApi?: string;
  [k: string]: unknown;
}

export interface MailConfig {
  domain: string;
  inbound: { provider: 'ses'; topicArn: string; keys?: string[]; dkimKeys?: Record<string, string>; [k: string]: unknown };
  outbound: { provider: 'ses'; region: string; accessKeyId: string; secretAccessKey?: string; secretAccessKeyFile?: string; secretAccessKeyEnv?: string; [k: string]: unknown };
  sendPerHour?: number;
  threadDays?: number;
  [k: string]: unknown;
}

export interface FeatureConfig {
  enabled?: boolean;
  maxBytes?: number;
  perUser?: number;
  dbBytes?: number;
}

/** grid.json as written: what `loadConfig` reads and `writeConfig` keeps. */
export interface GridFile {
  domain: string;
  scheme: 'http' | 'https';
  listen: { host: string; port: number };
  publicPort: number | null;
  name: string;
  auth: AuthConfig;
  hostd: HostdConfig;
  sessionDays: number;
  telemetry?: boolean;
  channels?: ChannelsConfig;
  mail?: MailConfig;
  sites?: FeatureConfig;
  shares?: FeatureConfig;
  sandboxes?: FeatureConfig;
}

export interface GridConfig extends GridFile {
  dataDir: string;
  file: string;
  portSuffix: string;
  publicUrl: string;
  instanceUrl: (label: string) => string;
  secure: boolean;
}

const DEFAULTS: GridFile = {
  domain: 'wisp.localhost',
  scheme: 'http',
  listen: { host: '127.0.0.1', port: 8080 },
  publicPort: null, // the port in public URLs; null: the listen port for http, none for https
  name: 'wisp Grid',
  // seats: how maxUsers "auto" grows (accounts.ts), and how long a waitlist seat is held.
  auth: { dev: false, providers: {}, signup: 'open', allow: { emails: [], domains: [], githubOrgs: [], accounts: [] }, admins: [], seats: { min: 5, cap: 20, target: 0.7, everyHours: 24, holdDays: 7 } },
  hostd: { driver: 'process', idleMs: 120_000, checkMs: 5_000, startMs: 45_000, maxRunning: 50, env: {}, path: '' },
  sessionDays: 30,
};

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge of plain objects; arrays and everything else in b replace a's. */
export function merge(a: Record<string, unknown>, b: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  if (!isObj(b)) return out;
  for (const [k, v] of Object.entries(b)) {
    const av = a[k];
    out[k] = isObj(v) && isObj(av) ? merge(av, v) : v;
  }
  return out;
}

/** A secret from a value, a file, or an env var (VAR, then VAR_FILE). */
export function readSecret({ value, file, env }: { value?: unknown; file?: string | undefined; env?: string | undefined } = {}, environ: NodeJS.ProcessEnv = process.env): string {
  if (value) return String(value);
  if (env && environ[env]) return environ[env] ?? '';
  const f = file || (env && environ[`${env}_FILE`]);
  if (f) {
    try {
      return fs.readFileSync(f, 'utf8').trim();
    } catch (err) {
      throw new Error(`Can’t read the secret file ${f}: ${(err as Error).message}`);
    }
  }
  return '';
}

function readFile(fileName: string): unknown {
  if (!fs.existsSync(fileName)) return {};
  try {
    return JSON.parse(fs.readFileSync(fileName, 'utf8'));
  } catch (err) {
    throw new Error(`grid.json isn’t valid JSON: ${(err as Error).message}`);
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env['GRID_DOMAIN']) out['domain'] = env['GRID_DOMAIN'];
  if (env['GRID_SCHEME']) out['scheme'] = env['GRID_SCHEME'];
  const listen: Record<string, unknown> = {};
  if (env['GRID_PORT']) listen['port'] = Number(env['GRID_PORT']);
  if (env['GRID_HOST']) listen['host'] = env['GRID_HOST'];
  if (Object.keys(listen).length) out['listen'] = listen;
  // Providers from env: GRID_GITHUB_CLIENT_ID + GRID_GITHUB_CLIENT_SECRET(_FILE), same for GOOGLE.
  const providers: Record<string, ProviderConfig> = {};
  for (const id of ['github', 'google']) {
    const ID = id.toUpperCase();
    const clientId = env[`GRID_${ID}_CLIENT_ID`];
    if (clientId) providers[id] = { clientId, clientSecretEnv: `GRID_${ID}_CLIENT_SECRET` };
  }
  if (Object.keys(providers).length) out['auth'] = { providers };
  return out;
}

export interface LoadOptions {
  dataDir?: string;
  overrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig({ dataDir, overrides = {}, env = process.env }: LoadOptions = {}): GridConfig {
  const dir = path.resolve(dataDir || env['GRID_DATA'] || path.join(os.homedir(), '.wisp-grid'));
  const fileName = path.join(dir, 'grid.json');
  // Checked field by field below: what grid.json says is only trusted once validate() passed.
  const merged = merge(merge(merge(DEFAULTS as unknown as Record<string, unknown>, readFile(fileName)), fromEnv(env)), overrides) as unknown as GridFile;
  const domain = String(merged.domain).toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error(`domain: "${domain}" isn’t a host name.`);
  if (!['http', 'https'].includes(merged.scheme)) throw new Error('scheme: http or https.');
  const port = merged.publicPort ?? (merged.scheme === 'http' ? merged.listen.port : null);
  const portSuffix = port && !(merged.scheme === 'http' && port === 80) && !(merged.scheme === 'https' && port === 443) ? `:${port}` : '';
  const scheme = merged.scheme;
  const cfg: GridConfig = {
    ...merged,
    domain,
    dataDir: dir,
    file: fileName,
    portSuffix,
    publicUrl: `${scheme}://${domain}${portSuffix}`,
    instanceUrl: (handle) => `${scheme}://${handle}.${domain}${portSuffix}`,
    secure: scheme === 'https',
  };
  resolveProviders(cfg, dir, env);
  validateAuth(cfg);
  validateHostd(cfg);
  validateChannels(cfg, dir, env);
  return cfg;
}

// Each provider's secret, resolved now so a missing one fails at start, not at sign-in.
function resolveProviders(cfg: GridConfig, dir: string, env: NodeJS.ProcessEnv): void {
  const providers = cfg.auth.providers;
  for (const [id, p] of Object.entries(providers)) {
    if (!p || p.enabled === false) {
      delete providers[id];
      continue;
    }
    if (!p.clientId) throw new Error(`auth.providers.${id}: clientId is missing.`);
    p.clientSecret = readSecret({ value: p.clientSecret, file: p.clientSecretFile && path.resolve(dir, p.clientSecretFile), env: p.clientSecretEnv }, env);
    if (!p.clientSecret) throw new Error(`auth.providers.${id}: no client secret (clientSecretFile, or ${p.clientSecretEnv || `GRID_${id.toUpperCase()}_CLIENT_SECRET`}).`);
  }
}

const whole = (v: unknown, min: number): boolean => Number.isInteger(v) && (v as number) >= min;

function validateAuth(cfg: GridConfig): void {
  if (!['open', 'closed'].includes(cfg.auth.signup)) throw new Error('auth.signup: open or closed.');
  if (cfg.telemetry != null && typeof cfg.telemetry !== 'boolean') throw new Error('telemetry: true or false.');
  const max = cfg.auth.maxUsers;
  if (max != null && max !== 'auto' && !(Number.isInteger(max) && max > 0)) throw new Error('auth.maxUsers: a whole number above 0, "auto", or leave it out for no limit.');
  const st = cfg.auth.seats;
  if (!whole(st.min, 1)) throw new Error('auth.seats.min: a whole number above 0 (the seats "auto" starts with).');
  if (!whole(st.cap, st.min)) throw new Error('auth.seats.cap: a whole number, at least auth.seats.min (the most seats "auto" opens).');
  if (!(typeof st.target === 'number' && st.target > 0 && st.target <= 1)) throw new Error('auth.seats.target: a share of the host above 0, up to 1 (0.7: open seats while under 70% busy).');
  if (!(typeof st.everyHours === 'number' && st.everyHours > 0)) throw new Error('auth.seats.everyHours: hours between new seats, above 0.');
  if (!(typeof st.holdDays === 'number' && st.holdDays >= 0)) throw new Error('auth.seats.holdDays: days a seat stays held for an invited person on the waitlist, 0 or more.');
}

function validateHostd(cfg: GridConfig): void {
  const boxd = cfg.hostd.container?.boxd;
  if (boxd != null && (typeof boxd !== 'string' || !path.isAbsolute(boxd))) throw new Error('hostd.container.boxd: the path of boxd’s socket, e.g. /run/wisp-grid/box.sock (apps/grid/README.md → Isolation).');
  const ad: unknown = cfg.hostd.admit;
  if (ad != null && ad !== false && !(isObj(ad) && ['boxMb', 'reserveMb'].every((k) => ad[k] == null || whole(ad[k], 0)))) throw new Error('hostd.admit: false, or { boxMb, reserveMb } in MiB (the memory one more box needs, and what the host keeps for itself).');
  if (cfg.hostd.previews != null && typeof cfg.hostd.previews !== 'boolean') throw new Error('hostd.previews: true or false (pages the agent runs in a box, at p<port>--<handle>; on by default for containers).');
  for (const k of ['evictAfterMs', 'queueMs'] as const) if (cfg.hostd[k] != null && !whole(cfg.hostd[k], 0)) throw new Error(`hostd.${k}: milliseconds, a whole number.`);
}

function validateChannels(cfg: GridConfig, dir: string, env: NodeJS.ProcessEnv): void {
  const ch: unknown = cfg.channels;
  if (ch != null) {
    if (!isObj(ch) || (ch['enabled'] != null && typeof ch['enabled'] !== 'boolean')) throw new Error('channels: { enabled, maxRows, maxBytes }, enabled true or false.');
    for (const k of ['maxRows', 'maxBytes']) if (ch[k] != null && !whole(ch[k], 1)) throw new Error(`channels.${k}: a whole number above 0.`);
    if (ch['route'] != null && typeof ch['route'] !== 'boolean') throw new Error('channels.route: true or false (`on laptop` from a message, apps/grid/README.md → Channels).');
    if (ch['route'] && !ch['enabled']) throw new Error('channels.route needs channels.enabled: what isn’t for a computer goes to the box through the inbox.');
  }
  if (cfg.mail != null) validateMail(cfg, dir, env);
}

function validateMail(cfg: GridConfig, dir: string, env: NodeJS.ProcessEnv): void {
  const mail: unknown = cfg.mail;
  if (cfg.channels?.enabled !== true) throw new Error('mail needs channels: { enabled: true }: mail reaches a box through the same held inbox.');
  if (!isObj(mail) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(mail['domain'] || ''))) throw new Error('mail.domain: the domain the secret addresses are on, like mail.example.com.');
  const i = mail['inbound'];
  const o = mail['outbound'];
  if (!isObj(i) || !isObj(o) || i['provider'] !== 'ses' || o['provider'] !== 'ses') throw new Error('mail.inbound.provider and mail.outbound.provider: "ses" is the one there is.');
  if (!/^arn:aws[\w-]*:sns:[a-z0-9-]+:\d+:[\w-]+$/.test(String(i['topicArn'] || ''))) throw new Error('mail.inbound.topicArn: the ARN of the SNS topic SES publishes to.');
  const keys = i['keys'];
  if (keys != null && !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) throw new Error("mail.inbound.keys: a list of PEM keys or certificates to trust instead of fetching AWS's.");
  if (!o['region'] || !o['accessKeyId']) throw new Error('mail.outbound: region and accessKeyId are needed.');
  const file = typeof o['secretAccessKeyFile'] === 'string' ? path.resolve(dir, o['secretAccessKeyFile']) : undefined;
  const envName = typeof o['secretAccessKeyEnv'] === 'string' ? o['secretAccessKeyEnv'] : 'GRID_MAIL_SECRET';
  o['secretAccessKey'] = readSecret({ value: o['secretAccessKey'], file, env: envName }, env);
  if (!o['secretAccessKey']) throw new Error('mail.outbound: no secret key (secretAccessKeyFile, or GRID_MAIL_SECRET).');
  for (const k of ['sendPerHour', 'threadDays']) if (mail[k] != null && !whole(mail[k], 1)) throw new Error(`mail.${k}: a whole number above 0.`);
}

/** What `wisp grid init` writes. Secrets go next to it, in secrets/, never inside it. */
export async function writeConfig(cfg: GridConfig): Promise<void> {
  const { dataDir, file, portSuffix: _s, publicUrl: _p, instanceUrl: _i, secure: _x, ...rest } = cfg;
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(file, `${JSON.stringify(rest, null, 2)}\n`);
}
