// An extra account's login folder (v1 accounts.js prepare): it links to everything in the CLI's own
// folder except the login, so settings, skills, MCP servers and transcripts stay the same on every
// account, and a task can move to another of your accounts. Cheap enough to run before every run,
// so links a CLI replaced (an atomic write turns a link into a file) are mended. Async: it runs on
// the runner's path. The folders stay where v1 put them (plan §4.8): the CLIs own them.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountsSpec } from './harnesses.ts';

export interface PrepareOptions {
  spec: AccountsSpec;
  /** the CLI's own folder */
  base: string;
  /** the account's folder */
  dir: string;
  platform: string;
  env: Record<string, string | undefined>;
  userHome: string;
}

const lstat = (p: string) => fs.lstat(p).catch(() => undefined);

export async function prepare(o: PrepareOptions): Promise<void> {
  await fs.mkdir(o.dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(o.base, { recursive: true });
  // The folders transcripts live in exist first, so a link to them is never dangling.
  for (const d of o.spec.dirs ?? []) await fs.mkdir(path.join(o.base, d), { recursive: true });
  const own = new Set(o.spec.own);
  for (const name of await fs.readdir(o.base)) {
    if (own.has(name) || /\.(lock|tmp)$/.test(name) || name.startsWith('.tmp')) continue;
    await link(path.join(o.base, name), path.join(o.dir, name), o.platform);
  }
  await o.spec.sync?.({ dir: o.dir, base: o.base, env: o.env, userHome: o.userHome });
}

async function link(target: string, at: string, platform: string): Promise<void> {
  const st = await lstat(at);
  if (st?.isSymbolicLink()) {
    if ((await fs.readlink(at)) === target) return;
    await fs.unlink(at);
  } else if (st?.isFile()) {
    // The CLI replaced the link with a file of its own (a settings change made on this account):
    // the newer of the two wins, then it's a link again.
    try {
      if (st.mtimeMs > (await fs.stat(target)).mtimeMs) await fs.copyFile(at, target);
    } catch {
      // the target went away: the link below says so
    }
    await fs.unlink(at);
  } else if (st) return; // a real folder: leave it alone
  const isDir = (await fs.stat(target)).isDirectory();
  await fs.symlink(target, at, isDir ? (platform === 'win32' ? 'junction' : 'dir') : 'file');
}

/** Removes an account's folder: only what's in it, links are removed, never followed. */
export async function removeFolder(root: string, dir: string): Promise<void> {
  if (dir.startsWith(root + path.sep)) await fs.rm(dir, { recursive: true, force: true });
}
