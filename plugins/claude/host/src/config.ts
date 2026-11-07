// What Claude Code keeps on disk that wisp reads or writes (v1 adapters/claude.js): where its binary
// lives off PATH, its .claude.json (Chrome default, folder trust), its saved conversations, and the
// Console profile `claude auth status` names. All async; nothing here runs on a parser's path.

import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProcService } from '@wisp/kernel';
import { quietOutput, rec } from '@wisp/harness-kit';

type Env = Record<string, string | undefined>;

const newestFirst = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  } catch {
    return [];
  }
};

/**
 * Where claude lives when it isn't on PATH: the native installer's folders (an app started from the
 * Dock never reads the shell profile that adds them), then the copies the Claude desktop app
 * downloads for its Code tab into <userData>/claude-code/<version>/<sha12>/ (older builds: straight
 * into <version>/; macOS builds may wrap it in claude.app), newest version first. That copy is
 * signed in only while the app runs it, so on its own it needs one sign-in.
 */
export async function fallbackBins(env: Env = process.env, home = os.homedir(), platform: string = process.platform): Promise<string[]> {
  const win = platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const local = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
  // The app's userData: a direct install, then the two Store (MSIX) packages, whose AppData writes
  // land in their own LocalCache.
  const userData: string[] =
    platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Claude')]
      : win
        ? [path.join(env['APPDATA'] || path.join(home, 'AppData', 'Roaming'), 'Claude'), ...['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'].map((p) => path.join(local, 'Packages', p, 'LocalCache', 'Roaming', 'Claude'))]
        : [];
  const desktop: string[] = [];
  for (const d of userData) {
    const root = path.join(d, 'claude-code');
    for (const v of await newestFirst(root)) {
      for (const h of await newestFirst(path.join(root, v))) desktop.push(path.join(root, v, h, exe), path.join(root, v, h, 'claude.app', 'Contents', 'MacOS', 'claude'));
      desktop.push(path.join(root, v, exe));
    }
  }
  return [path.join(home, '.local', 'bin', exe), ...(win ? [] : [path.join(home, '.claude', 'local', 'claude')]), ...desktop];
}

const claudeJson = (env: Env): string => (env['CLAUDE_CONFIG_DIR'] ? path.join(env['CLAUDE_CONFIG_DIR'], '.claude.json') : path.join(os.homedir(), '.claude.json'));

/**
 * Claude in Chrome turns itself on only in interactive sessions; `-p` needs --chrome. Follow the
 * user's own "enabled by default" choice (/chrome in Claude Code) so a wisp run gets the same tools.
 * WISP_CLAUDE_CHROME=1/0 overrides it.
 */
export async function chromeEnabled(env: Env = process.env): Promise<boolean> {
  if (env['WISP_CLAUDE_CHROME']) return env['WISP_CLAUDE_CHROME'] !== '0';
  try {
    return rec(JSON.parse(await readFile(claudeJson(env), 'utf8')))['claudeInChromeDefaultEnabled'] === true;
  } catch {
    return false;
  }
}

export const realDir = (dir: string): Promise<string> => realpath(dir).catch(() => path.resolve(dir));

/**
 * Interactive claude won't start in a folder nobody has said "Yes, I trust this folder" for (`-p`
 * skips the question, so runs never see it). Take over opens it in folders wisp made itself, a
 * scratch folder or a worktree, so say yes for it in .claude.json: projects[dir].hasTrustDialogAccepted,
 * what the dialog writes. Under claude's own lock (<file>.lock, a directory), so a running claude
 * saving its config at the same moment doesn't lose either write.
 */
