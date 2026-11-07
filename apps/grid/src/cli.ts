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
//   wisp grid waitlist   who's waiting for a seat, who has one held (to write to), and the seats
//
// apps/server's CLI hands `wisp grid <args>` to gridCli; main.ts runs it on its own. The command
// line runs once and outside any request, so sync fs here is fine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOXD } from './boxd.ts';
import { backup, doctor, rotateKey, users, waitlist, type Io } from './cli-ops.ts';
import { loadConfig, writeConfig, type GridConfig } from './config.ts';
import { ensureMaster, masterFile } from './secrets.ts';

export type { Io } from './cli-ops.ts';

export const GRID_HELP = `usage:
  wisp grid dev [--port 8080] [--fake-agents] [--idle 120]   try it on this computer (dev sign-in)
  wisp grid init --domain wisp.example.com [--data DIR]       set up a real grid
  wisp grid serve [--data DIR]                                run it
  wisp grid doctor [--data DIR]                               check the setup
  wisp grid rotate-key | backup [file] | users [--data DIR]
  wisp grid users --delete HANDLE --yes [--data DIR]         delete an account, its box and files
  wisp grid waitlist [--data DIR]                             who's waiting for a seat, who has one held

  Data: --data DIR, or GRID_DATA (default ~/.wisp-grid). Guide: apps/grid/README.md`;

/** Every subcommand. apps/server's CLI keeps its own copy (importing this would load the grid); a test keeps them equal. */
export const GRID_COMMANDS: ReadonlySet<string> = new Set(['dev', 'init', 'serve', 'doctor', 'rotate-key', 'backup', 'users', 'waitlist', 'help']);

export interface GridOpts {
  _: string[];
  fakeAgents?: boolean;
  yes?: boolean;
  [flag: string]: string | boolean | string[] | undefined;
}

export function opts(args: readonly string[]): GridOpts {
  const o: GridOpts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--fake-agents') o.fakeAgents = true;
    else if (a === '--yes') o.yes = true;
    else if (a.startsWith('--')) o[a.slice(2).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = args[++i];
    else o._.push(a);
  }
  return o;
}
const flag = (o: GridOpts, k: string): string | undefined => (typeof o[k] === 'string' ? o[k] : undefined);

