// "Add a project" from a repo URL: clone it into a folder. A folder there that already is this repo is
// reused; any other one gets a -2, -3… suffix. GitHub repos go through `gh repo clone` when gh is
// there, so private repos work with the user's gh login; otherwise (or if gh fails) plain git.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseRepo, sameRepo } from '@wisp-plugin/git-api';
import { type Tools, quiet } from './exec.ts';
import { exists, realpath, repoRoot } from './worktree.ts';

const bad = (message: string): Error => Object.assign(new Error(message), { code: 'invalid', status: 400 });

export async function cloneRepo(t: Tools, url: string, parent: string, { timeoutMs = 10 * 60_000 }: { timeoutMs?: number } = {}): Promise<{ dir: string; existed: boolean }> {
  const repo = parseRepo(url, { shorthand: true });
  if (!repo) throw bad(`Not a repo URL: ${url}`);
  await fs.mkdir(parent, { recursive: true });
  let dir = path.join(parent, repo.name);
  for (let n = 2; await exists(dir); n++) {
    const origin = await quiet(t.git(dir, ['remote', 'get-url', 'origin']));
    const top = await repoRoot(t, dir);
    if (origin && top && (await realpath(top)) === (await realpath(dir)) && sameRepo(origin, repo.url)) return { dir, existed: true };
    dir = path.join(parent, `${repo.name}-${n}`);
  }
  const attempts: (() => Promise<string>)[] = [];
  if (repo.gh) {
    const gh = repo.gh;
    attempts.push(() => t.gh(parent, ['repo', 'clone', gh, dir], { timeoutMs }));
  }
  attempts.push(() => t.git(parent, ['clone', '--quiet', repo.url, dir], { timeoutMs }));
  let last: unknown;
  for (const attempt of attempts) {
    try {
      await attempt();
      return { dir, existed: false };
    } catch (err) {
      last = err;
      await fs.rm(dir, { recursive: true, force: true }); // a half clone would block the next try
    }
  }
  const what = repo.gh ?? repo.url;
  const why = last instanceof Error ? last.message : String(last);
  if (/not found|does not exist|could not read username|authentication|permission denied|403/i.test(why))
    throw bad(`Couldn’t clone ${what}: it doesn’t exist, or this login can’t see it.${repo.gh ? ' Private repo? Check `gh auth status`.' : ''}`);
  throw bad(`Couldn’t clone ${what}: ${why}`);
}