export async function trustFolder(dir: string, env: Env = process.env): Promise<void> {
  const file = claudeJson(env);
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    return; // never run: its first start asks more than this anyway
  }
  const key = await realDir(dir);
  const lock = `${real}.lock`;
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) {
    try {
      await mkdir(lock);
      locked = true;
    } catch {
      await sleep(25); // awaited, at most 40 × 25 ms: it never outlives the call (no scope needed)
    }
  }
  try {
    const cfg = rec(JSON.parse(await readFile(real, 'utf8')));
    const projects = rec(cfg['projects']);
    if (rec(projects[key])['hasTrustDialogAccepted']) return;
    cfg['projects'] = { ...projects, [key]: { ...rec(projects[key]), hasTrustDialogAccepted: true } };
    const tmp = `${real}.wisp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: (await stat(real)).mode });
    await rename(tmp, real);
  } catch {
    // Unreadable config: claude asks, as before.
  } finally {
    if (locked) await rm(lock, { recursive: true, force: true });
  }
}

const projectsDir = (env: Env): string => path.join(env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude'), 'projects');
const projectName = (real: string): string => real.replace(/[^a-zA-Z0-9]/g, '-');
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * Whether claude kept conversation id: one that exited at a start-up question never saved it. Kept in
 * <config>/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl; every project is looked
 * through too, in case that naming changes.
 */
export async function hasSession(id: string, cwd: string, env: Env = process.env): Promise<boolean> {
  const root = projectsDir(env);
  const file = `${id}.jsonl`;
  if (cwd && (await exists(path.join(root, projectName(await realDir(cwd)), file)))) return true;
  try {
    for (const d of await readdir(root)) if (await exists(path.join(root, d, file))) return true;
  } catch {}
  return false;
}

/**
 * The newest conversation kept for this folder, or null. Names and sizes only: nothing here opens a
 * transcript, and it never looks in another project's folder. agent-*.jsonl are subagents'.
 */
export async function latestSession(cwd: string, env: Env = process.env): Promise<string | null> {
  const dir = path.join(projectsDir(env), projectName(await realDir(cwd)));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: string | null = null;
  let at = -1;
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
    try {
      const st = await stat(path.join(dir, name));
      if (st.isFile() && st.size > 0 && st.mtimeMs > at) [best, at] = [name.slice(0, -'.jsonl'.length), st.mtimeMs];
    } catch {} // gone since the readdir
  }
  return best;
}

/**
 * Signed in through a Console profile (`ant auth login`, or a keyless Console sign-in): Claude Code
 * takes it when the claude.ai login stops working (or ANTHROPIC_PROFILE names one) and bills the
 * Console org. stream-json never says (apiKeySource is `none` for a login and a profile alike), so
 * the sign is `claude auth status --text`'s `Profile:` line, read from the CLI's own output only.
 * A line ending in `· not in use` is a profile on disk the run doesn't bill to.
 */
export const profileIn = (text: unknown): string => {
  const line = /^[ \t]*Profile:[ \t]*(\S[^\r\n]*)/m.exec(String(text || ''))?.[1]?.trim() ?? '';
  return /·\s*not in use$/i.test(line) ? '' : line;
};

const AUTH_TTL_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;

/**
 * Once a minute per account folder, beside the run and never in its way: a failure or a CLI that
 * takes longer than AUTH_TIMEOUT_MS reads as no profile.
 */
export function profileCache(proc: ProcService, bin: () => string): { profile(env: Env, now: number): Promise<string>; forget(): void } {
  const seen = new Map<string, { at: number; said: Promise<string> }>(); // account folder (+ ANTHROPIC_PROFILE)
  return {
    profile(env, now) {
      const key = `${env['CLAUDE_CONFIG_DIR'] || ''}\0${env['ANTHROPIC_PROFILE'] || ''}`;
      const hit = seen.get(key);
      if (hit && now - hit.at < AUTH_TTL_MS) return hit.said;
      const said = quietOutput(proc, bin(), ['auth', 'status', '--text'], AUTH_TIMEOUT_MS, env).then(profileIn, () => '');
      seen.set(key, { at: now, said });
      return said;
    },
    forget: () => seen.clear(),
  };
}
