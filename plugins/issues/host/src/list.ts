// The picker's list (v1 listIssues): one source's open issues, cached for a minute per (source,
// project, words), at most 200 searches kept. Only a list is kept: after a sign-in, the next look
// asks again.

import type { NetService } from '@wisp/kernel';
import { parseRepo } from '@wisp-plugin/git-api';
import type { GitService } from '@wisp-plugin/git-api';
import type { IssueList, IssueSource } from '@wisp-plugin/issues-api';
import { type ConnectorKeys, LIMIT, type SecretOf, ghIssue, ghProblem, jiraCreds, jiraIssues, linearApi, linearIssues, linearKey } from './sources.ts';

const TTL = 60_000; // the picker opens and is searched often
const CACHE_MAX = 200;

/** The project as the list needs it: its id and name, its repo URL, and its folder here. */
export interface ProjectRef {
  id: string;
  name: string;
  repo?: string;
  dir: string | null;
}

export interface IssuesDeps {
  git: () => GitService;
  net: () => NetService;
  connectors: () => Promise<ConnectorKeys[]>;
  secret: SecretOf;
  now: () => number;
  env?: Readonly<Record<string, string | undefined>>;
}

/** owner/repo of a project: its repo (a clone, or one on another computer), else its folder's origin. */
export async function repoOfProject(git: GitService, project: Pick<ProjectRef, 'repo'> | null, dir: string | null): Promise<string | null> {
  const own = parseRepo(project?.repo ?? '')?.gh;
  if (own) return own;
  if (!dir) return null;
  try {
    const repo = await git.repo(dir);
    try {
      return parseRepo(await repo.remoteUrl('origin'))?.gh ?? null;
    } finally {
      repo.dispose();
    }
  } catch {
    return null; // not a repo (any more)
  }
}

export function createIssues(d: IssuesDeps): { list(o: { source?: IssueSource; project: ProjectRef | null; q?: string }): Promise<IssueList>; clear(): void } {
  const cache = new Map<string, { at: number; value: IssueList }>();

  async function github(project: ProjectRef, q: string, out: (x: Partial<IssueList>) => IssueList): Promise<IssueList> {
    const git = d.git();
    const repo = await repoOfProject(git, project, project.dir);
    if (!repo) return out({ error: `${project.name || 'This project'} has no GitHub remote, so it has no issues to list.`, fix: 'remote' });
    try {
      return out({ repo, issues: (await git.issues(repo, q, LIMIT)).map(ghIssue) });
    } catch (err) {
      return out({ repo, ...ghProblem(err, repo) });
    }
  }

  async function list({ source = 'github', project, q: words = '' }: { source?: IssueSource; project: ProjectRef | null; q?: string }): Promise<IssueList> {
    const q = String(words || '').trim().slice(0, 200);
    const connectors = await d.connectors().catch(() => []);
    const key = await linearKey(connectors, d.secret);
    const jira = await jiraCreds(connectors, d.secret);
    const linear = !!key;
    const out = (x: Partial<IssueList>): IssueList => ({ source, issues: [], linear, jira: !!jira, ...x });
    if (source === 'jira' && !jira) return out({ error: 'Connect Jira (a Jira or Atlassian connector with its site, email and API token) to list the issues assigned to you.', fix: 'jira' });
    if (source === 'linear' && !key) return out({ error: 'Connect Linear with an API key to list the issues assigned to you.', fix: 'linear' });
    if (source === 'github' && !project) return out({ error: 'Pick a project to see its issues.', fix: 'project' });
    const now = d.now();
    const id = `${source}:${source === 'github' ? (project?.id ?? '') : ''}:${q}`;
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL) return { ...hit.value, linear, jira: !!jira };
    let value: IssueList;
    if (source === 'linear' && key) value = out(await linearIssues(d.net(), key, q, linearApi(d.env)));
    else if (source === 'jira' && jira) value = out(await jiraIssues(d.net(), jira, q));
    else if (project) value = await github(project, q, out);
    else return out({ error: 'Pick a project to see its issues.', fix: 'project' });
    if (!value.error) cache.set(id, { at: now, value });
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value; // searches add up: the oldest goes
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  }

  return { list, clear: () => cache.clear() };
}
