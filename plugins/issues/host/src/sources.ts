// Where issues come from (v1 server/issues.js): GitHub through git.service's gh, Linear's GraphQL API
// and Jira's REST search through the kernel's net service, with each source's answer mapped to one
// Issue shape and each failure put in words with what fixes it.

import type { NetService } from '@wisp/kernel';
import type { GitIssue } from '@wisp-plugin/git-api';
import type { Issue, IssueList } from '@wisp-plugin/issues-api';

export const BODY_MAX = 4000;
export const LIMIT = 50;
const TIMEOUT_MS = 20_000;

type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const body = (s: unknown): string => clip(str(s).replace(/\r\n/g, '\n').trim(), BODY_MAX);
const names = (list: unknown): string[] => (Array.isArray(list) ? list : []).map((l: unknown) => (typeof l === 'string' ? l : str(obj(l)['name']))).filter(Boolean);
const errText = (err: unknown): string => (err instanceof Error ? err.message : str(err));

/** gh issue list --json number,title,labels,assignees,url,updatedAt,body → one issue. */
export function ghIssue(j: GitIssue): Issue {
  const a = j.assignees[0];
  return { id: String(j.number), ref: `#${j.number}`, number: j.number, title: j.title, url: j.url, labels: names(j.labels), assignee: a ? a.login || a.name || '' : '', body: body(j.body), updatedAt: j.updatedAt || null };
}

/** A Linear issue node → one issue. */
export function linearIssue(n: J): Issue {
  const assignee = obj(n['assignee']);
  return { id: str(n['identifier'] || n['id']), ref: str(n['identifier']), number: str(n['identifier']), title: str(n['title']), url: str(n['url']), labels: names(obj(n['labels'])['nodes']), assignee: str(assignee['displayName'] || assignee['name']), body: body(n['description']), updatedAt: str(n['updatedAt']) || null };
}

// Jira's description is Atlassian's document format: its text, flattened. Blocks one per line; the
// text runs inside a block run on.
const BLOCKS = new Set(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'table', 'tableRow']);
export function adfText(n: unknown): string {
  if (!n) return '';
  if (typeof n === 'string') return n;
  const o = obj(n);
  if (o['text']) return str(o['text']);
  const kids = Array.isArray(o['content']) ? o['content'] : [];
  return kids.map(adfText).join(BLOCKS.has(str(o['type'])) ? '\n' : '');
}

export const jiraIssue =
  (site: string) =>
  (i: J): Issue => {
    const f = obj(i['fields']);
    const key = str(i['key']);
    return { id: `jira:${key}`, ref: key, number: key, title: str(f['summary']), url: `${site}/browse/${key}`, labels: names(f['labels']), assignee: str(obj(f['assignee'])['displayName']), body: clip(adfText(f['description']), BODY_MAX), updatedAt: str(f['updated']) };
  };

/** gh's failure, in words with what fixes it. `missing`: gh isn't installed (v1: err.code ENOENT). */
export function ghProblem(err: unknown, repo: string): Pick<IssueList, 'error' | 'fix'> {
  const why = errText(err);
  const missing = (typeof err === 'object' && err !== null && (err as J)['missing'] === true) || (err as J | null)?.['code'] === 'ENOENT';
  if (missing) return { error: 'The GitHub CLI (gh) isn’t installed, so wisp can’t list this project’s issues.', fix: 'install' };
  if (/not logged in|gh auth login|authenticat|bad credentials|HTTP 401/i.test(why)) return { error: 'Sign in to GitHub to list this project’s issues.', fix: 'signin' };
  if (/disabled issues/i.test(why)) return { error: `${repo} has issues turned off on GitHub.` };
  if (/could not resolve to a repository|HTTP 404|not found/i.test(why)) return { error: `GitHub doesn’t know ${repo}, or your account can’t see it.`, fix: 'signin' };
  return { error: `gh couldn’t list the issues: ${clip(why, 200)}` };
}

/** A connector as the key lookups read it: what it runs and the names of its env vars and headers. */
export interface ConnectorKeys {
  id: string;
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: string[];
  headers?: string[];
  enabled?: boolean;
}

/** A connector's secret: `env:NAME` or `header:NAME`, as wisp.connectors keeps them. */
export type SecretOf = (connector: string, key: string) => Promise<string | undefined>;

const about = (c: ConnectorKeys): string => [c.name, c.url, c.command, ...(c.args ?? [])].join(' ');
const secretish = (k: string): number => Number(/key|token|authorization/i.test(k));

/**
 * A Linear connector's API key: an env var or header of a connector named or pointing at Linear. Its
 * OAuth sign-in is for Linear's MCP server, not this API, so it doesn't count.
 */
