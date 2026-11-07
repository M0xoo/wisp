// The `wisp grid` subcommands that look after a grid's data: doctor, rotate-key, backup, users and
// waitlist. Each opens grid.db itself and closes it before it returns (cli.ts dispatches).

import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { CONTAINER, boxdCall } from './boxd.ts';
import { loadConfig, type GridConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import type { UserRow } from './rows.ts';
import { createSeats } from './seats.ts';
import { addMasterKey, createSecrets, masterFile, pruneMasterKeys } from './secrets.ts';

/** Where a subcommand's lines go: the terminal, or a test's array. */
export interface Io {
  out(line: string): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function withDb<T>(cfg: GridConfig, fn: (db: Db) => Promise<T> | T): Promise<T> {
  const db = await openDb(cfg.dataDir);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

const localhost = (name: string): boolean => /(^|\.)localhost$/.test(name);

// DNS for the grid's own name and a made-up handle under it (the wildcard).
async function checkDns(cfg: GridConfig, ok: (m: string) => void, no: (m: string) => void): Promise<void> {
  for (const name of [cfg.domain, `check-${Date.now().toString(36)}.${cfg.domain}`]) {
    if (localhost(name)) {
      ok(`${name} → loopback`);
      continue;
    }
    try {
      const a = await dns.lookup(name);
      ok(`${name} → ${a.address}`);
    } catch {
      no(`${name} doesn’t resolve: add ${name.startsWith('check-') ? `*.${cfg.domain}` : cfg.domain} to DNS`);
    }
  }
}

async function checkBoxes(cfg: GridConfig, ok: (m: string) => void, no: (m: string) => void, io: Io): Promise<void> {
  if (cfg.hostd.driver === 'process') io.out('  ! hostd driver "process": users share one OS user. Fine for you and people you trust; not isolation.');
  if (cfg.hostd.driver !== 'container') return;
  const c = { ...CONTAINER, ...cfg.hostd.container };
  let runtime: unknown = c.runtime;
  if (c.boxd) {
    try {
      const r = await boxdCall(c.boxd, { op: 'ping' }, { timeout: 5000 });
      runtime = r['runtime'];
      ok(`boxd at ${c.boxd}: boxes in ${String(r['boxes'])}, image ${String(r['image'])}, runtime ${String(r['runtime'] || 'runc')}`);
    } catch (err) {
      no(message(err));
    }
  } else io.out('  ! hostd runs docker itself: the grid’s user is root in effect, and the boxes’ homes (agent logins) sit in its data folder. Set up boxd (apps/grid/README.md → Isolation).');
  if (process.getuid?.() === c.uid && runtime !== 'runsc') io.out(`  ! the grid runs as uid ${c.uid}, the boxes’ user: without gVisor it could look into them. Give the grid its own user (useradd --system).`);
}

/** `wisp grid doctor`: 0 when every check passed, 1 otherwise. */
export async function doctor(dataDir: string | undefined, io: Io): Promise<number> {
  let code = 0;
  const ok = (m: string): void => io.out(`  ✓ ${m}`);
  const no = (m: string): void => {
    io.out(`  ✗ ${m}`);
    code = 1;
  };
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node.js ${process.version}`);
  else no(`Node.js ${process.version}: the grid needs 22.13 or newer`);
  let cfg: GridConfig;
  try {
    cfg = loadConfig(dataDir ? { dataDir } : {});
    ok(`config ${cfg.file}`);
  } catch (err) {
    no(message(err));
    return code;
  }
  try {
    await withDb(cfg, (db) => void createSecrets(db, { dataDir: cfg.dataDir }));
    ok('master key readable, permissions 0600');
  } catch (err) {
    no(message(err));
  }
  const provs = Object.keys(cfg.auth.providers);
  if (provs.length) ok(`sign-in: ${provs.join(', ')} (redirect URIs: ${provs.map((p) => `${cfg.publicUrl}/auth/${p}/callback`).join(', ')})`);
  else if (cfg.auth.dev) ok('sign-in: dev only (any email): not for real users');
  else no('sign-in: no provider enabled in grid.json (github, google or oidc:<name>)');
  await checkDns(cfg, ok, no);
  if (cfg.scheme !== 'https' && !localhost(cfg.domain)) no('scheme is http on a real domain: sign-in cookies and device tokens would travel in the clear');
  await checkBoxes(cfg, ok, no, io);
  return code;
}

export async function rotateKey(cfg: GridConfig, io: Io): Promise<number> {
  const kid = addMasterKey(cfg.dataDir);
  const [n, gone] = await withDb(cfg, (db) => {
    const moved = createSecrets(db, { dataDir: cfg.dataDir }).rewrap();
    const inUse = new Set(db.all<{ kid: string }>('SELECT DISTINCT kid FROM keys').map((r) => r.kid));
    return [moved, pruneMasterKeys(cfg.dataDir, inUse)] as const;
  });
  io.out(`  ✓ new master key ${kid}; re-wrapped ${n} user key${n === 1 ? '' : 's'}; retired ${gone.join(', ') || 'none'}`);
  return 0;
}

export async function backup(cfg: GridConfig, to: string | undefined, io: Io): Promise<number> {
  const file = path.resolve(to || path.join(cfg.dataDir, 'backups', `grid-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
  await withDb(cfg, (db) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db.backup(file);
  });
  io.out(`  ✓ ${file}\n    Keep it with ${masterFile(cfg.dataDir)}: without the master key the users' secrets in it can't be read.`);
  return 0;
}

interface UserLine {
  [k: string]: unknown;
  handle: string;
  email: string | null;
  state: string | null;
  via: string | null;
}

export async function users(cfg: GridConfig, { delete: handle, yes }: { delete?: string | undefined; yes: boolean }, io: Io): Promise<number> {
  return withDb(cfg, async (db) => {
    if (handle) return deleteUser(cfg, db, handle.toLowerCase(), yes, io);
    const rows = db.all<UserLine>('SELECT u.handle, u.email, u.created_at, i.state, (SELECT group_concat(provider) FROM identities WHERE user_id = u.id) AS via FROM users u LEFT JOIN instances i ON i.user_id = u.id ORDER BY u.created_at');
    io.out(rows.map((r) => `${r.handle.padEnd(20)} ${String(r.email || '').padEnd(30)} ${String(r.via || '').padEnd(14)} ${r.state || 'stopped'}`).join('\n') || 'No users yet.');
    return 0;
  });
}

// `wisp grid users --delete <handle> --yes`: the same as Delete on their account page.
async function deleteUser(cfg: GridConfig, db: Db, handle: string, yes: boolean, io: Io): Promise<number> {
  const u = db.get<UserRow>('SELECT * FROM users WHERE handle = ?', handle);
  if (!u) throw new Error(`Nobody here is called ${handle}.`);
  const what = `${u.handle}${u.email ? ` (${u.email})` : ''}: their box, its files and their agents’ sign-ins, their secrets, sessions, devices and published apps`;
  if (!yes) {
    io.out(`  This deletes ${what}.\n  To go ahead: wisp grid users --delete ${u.handle} --yes`);
    return 0;
  }
  // A process can only be stopped by the grid that started it.
  if (cfg.hostd.driver === 'process' && db.get<{ state: string }>('SELECT state FROM instances WHERE user_id = ?', u.id)?.state === 'running') throw new Error(`${u.handle}'s wisp is running: put it to sleep from their account page, or stop the grid, then try again.`);
  const { createAccounts } = await import('./accounts.ts');
  const { deleteBox } = await import('./hostd.ts');
  const accounts = createAccounts({ db, cfg, secrets: createSecrets(db, { dataDir: cfg.dataDir }) });
  accounts.setDisabled(u.id, true);
  try {
    await deleteBox({ dataDir: cfg.dataDir, driver: cfg.hostd.driver, container: cfg.hostd.container ?? {}, user: u });
  } catch (err) {
    accounts.setDisabled(u.id, !!u.disabled);
    throw err;
  }
  const { createSites } = await import('./sites.ts');
  const sites = createSites({ db, cfg });
  sites.removeAll(u.id);
  sites.close();
  accounts.remove(u.id);
  io.out(`  ✓ deleted ${what}`);
  return 0;
}

const day = (t: number | null | undefined): string => (t ? new Date(t).toISOString().slice(0, 10) : '');

export async function waitlist(cfg: GridConfig, io: Io): Promise<number> {
  return withDb(cfg, (db) => {
    // Reading only: nothing here writes an audit row.
    const seats = createSeats({ db, cfg, audit: () => {} });
    const s = seats.seats();
    // Invited: a seat is held for them (auth.seats.holdDays); write to say it's there.
    const state = (r: { joined_at: number | null; invited_at: number | null }): string => (r.joined_at ? `joined ${day(r.joined_at)}` : r.invited_at ? `invited ${day(r.invited_at)}` : 'waiting');
    io.out(`  seats: ${s.max ?? 'no cap'}${s.auto ? ' (auto)' : ''}, ${s.left ?? '∞'} free`);
    io.out(seats.waitlist().map((r) => `${r.email.padEnd(36)} ${r.source.padEnd(7)} ${day(r.created_at)}  ${state(r)}`).join('\n') || 'Nobody is waiting.');
    // People with a seat who want more: another machine, a bigger one, a GPU (their account page).
    const more = seats.machineWishes();
    if (more.length) io.out(`\n  wanting more machines:\n${more.map((r) => `${r.handle.padEnd(20)} ${String(r.email || '').padEnd(30)} ${r.wants.padEnd(17)} ${day(r.created_at)}${r.note ? `  “${r.note}”` : ''}`).join('\n')}`);
    return 0;
  });
}
