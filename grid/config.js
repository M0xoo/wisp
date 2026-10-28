// wisp Grid's settings: grid.json in the data folder, then GRID_* environment variables, then what
// the command line passes. Secrets never sit in grid.json itself: a provider's client secret is a
// file (clientSecretFile, mode 0600) or an env var, and *_FILE env vars point at files (Docker and
// systemd credentials), so they stay out of `ps` and env dumps.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RESERVED = new Set(['www', 'api', 'app', 'admin', 'auth', 'grid', 'mail', 'static', 'status', 'docs', 'help', 'root', 'wisp', 'edge', 'login', 'signin']);

const DEFAULTS = {
  domain: 'wisp.localhost',
  scheme: 'http',
  listen: { host: '127.0.0.1', port: 8080 },
  publicPort: null, // the port in public URLs; null: the listen port for http, none for https
  name: 'wisp Grid',
  // seats: how maxUsers "auto" grows (grid/accounts.js), and how long a waitlist seat is held.
  auth: { dev: false, providers: {}, signup: 'open', allow: { emails: [], domains: [], githubOrgs: [], accounts: [] }, admins: [], seats: { min: 5, cap: 20, target: 0.7, everyHours: 24, holdDays: 7 } },
  hostd: { driver: 'process', idleMs: 120_000, checkMs: 5_000, startMs: 45_000, maxRunning: 50, env: {}, path: '' },
  sessionDays: 30,
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

// A secret from a value, a file, or an env var (VAR, then VAR_FILE).
export function readSecret({ value, file, env } = {}, environ = process.env) {
  if (value) return String(value);
  if (env && environ[env]) return environ[env];
  const f = file || (env && environ[`${env}_FILE`]);
  if (f) {
    try {
      return fs.readFileSync(f, 'utf8').trim();
    } catch (err) {
      throw new Error(`Can’t read the secret file ${f}: ${err.message}`);
    }
  }
  return '';
}

export function loadConfig({ dataDir, overrides = {}, env = process.env } = {}) {
  const dir = path.resolve(dataDir || env.GRID_DATA || path.join(os.homedir(), '.wisp-grid'));
  let file = {};
  const fileName = path.join(dir, 'grid.json');
  if (fs.existsSync(fileName)) {
    try {
      file = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    } catch (err) {
      throw new Error(`grid.json isn’t valid JSON: ${err.message}`);
    }
  }
  const fromEnv = {};
  if (env.GRID_DOMAIN) fromEnv.domain = env.GRID_DOMAIN;
  if (env.GRID_SCHEME) fromEnv.scheme = env.GRID_SCHEME;
  if (env.GRID_PORT) fromEnv.listen = { port: Number(env.GRID_PORT) };
  if (env.GRID_HOST) fromEnv.listen = { ...fromEnv.listen, host: env.GRID_HOST };
  // Providers from env: GRID_GITHUB_CLIENT_ID + GRID_GITHUB_CLIENT_SECRET(_FILE), same for GOOGLE.
  const providers = {};
  for (const id of ['github', 'google']) {
    const ID = id.toUpperCase();
    if (env[`GRID_${ID}_CLIENT_ID`]) providers[id] = { clientId: env[`GRID_${ID}_CLIENT_ID`], clientSecretEnv: `GRID_${ID}_CLIENT_SECRET` };
  }
  if (Object.keys(providers).length) fromEnv.auth = { providers };

  const cfg = merge(merge(merge(DEFAULTS, file), fromEnv), overrides);
  cfg.dataDir = dir;
  cfg.file = fileName;
  cfg.domain = String(cfg.domain).toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9.-]+$/.test(cfg.domain)) throw new Error(`domain: "${cfg.domain}" isn’t a host name.`);
  if (!['http', 'https'].includes(cfg.scheme)) throw new Error('scheme: http or https.');
  const port = cfg.publicPort ?? (cfg.scheme === 'http' ? cfg.listen.port : null);
  cfg.portSuffix = port && !(cfg.scheme === 'http' && port === 80) && !(cfg.scheme === 'https' && port === 443) ? `:${port}` : '';
  cfg.publicUrl = `${cfg.scheme}://${cfg.domain}${cfg.portSuffix}`;
  cfg.instanceUrl = (handle) => `${cfg.scheme}://${handle}.${cfg.domain}${cfg.portSuffix}`;
  cfg.secure = cfg.scheme === 'https';

  // Each provider's secret, resolved now so a missing one fails at start, not at sign-in.
  for (const [id, p] of Object.entries(cfg.auth.providers || {})) {
    if (!p || p.enabled === false) {
      delete cfg.auth.providers[id];
      continue;
    }
    if (!p.clientId) throw new Error(`auth.providers.${id}: clientId is missing.`);
    p.clientSecret = readSecret({ value: p.clientSecret, file: p.clientSecretFile && path.resolve(dir, p.clientSecretFile), env: p.clientSecretEnv }, env);
    if (!p.clientSecret) throw new Error(`auth.providers.${id}: no client secret (clientSecretFile, or ${p.clientSecretEnv || `GRID_${id.toUpperCase()}_CLIENT_SECRET`}).`);
  }
  if (!['open', 'closed'].includes(cfg.auth.signup)) throw new Error('auth.signup: open or closed.');
  if (cfg.telemetry != null && typeof cfg.telemetry !== 'boolean') throw new Error('telemetry: true or false.');
  const boxd = cfg.hostd.container?.boxd;
  if (boxd != null && (typeof boxd !== 'string' || !path.isAbsolute(boxd))) throw new Error('hostd.container.boxd: the path of boxd’s socket, e.g. /run/wisp-grid/box.sock (grid/README.md → Isolation).');
  if (cfg.auth.maxUsers != null && cfg.auth.maxUsers !== 'auto' && !(Number.isInteger(cfg.auth.maxUsers) && cfg.auth.maxUsers > 0)) throw new Error('auth.maxUsers: a whole number above 0, "auto", or leave it out for no limit.');
  const st = cfg.auth.seats;
  const whole = (v, min) => Number.isInteger(v) && v >= min;
  if (!whole(st.min, 1)) throw new Error('auth.seats.min: a whole number above 0 (the seats "auto" starts with).');
  if (!whole(st.cap, st.min)) throw new Error('auth.seats.cap: a whole number, at least auth.seats.min (the most seats "auto" opens).');
  if (!(typeof st.target === 'number' && st.target > 0 && st.target <= 1)) throw new Error('auth.seats.target: a share of the host above 0, up to 1 (0.7: open seats while under 70% busy).');
  if (!(typeof st.everyHours === 'number' && st.everyHours > 0)) throw new Error('auth.seats.everyHours: hours between new seats, above 0.');
  if (!(typeof st.holdDays === 'number' && st.holdDays >= 0)) throw new Error('auth.seats.holdDays: days a seat stays held for an invited person on the waitlist, 0 or more.');
  const ad = cfg.hostd.admit;
  if (ad != null && ad !== false && !(isObj(ad) && ['boxMb', 'reserveMb'].every((k) => ad[k] == null || whole(ad[k], 0)))) throw new Error('hostd.admit: false, or { boxMb, reserveMb } in MiB (the memory one more box needs, and what the host keeps for itself).');
  if (cfg.hostd.previews != null && typeof cfg.hostd.previews !== 'boolean') throw new Error('hostd.previews: true or false (pages the agent runs in a box, at p<port>--<handle>; on by default for containers).');
  for (const k of ['evictAfterMs', 'queueMs']) if (cfg.hostd[k] != null && !whole(cfg.hostd[k], 0)) throw new Error(`hostd.${k}: milliseconds, a whole number.`);
  return cfg;
}

// What `wisp grid init` writes. Secrets go next to it, in secrets/, never inside it.
export function writeConfig(cfg) {
  const { dataDir, file, portSuffix, publicUrl, instanceUrl, secure, ...rest } = cfg;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rest, null, 2)}\n`);
}