// Agents that answer without an account (wisp's test doubles), on PATH for dev grids: the testkit's
// once it ships one, else v1's fixture while v1 is still in the repo.
const FAKES = ['../../../packages/testkit/src/fake-agent.mjs', '../../../test/fixtures/fake-agent.mjs'].map((p) => new URL(p, import.meta.url).pathname);
function fakeBins(dir: string): string {
  const fake = FAKES.find((f) => fs.existsSync(f));
  if (!fake) throw new Error('--fake-agents needs a checkout of the wisp repo (test/fixtures).');
  const bin = path.join(dir, 'fake-bin');
  const lib = path.join(bin, 'node_modules', 'fake');
  fs.mkdirSync(lib, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode', 'cursor-agent', 'agy', 'grok']) {
    fs.copyFileSync(fake, path.join(lib, `${name}.mjs`));
    const exe = path.join(bin, name);
    fs.writeFileSync(exe, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(path.join(lib, `${name}.mjs`)).href)});\n`);
    fs.chmodSync(exe, 0o755);
  }
  return bin;
}

/** What `serve` needs of grid.ts's startGrid (fork-independent: only this much is relied on). */
export interface RunningGrid {
  close(): Promise<void>;
}
type StartGrid = (cfg: GridConfig) => Promise<RunningGrid>;
// A specifier the type checker doesn't follow: the CLI loads the whole grid only to serve it.
const GRID_MODULE: string = './grid.ts';

async function loadStart(): Promise<StartGrid> {
  const mod: unknown = await import(GRID_MODULE);
  const start = typeof mod === 'object' && mod !== null ? (mod as { startGrid?: unknown }).startGrid : undefined;
  if (typeof start !== 'function') throw new Error('apps/grid/src/grid.ts has no startGrid.');
  return start as StartGrid;
}

export async function serve(cfg: GridConfig, io: Io = { out: (m) => console.log(m) }): Promise<RunningGrid> {
  const g = await (await loadStart())(cfg);
  const providers = Object.keys(cfg.auth.providers).concat(cfg.auth.dev ? ['dev'] : []);
  io.out(`\n  ◌ ${cfg.name} at ${cfg.publicUrl}`);
  io.out(`    users get <handle>.${cfg.domain}${cfg.portSuffix} · sign-in: ${providers.join(', ') || 'none set up'} · hostd: ${cfg.hostd.driver}, idle stop after ${Math.round(cfg.hostd.idleMs / 1000)}s`);
  io.out(`    data: ${cfg.dataDir}\n`);
  const stop = async (): Promise<void> => {
    io.out('  stopping: every user’s wisp, then the grid…');
    await g.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return g;
}

function devConfig(o: GridOpts, dataDir: string | undefined): GridConfig {
  const dir = path.resolve(dataDir || path.join(os.homedir(), '.wisp-grid-dev'));
  const port = Number(flag(o, 'port')) || 8080;
  // Previews too: its loopback is this computer's, and it's only you.
  const hostd: Record<string, unknown> = { idleMs: (Number(flag(o, 'idle')) || 120) * 1000, previews: true };
  if (o.fakeAgents) Object.assign(hostd, { path: fakeBins(dir), env: { FAKE_DELAY: flag(o, 'fakeDelay') || '1500' } });
  const cfg = loadConfig({ dataDir: dir, overrides: { domain: flag(o, 'domain') || 'wisp.localhost', scheme: 'http', listen: { host: flag(o, 'host') || 'loopback', port }, auth: { dev: true }, hostd, name: 'wisp Grid (dev)' } });
  ensureMaster(dir);
  return cfg;
}

// The grid.json `wisp grid init` writes: GitHub and Google ready to fill in, boxes through boxd
// when it runs (deploy/install.sh sets it up), else 'process' until isolation is set up (README).
function initConfig(o: GridOpts, dir: string, domain: string): GridConfig {
  const hostd = fs.existsSync(BOXD.socket) ? { driver: 'container', container: { boxd: BOXD.socket }, idleMs: 300_000, checkMs: 5_000, maxRunning: 50 } : { driver: 'process', idleMs: 300_000, checkMs: 5_000, maxRunning: 50 };
  const port = Number(flag(o, 'port')) || 8080;
  const cfg = {
    dataDir: dir,
    file: path.join(dir, 'grid.json'),
    name: flag(o, 'name') || 'wisp Grid',
    domain,
    scheme: 'https',
    listen: { host: '127.0.0.1', port },
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
    hostd,
    sessionDays: 30,
  };
  // Written as is: writeConfig drops the derived fields, which a fresh grid.json doesn't have yet.
  return cfg as unknown as GridConfig;
}

async function init(o: GridOpts, dataDir: string | undefined, io: Io): Promise<number> {
  const dir = path.resolve(dataDir || path.join(os.homedir(), '.wisp-grid'));
  if (fs.existsSync(path.join(dir, 'grid.json')) && !flag(o, 'force')) throw new Error(`${dir}/grid.json is already there (--force to overwrite).`);
  const domain = flag(o, 'domain');
  if (!domain) throw new Error('--domain: where the grid answers, e.g. --domain wisp.example.com (users get <handle>.wisp.example.com).');
  const cfg = initConfig(o, dir, domain);
  await writeConfig(cfg);
  ensureMaster(dir);
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true, mode: 0o700 });
  io.out(`  ✓ wrote ${cfg.file} and ${masterFile(dir)} (0600)\n
  Next:
  1. DNS: point ${domain} and *.${domain} at this server.
  2. TLS: put Caddy in front (apps/grid/deploy/Caddyfile): it gets certificates per name and asks the grid first.
  3. Sign-in: create OAuth apps, then in grid.json set clientId and "enabled": true, and write each secret to its file (chmod 600):
       GitHub  callback URL  https://${domain}/auth/github/callback   secret → ${path.join(dir, 'secrets/github-oauth')}
       Google  redirect URI  https://${domain}/auth/google/callback   secret → ${path.join(dir, 'secrets/google-oauth')}
  4. wisp grid doctor --data ${dir}
  5. wisp grid serve --data ${dir}   (apps/grid/deploy/wisp-grid.service runs it under systemd)
  Users' boxes: ${cfg.hostd.driver === 'container' ? `containers, through boxd (${BOXD.socket})` : 'processes (no isolation): see apps/grid/README.md → Isolation'}`);
  return 0;
}

/**
 * `wisp grid <args>`. Resolves with the exit code once the command is done (for serve and dev:
 * once the grid answers; it then runs until SIGINT/SIGTERM). Throws an Error whose message is for
 * the person at the terminal.
 */
export async function gridCli(args: readonly string[], io: Io = { out: (m) => console.log(m) }): Promise<number> {
  const o = opts(args);
  const cmd = o._[0] || 'help';
  const dataDir = flag(o, 'data') || process.env['GRID_DATA'];
  if (cmd === 'help' || !GRID_COMMANDS.has(cmd)) {
    io.out(GRID_HELP);
    return 0;
  }
  if (cmd === 'dev') return serve(devConfig(o, dataDir), io).then(() => 0);
  if (cmd === 'init') return init(o, dataDir, io);
  if (cmd === 'serve') return serve(loadConfig(dataDir ? { dataDir } : {}), io).then(() => 0);
  const cfg = (): GridConfig => loadConfig(dataDir ? { dataDir } : {});
  if (cmd === 'doctor') return doctor(dataDir, io);
  if (cmd === 'rotate-key') return rotateKey(cfg(), io);
  if (cmd === 'backup') return backup(cfg(), o._[1], io);
  if (cmd === 'users') return users(cfg(), { delete: flag(o, 'delete'), yes: !!o.yes }, io);
  return waitlist(cfg(), io);
}
