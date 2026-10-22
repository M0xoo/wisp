// `wisp grid …`: run wisp for many people on your own server.
//
//   wisp grid dev        on this computer: http://wisp.localhost:8080, dev sign-in (any email),
//                        --fake-agents for agents that need no account
//   wisp grid init       write grid.json and the master key for a real deployment
//   wisp grid serve      run it (sign-in, the edge, hostd) from grid.json
//   wisp grid doctor     check the setup: Node, config, keys, DNS, providers
//   wisp grid rotate-key a new master key; re-wraps every user's data key
//   wisp grid backup     a consistent copy of the database
//   wisp grid users      who's here; --delete <handle> --yes deletes one, box and files included

import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOXD, CONTAINER, boxdCall } from './boxd.js';
import { loadConfig, writeConfig } from './config.js';
import { addMasterKey, createSecrets, ensureMaster, masterFile, pruneMasterKeys } from './secrets.js';

export const GRID_HELP = `usage:
  wisp grid dev [--port 8080] [--fake-agents] [--idle 120]   try it on this computer (dev sign-in)
  wisp grid init --domain wisp.example.com [--data DIR]       set up a real grid
  wisp grid serve [--data DIR]                                run it
  wisp grid doctor [--data DIR]                               check the setup
  wisp grid rotate-key | backup [file] | users [--data DIR]
  wisp grid users --delete HANDLE --yes [--data DIR]         delete an account, its box and files

  Data: --data DIR, or GRID_DATA (default ~/.wisp-grid). Guide: grid/README.md`;

export const GRID_COMMANDS = new Set(['dev', 'init', 'serve', 'doctor', 'rotate-key', 'backup', 'users', 'help']);

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fake-agents') o.fakeAgents = true;
    else if (a === '--yes') o.yes = true;
    else if (a.startsWith('--')) o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = args[++i];
    else o._.push(a);
  }
  return o;
}

