// The GitHub watchers (v1 Triggers.poll, #failedRuns, #labelledIssues), polled through `gh` (the proc
// service) rather than pushed to: wisp listens on localhost, which GitHub can't reach. The first poll
// only records what is already there, so old failures don't fire.

import type { Engine, Started } from './engine.ts';
import { HeldError } from './held.ts';
import type { Trigger } from './types.ts';
import { isObj } from './util.ts';

const MAX_SEEN = 200;
const MAX_PER_POLL = 3; // a burst of failures shouldn't start a dozen agents
const GH_TIMEOUT_MS = 120_000;

interface Item {
  key: string;
  vars: Record<string, unknown>;
}

async function gh(e: Engine, cwd: string, args: readonly string[]): Promise<string> {
  const r = await e.d.proc.exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS });
  if (r.timedOut) throw new Error(`gh ${args.slice(0, 2).join(' ')} timed out`);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `gh exited with ${String(r.code)}`);
  return r.stdout;
}

const list = (text: string): Record<string, unknown>[] => {
  const v = JSON.parse(text || '[]') as unknown;
  return Array.isArray(v) ? v.filter(isObj) : [];
};
const str = (v: unknown): string => (v == null ? '' : String(v));

async function failedRuns(e: Engine, t: Trigger): Promise<Item[]> {
  const args = ['run', 'list', '--status', 'failure', '--limit', '20', '--json', 'databaseId,name,displayTitle,headBranch,headSha,url,event,createdAt'];
  if (t.branch) args.push('--branch', t.branch);
  return list(await gh(e, t.cwd, args)).map((r) => ({
    key: `run:${str(r['databaseId'])}`,
    vars: { id: r['databaseId'], name: str(r['name']) || str(r['displayTitle']) || 'workflow', title: str(r['displayTitle']), branch: str(r['headBranch']), sha: str(r['headSha']).slice(0, 7), url: str(r['url']), event: str(r['event']) },
  }));
}

async function labelledIssues(e: Engine, t: Trigger): Promise<Item[]> {
  const args = ['issue', 'list', '--state', 'open', '--label', t.label, '--limit', '20', '--json', 'number,title,body,url,author'];
  return list(await gh(e, t.cwd, args)).map((i) => ({
    key: `issue:${str(i['number'])}`,
    vars: { number: i['number'], title: str(i['title']), body: str(i['body']).slice(0, 8000), url: str(i['url']), author: isObj(i['author']) ? str(i['author']['login']) : '' },
  }));
}

/** One look at GitHub: fires for what's new (at most 3), or, the first time, only remembers it. */
export async function poll(e: Engine, t: Trigger, { force = false, manual = false } = {}): Promise<Started[]> {
  t.lastPolledAt = e.d.now();
  const items = t.kind === 'ci' ? await failedRuns(e, t) : await labelledIssues(e, t);
  const fresh = items.filter((x) => !t.seen.includes(x.key));
  t.seen = [...fresh.map((x) => x.key), ...t.seen].slice(0, MAX_SEEN);
  if (!t.seeded && !force) {
    t.seeded = true; // first look: remember what's already there, start nothing
    return [];
  }
  t.seeded = true;
  const out: Started[] = [];
  const sent = fresh.slice(0, MAX_PER_POLL);
  for (let i = 0; i < sent.length; i++) {
    const item = sent[i];
    if (!item) continue;
    try {
      out.push(await e.fire(t, item.vars, { manual }));
    } catch (err) {
      // Held for the plan: what's left counts as new again, so a poll after the reset starts it.
      if (err instanceof HeldError) t.seen = t.seen.filter((k) => !sent.slice(i).some((x) => x.key === k));
      throw err;
    }
  }
  return out;
}