export async function linearKey(connectors: readonly ConnectorKeys[], secret: SecretOf): Promise<string | null> {
  for (const c of connectors) {
    if (c.enabled === false || !/linear/i.test(about(c))) continue;
    const keys = [...(c.env ?? []).map((k) => `env:${k}`), ...(c.headers ?? []).map((k) => `header:${k}`)];
    for (const k of keys.sort((a, b) => secretish(b) - secretish(a))) {
      const v = ((await secret(c.id, k)) ?? '').replace(/^Bearer\s+/i, '').trim();
      if (v) return v;
    }
  }
  return null;
}

export interface JiraCreds {
  site: string;
  email: string;
  token: string;
}

/** A Jira (Atlassian) connector's site, email and API token, by the names the Atlassian MCP servers use. */
export async function jiraCreds(connectors: readonly ConnectorKeys[], secret: SecretOf): Promise<JiraCreds | null> {
  for (const c of connectors) {
    if (c.enabled === false || !/jira|atlassian/i.test(about(c))) continue;
    const get = async (re: RegExp): Promise<string> => {
      const k = (c.env ?? []).find((x) => re.test(x));
      return k ? ((await secret(c.id, `env:${k}`)) ?? '').trim() : '';
    };
    const site = await get(/^(JIRA_(BASE_)?URL|JIRA_SITE|ATLASSIAN_(SITE|URL))$/i);
    const email = await get(/^(JIRA|ATLASSIAN)_(EMAIL|USER(NAME)?)$/i);
    const token = await get(/^(JIRA|ATLASSIAN)_API_TOKEN$/i);
    if (site && email && token) return { site: (/^https?:/.test(site) ? site : `https://${site}`).replace(/\/+$/, ''), email, token };
  }
  return null;
}

const LINEAR_QUERY = `query Issues($filter: IssueFilter) {
  viewer { assignedIssues(first: ${LIMIT}, orderBy: updatedAt, filter: $filter) {
    nodes { id identifier title url description updatedAt labels { nodes { name } } assignee { name displayName } }
  } }
}`;

export const linearApi = (env: Readonly<Record<string, string | undefined>> = process.env): string => env['WISP_LINEAR_API'] || 'https://api.linear.app/graphql';

type Found = Pick<IssueList, 'error' | 'fix'> & { issues?: Issue[] };

/** The Linear issues assigned to you, open ones; q narrows by title. */
export async function linearIssues(net: NetService, key: string, q = '', url: string = linearApi()): Promise<Found> {
  const filter = { state: { type: { nin: ['completed', 'canceled'] } }, ...(q && { title: { containsIgnoreCase: q } }) };
  let r: Response;
  try {
    // A personal API key goes as it is; an OAuth token as a Bearer.
    r = await net.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key.startsWith('lin_api_') ? key : `Bearer ${key}` },
      body: JSON.stringify({ query: LINEAR_QUERY, variables: { filter } }),
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    return { error: `Couldn’t reach Linear: ${errText(err)}` };
  }
  const j = obj(await r.json().catch(() => ({})));
  const errors = Array.isArray(j['errors']) ? j['errors'].map(obj) : [];
  if (r.status === 401 || r.status === 403 || errors.some((e) => /auth/i.test(str(obj(e['extensions'])['code'] || e['message'])))) return { error: 'Linear refused the connector’s API key. Check it in Settings → Connectors.', fix: 'linear' };
  if (!r.ok || errors.length) return { error: `Linear couldn’t list your issues: ${clip(str(errors[0]?.['message'] || r.statusText), 200)}` };
  const nodes = obj(obj(obj(j['data'])['viewer'])['assignedIssues'])['nodes'];
  return { issues: (Array.isArray(nodes) ? nodes : []).map(obj).map(linearIssue) };
}

/** The open issues assigned to you on Jira (its REST search, JQL), newest first; q narrows by text. */
export async function jiraIssues(net: Pick<NetService, 'fetch'>, { site, email, token }: JiraCreds, q = ''): Promise<Found> {
  const jql = `assignee = currentUser() AND statusCategory != Done${q ? ` AND text ~ "${q.replace(/["\\]/g, ' ')}"` : ''} ORDER BY updated DESC`;
  let r: Response;
  try {
    r = await net.fetch(`${site}/rest/api/3/search/jql?${new URLSearchParams({ jql, maxResults: String(LIMIT), fields: 'summary,labels,assignee,description,updated' }).toString()}`, {
      headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    return { error: `Couldn’t reach Jira: ${errText(err)}` };
  }
  const j = obj(await r.json().catch(() => ({})));
  if (r.status === 401 || r.status === 403) return { error: 'Jira refused the connector’s email and API token. Check them in Settings → Connectors.', fix: 'jira' };
  const messages = Array.isArray(j['errorMessages']) ? j['errorMessages'] : [];
  if (!r.ok) return { error: `Jira couldn’t list your issues: ${clip(str(messages[0] || r.statusText), 200)}` };
  return { issues: (Array.isArray(j['issues']) ? j['issues'] : []).map(obj).map(jiraIssue(site)) };
}