const FAKE = fileURLToPath(new URL('../test/fixtures/fake-agent.mjs', import.meta.url));
// Agents that answer without an account (wisp's test doubles), on PATH for dev grids.
function fakeBins(dir) {
  if (!fs.existsSync(FAKE)) throw new Error('--fake-agents needs a checkout of the wisp repo (test/fixtures).');
  const bin = path.join(dir, 'fake-bin');
  const lib = path.join(bin, 'node_modules', 'fake');
  fs.mkdirSync(lib, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode', 'cursor-agent', 'agy', 'grok']) {
    fs.copyFileSync(FAKE, path.join(lib, `${name}.mjs`));
    const exe = path.join(bin, name);
    fs.writeFileSync(exe, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(path.join(lib, `${name}.mjs`)).href)});\n`);
    fs.chmodSync(exe, 0o755);
  }
  return bin;
}

async function serve(cfg) {
  const { startGrid } = await import('./server.js');
  const g = await startGrid(cfg);
  const providers = Object.keys(cfg.auth.providers).concat(cfg.auth.dev ? ['dev'] : []);
  console.log(`\n  ◌ ${cfg.name} at ${cfg.publicUrl}`);
  console.log(`    users get <handle>.${cfg.domain}${cfg.portSuffix} · sign-in: ${providers.join(', ') || 'none set up'} · hostd: ${cfg.hostd.driver}, idle stop after ${Math.round(cfg.hostd.idleMs / 1000)}s`);
  console.log(`    data: ${cfg.dataDir}\n`);
  const stop = async () => {
    console.log('  stopping: every user’s wisp, then the grid…');
    await g.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return g;
}

export async function gridCli(args) {
  const o = opts(args);
  const cmd = o._[0] || 'help';
  const dataDir = o.data || process.env.GRID_DATA;

  if (cmd === 'help' || !GRID_COMMANDS.has(cmd)) return console.log(GRID_HELP);

  if (cmd === 'dev') {
    const dir = path.resolve(dataDir || path.join(os.homedir(), '.wisp-grid-dev'));
    const port = Number(o.port) || 8080;
    const hostd = { idleMs: (Number(o.idle) || 120) * 1000 };
    if (o.fakeAgents) Object.assign(hostd, { path: fakeBins(dir), env: { FAKE_DELAY: o.fakeDelay || '1500' } });
    const cfg = loadConfig({ dataDir: dir, overrides: { domain: o.domain || 'wisp.localhost', scheme: 'http', listen: { host: o.host || 'loopback', port }, auth: { dev: true }, hostd, name: 'wisp Grid (dev)' } });
    ensureMaster(dir);
    return serve(cfg);
  }

  if (cmd === 'init') {
    const dir = path.resolve(dataDir || path.join(os.homedir(), '.wisp-grid'));
    if (fs.existsSync(path.join(dir, 'grid.json')) && !o.force) throw new Error(`${dir}/grid.json is already there (--force to overwrite).`);
    if (!o.domain) throw new Error('--domain: where the grid answers, e.g. --domain wisp.example.com (users get <handle>.wisp.example.com).');
    const cfg = {
      dataDir: dir,
      file: path.join(dir, 'grid.json'),
      name: o.name || 'wisp Grid',
      domain: o.domain,
      scheme: 'https',
      listen: { host: '127.0.0.1', port: Number(o.port) || 8080 },
      publicPort: 443,
      auth: {
        providers: {
          github: { clientId: 'FROM github.com/settings/developers', clientSecretFile: 'secrets/github-oauth', enabled: false },
          google: { clientId: 'FROM console.cloud.google.com → Credentials', clientSecretFile: 'secrets/google-oauth', enabled: false },
        },
        signup: 'open',
        allow: { emails: [], domains: [], githubOrgs: [] },
        admins: [],
      },
      // boxd running (grid/deploy/install.sh sets it up): containers through it. Else 'process',
      // until you set up isolation (grid/README.md).
      hostd: fs.existsSync(BOXD.socket) ? { driver: 'container', container: { boxd: BOXD.socket }, idleMs: 300_000, checkMs: 5_000, maxRunning: 50 } : { driver: 'process', idleMs: 300_000, checkMs: 5_000, maxRunning: 50 },
      sessionDays: 30,
    };
    writeConfig(cfg);
    ensureMaster(dir);
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true, mode: 0o700 });
    console.log(`  ✓ wrote ${cfg.file} and ${masterFile(dir)} (0600)\n
  Next:
  1. DNS: point ${o.domain} and *.${o.domain} at this server.
  2. TLS: put Caddy in front (grid/deploy/Caddyfile): it gets certificates per name and asks the grid first.
  3. Sign-in: create OAuth apps, then in grid.json set clientId and "enabled": true, and write each secret to its file (chmod 600):
       GitHub  callback URL  https://${o.domain}/auth/github/callback   secret → ${path.join(dir, 'secrets/github-oauth')}
       Google  redirect URI  https://${o.domain}/auth/google/callback   secret → ${path.join(dir, 'secrets/google-oauth')}
  4. wisp grid doctor --data ${dir}
  5. wisp grid serve --data ${dir}   (grid/deploy/wisp-grid.service runs it under systemd)
  Users' boxes: ${cfg.hostd.driver === 'container' ? `containers, through boxd (${BOXD.socket})` : 'processes (no isolation): see grid/README.md → Isolation'}`);
    return;
  }

  if (cmd === 'serve') return serve(loadConfig({ dataDir }));

  if (cmd === 'doctor') {
    const ok = (m) => console.log(`  ✓ ${m}`);
    const no = (m) => {
      console.log(`  ✗ ${m}`);
      process.exitCode = 1;
    };
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node.js ${process.version}`);
    else no(`Node.js ${process.version}: the grid needs 22.13 or newer`);
    let cfg;
    try {
      cfg = loadConfig({ dataDir });
      ok(`config ${cfg.file}`);
    } catch (err) {
      return no(err.message);
    }
    try {
      const { openDb } = await import('./db.js');
      const db = await openDb(cfg.dataDir);
      createSecrets(db, { dataDir: cfg.dataDir });
      ok('master key readable, permissions 0600');
      db.close();
    } catch (err) {
      no(err.message);
    }
    const provs = Object.keys(cfg.auth.providers);
    if (provs.length) ok(`sign-in: ${provs.join(', ')} (redirect URIs: ${provs.map((p) => `${cfg.publicUrl}/auth/${p}/callback`).join(', ')})`);
    else if (cfg.auth.dev) ok('sign-in: dev only (any email): not for real users');
    else no('sign-in: no provider enabled in grid.json (github, google or oidc:<name>)');
    for (const name of [cfg.domain, `check-${Date.now().toString(36)}.${cfg.domain}`]) {
      if (/(^|\.)localhost$/.test(name)) {
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
    if (cfg.scheme !== 'https' && !/(^|\.)localhost$/.test(cfg.domain)) no('scheme is http on a real domain: sign-in cookies and device tokens would travel in the clear');
    if (cfg.hostd.driver === 'process') console.log('  ! hostd driver "process": users share one OS user. Fine for you and people you trust; not isolation.');
    if (cfg.hostd.driver === 'container') {
      const c = { ...CONTAINER, ...cfg.hostd.container };
      let runtime = c.runtime;
      if (c.boxd) {
        try {
          const r = await boxdCall(c.boxd, { op: 'ping' }, { timeout: 5000 });
          runtime = r.runtime;
          ok(`boxd at ${c.boxd}: boxes in ${r.boxes}, image ${r.image}, runtime ${r.runtime || 'runc'}`);
        } catch (err) {
          no(err.message);
        }
      } else console.log('  ! hostd runs docker itself: the grid’s user is root in effect, and the boxes’ homes (agent logins) sit in its data folder. Set up boxd (grid/README.md → Isolation).');
      if (process.getuid?.() === c.uid && runtime !== 'runsc') console.log(`  ! the grid runs as uid ${c.uid}, the boxes’ user: without gVisor it could look into them. Give the grid its own user (useradd --system).`);
    }
    return;
  }

  if (cmd === 'rotate-key') {
    const cfg = loadConfig({ dataDir });
    const kid = addMasterKey(cfg.dataDir);
    const { openDb } = await import('./db.js');
    const db = await openDb(cfg.dataDir);
    const n = createSecrets(db, { dataDir: cfg.dataDir }).rewrap();
    const inUse = new Set(db.all('SELECT DISTINCT kid FROM keys').map((r) => r.kid));
    const gone = pruneMasterKeys(cfg.dataDir, inUse);
    db.close();
    console.log(`  ✓ new master key ${kid}; re-wrapped ${n} user key${n === 1 ? '' : 's'}; retired ${gone.join(', ') || 'none'}`);
    return;
  }

  if (cmd === 'backup') {
    const cfg = loadConfig({ dataDir });
    const { openDb } = await import('./db.js');
    const db = await openDb(cfg.dataDir);
    const file = path.resolve(o._[1] || path.join(cfg.dataDir, 'backups', `grid-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db.backup(file);
    db.close();
    console.log(`  ✓ ${file}\n    Keep it with ${masterFile(cfg.dataDir)}: without the master key the users' secrets in it can't be read.`);
    return;
  }

  if (cmd === 'users') {
    const cfg = loadConfig({ dataDir });
    const { openDb } = await import('./db.js');
    const db = await openDb(cfg.dataDir);
    if (o.delete) {
      try {
        return await deleteUser(cfg, db, String(o.delete).toLowerCase(), o.yes);
      } finally {
        db.close();
      }
    }
    const rows = db.all('SELECT u.handle, u.email, u.created_at, i.state, (SELECT group_concat(provider) FROM identities WHERE user_id = u.id) AS via FROM users u LEFT JOIN instances i ON i.user_id = u.id ORDER BY u.created_at');
    db.close();
    console.log(rows.map((r) => `${r.handle.padEnd(20)} ${String(r.email || '').padEnd(30)} ${String(r.via || '').padEnd(14)} ${r.state || 'stopped'}`).join('\n') || 'No users yet.');
  }
}

// `wisp grid users --delete <handle> --yes`: the same as Delete on their account page.
async function deleteUser(cfg, db, handle, yes) {
  const u = db.get('SELECT * FROM users WHERE handle = ?', handle);
  if (!u) throw new Error(`Nobody here is called ${handle}.`);
  const what = `${u.handle}${u.email ? ` (${u.email})` : ''}: their box, its files and their agents’ sign-ins, their secrets, sessions and devices`;
  if (!yes) return console.log(`  This deletes ${what}.\n  To go ahead: wisp grid users --delete ${u.handle} --yes`);
  // A process can only be stopped by the grid that started it.
  if (cfg.hostd.driver === 'process' && db.get('SELECT state FROM instances WHERE user_id = ?', u.id)?.state === 'running') throw new Error(`${u.handle}'s wisp is running: put it to sleep from their account page, or stop the grid, then try again.`);
  const { createAccounts } = await import('./accounts.js');
  const { deleteBox } = await import('./hostd.js');
  const accounts = createAccounts({ db, cfg, secrets: createSecrets(db, { dataDir: cfg.dataDir }) });
  accounts.setDisabled(u.id, true);
  try {
    await deleteBox({ dataDir: cfg.dataDir, driver: cfg.hostd.driver, container: cfg.hostd.container, user: u });
  } catch (err) {
    accounts.setDisabled(u.id, !!u.disabled);
    throw err;
  }
  accounts.remove(u.id);
  console.log(`  ✓ deleted ${what}`);
}
