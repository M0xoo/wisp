// Issues to start a task from (New task → Issue): a project's open GitHub issues through gh, or the
// Linear issues assigned to you when a Linear connector has an API key (Linear's GraphQL API; no
// sign-in of its own). routes/issues.js serves them. A failure comes back as words the page shows,
// with what fixes it (fix: install | signin | remote | linear), never as a thrown error.
//
//   { source, issues: [{ id, ref, number, title, url, labels, assignee, body, updatedAt }], linear }

import { ns } from './connectors.js';
import { gh, git, parseRepo } from './git.js';

const TTL = 60_000; // a list is good for a minute: the picker opens and is searched often
const BODY_MAX = 4000;
const LIMIT = 50;
const LINEAR_API = () => process.env.WISP_LINEAR_API || 'https://api.linear.app/graphql';

const cache = new Map(); // `${source}:${project}:${q}` -> { at, value }
export const clearIssues = () => cache.clear();

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const body = (s) => clip(String(s || '').replace(/\r\n/g, '\n').trim(), BODY_MAX);
const names = (list) => (list || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

// gh issue list --json number,title,labels,assignees,url,updatedAt,body → one issue.
export function ghIssue(j) {
  const a = j.assignees?.[0];
  return { id: String(j.number), ref: `#${j.number}`, number: j.number, title: String(j.title || ''), url: j.url || '', labels: names(j.labels), assignee: a ? a.login || a.name || '' : '', body: body(j.body), updatedAt: j.updatedAt || null };
}

// A Linear issue node (the query below) → one issue.
export function linearIssue(n) {
  return { id: n.identifier || n.id, ref: n.identifier || '', number: n.identifier || '', title: String(n.title || ''), url: n.url || '', labels: names(n.labels?.nodes), assignee: n.assignee?.displayName || n.assignee?.name || '', body: body(n.description), updatedAt: n.updatedAt || null };
}

// owner/repo of a project: its repo (a clone, or one on another computer), else its folder's origin.
export async function repoOfProject(project, dir) {
  const own = parseRepo(project?.repo || '')?.gh;
  if (own) return own;
  if (!dir) return null;
  const url = await git(dir, ['remote', 'get-url', 'origin'], { timeout: 10_000 }).catch(() => '');
  return parseRepo(url)?.gh || null;
}

// gh's failure, in words with what fixes it.
export function ghProblem(err, repo) {
  const why = String(err?.message || err || '');
  if (err?.code === 'ENOENT') return { error: 'The GitHub CLI (gh) isn’t installed, so wisp can’t list this project’s issues.', fix: 'install' };
  if (/not logged in|gh auth login|authenticat|bad credentials|HTTP 401/i.test(why)) return { error: 'Sign in to GitHub to list this project’s issues.', fix: 'signin' };
  if (/disabled issues/i.test(why)) return { error: `${repo} has issues turned off on GitHub.` };
  if (/could not resolve to a repository|HTTP 404|not found/i.test(why)) return { error: `GitHub doesn’t know ${repo}, or your account can’t see it.`, fix: 'signin' };
  return { error: `gh couldn’t list the issues: ${clip(why, 200)}` };
}

export async function githubIssues(repo, q = '') {
  const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIMIT), '--json', 'number,title,labels,assignees,url,updatedAt,body'];
  if (q) args.push('--search', q);
  const out = await gh(undefined, args, { timeout: 30_000 });
  let list;
  try {
    list = JSON.parse(out || '[]');
  } catch {
    throw new Error('gh answered with something that isn’t a list of issues');
  }
  return (Array.isArray(list) ? list : []).map(ghIssue);
}

// A Linear connector's API key: an env var or header of a connector named or pointing at Linear.
// Its OAuth sign-in is for Linear's MCP server, not this API, so it doesn't count.
export function linearKey(connectors = [], secrets) {
  for (const c of connectors) {
    if (c.enabled === false || !/linear/i.test([c.name, c.url, c.command, ...(c.args || [])].join(' '))) continue;
    const keys = [...(c.env || []).map((k) => `env:${k}`), ...(c.headers || []).map((k) => `header:${k}`)];
    for (const k of keys.sort((a, b) => /key|token|authorization/i.test(b) - /key|token|authorization/i.test(a))) {
      const v = String(secrets?.get(ns(c.id), k) || '').replace(/^Bearer\s+/i, '').trim();
      if (v) return v;
    }
  }
  return null;
}

const LINEAR_QUERY = `query Issues($filter: IssueFilter) {
  viewer { assignedIssues(first: ${LIMIT}, orderBy: updatedAt, filter: $filter) {
    nodes { id identifier title url description updatedAt labels { nodes { name } } assignee { name displayName } }
  } }
}`;

export async function linearIssues(key, q = '', { fetch = globalThis.fetch } = {}) {
  const filter = { state: { type: { nin: ['completed', 'canceled'] } }, ...(q && { title: { containsIgnoreCase: q } }) };
  let r;
  try {
    // A personal API key goes as it is; an OAuth token as a Bearer.
    r = await fetch(LINEAR_API(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key.startsWith('lin_api_') ? key : `Bearer ${key}` },
      body: JSON.stringify({ query: LINEAR_QUERY, variables: { filter } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { error: `Couldn’t reach Linear: ${err.message}` };
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403 || j.errors?.some((e) => /auth/i.test(e.extensions?.code || e.message || ''))) return { error: 'Linear refused the connector’s API key. Check it in Settings → Connectors.', fix: 'linear' };
  if (!r.ok || j.errors?.length) return { error: `Linear couldn’t list your issues: ${clip(j.errors?.[0]?.message || r.statusText, 200)}` };
  return { issues: (j.data?.viewer?.assignedIssues?.nodes || []).map(linearIssue) };
}

// A Jira (Atlassian) connector's site, email and API token, from its env vars or headers (the names
// the Atlassian MCP servers use: JIRA_URL / JIRA_BASE_URL / ATLASSIAN_SITE, JIRA_EMAIL /
// ATLASSIAN_EMAIL, JIRA_API_TOKEN / ATLASSIAN_API_TOKEN).
export function jiraCreds(connectors = [], secrets) {
  for (const c of connectors) {
    if (c.enabled === false || !/jira|atlassian/i.test([c.name, c.url, c.command, ...(c.args || [])].join(' '))) continue;
    const get = (re) => {
      const k = (c.env || []).find((x) => re.test(x));
      return k ? String(secrets?.get(ns(c.id), `env:${k}`) || '').trim() : '';
    };
    const site = get(/^(JIRA_(BASE_)?URL|JIRA_SITE|ATLASSIAN_(SITE|URL))$/i);
    const email = get(/^(JIRA|ATLASSIAN)_(EMAIL|USER(NAME)?)$/i);
    const token = get(/^(JIRA|ATLASSIAN)_API_TOKEN$/i);
    if (site && email && token) return { site: (/^https?:/.test(site) ? site : `https://${site}`).replace(/\/+$/, ''), email, token };
  }
  return null;
}

// Jira issue → one issue. Its description is Atlassian's document format: its text, flattened.
// Blocks (paragraphs, headings, list items) one per line; the text runs inside a block run on.
const BLOCKS = new Set(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'table', 'tableRow']);
const adfText = (n) => (!n ? '' : typeof n === 'string' ? n : n.text || (n.content || []).map(adfText).join(BLOCKS.has(n.type) ? '\n' : ''));
export const jiraIssue = (site) => (i) => ({
  id: `jira:${i.key}`,
  ref: i.key,
  number: i.key,
  title: i.fields?.summary || '',
  url: `${site}/browse/${i.key}`,
  labels: i.fields?.labels || [],
  assignee: i.fields?.assignee?.displayName || '',
  body: clip(adfText(i.fields?.description), 4000),
  updatedAt: i.fields?.updated || '',
});

// The open issues assigned to you on Jira (its REST search, JQL), newest first; q narrows by text.
export async function jiraIssues({ site, email, token }, q = '', { fetch = globalThis.fetch } = {}) {
  const jql = `assignee = currentUser() AND statusCategory != Done${q ? ` AND text ~ "${q.replace(/["\\]/g, ' ')}"` : ''} ORDER BY updated DESC`;
  let r;
  try {
    r = await fetch(`${site}/rest/api/3/search/jql?${new URLSearchParams({ jql, maxResults: String(LIMIT), fields: 'summary,labels,assignee,description,updated' })}`, {
      headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { error: `Couldn’t reach Jira: ${err.message}` };
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) return { error: 'Jira refused the connector’s email and API token. Check them in Settings → Connectors.', fix: 'jira' };
  if (!r.ok) return { error: `Jira couldn’t list your issues: ${clip(j.errorMessages?.[0] || r.statusText, 200)}` };
  return { issues: (j.issues || []).map(jiraIssue(site)) };
}

// The list for the picker. project: a project from the config; dir: its folder on this computer.
export async function listIssues({ source = 'github', project, dir, q = '', connectors, secrets, now = Date.now() }) {
  q = String(q || '').trim().slice(0, 200);
  const key = linearKey(connectors, secrets);
  const linear = !!key;
  const jira = jiraCreds(connectors, secrets);
  const out = (x) => ({ source, issues: [], linear, jira: !!jira, ...x });
  if (source === 'jira' && !jira) return out({ error: 'Connect Jira (a Jira or Atlassian connector with its site, email and API token) to list the issues assigned to you.', fix: 'jira' });
  if (source === 'linear' && !key) return out({ error: 'Connect Linear with an API key to list the issues assigned to you.', fix: 'linear' });
  if (source === 'github' && !project) return out({ error: 'Pick a project to see its issues.', fix: 'project' });
  const id = `${source}:${source === 'github' ? project.id : ''}:${q}`;
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL) return { ...hit.value, linear, jira: !!jira };
  let value;
  if (source === 'linear') value = out(await linearIssues(key, q));
  else if (source === 'jira') value = out(await jiraIssues(jira, q));
  else {
    const repo = await repoOfProject(project, dir);
    if (!repo) return out({ error: `${project.name || 'This project'} has no GitHub remote, so it has no issues to list.`, fix: 'remote' });
    try {
      value = out({ repo, issues: await githubIssues(repo, q) });
    } catch (err) {
      return out({ repo, ...ghProblem(err, repo) });
    }
  }
  // Only a list is kept: after a sign-in, the next look asks again.
  if (!value.error) cache.set(id, { at: now, value });
  if (cache.size > 200) cache.delete(cache.keys().next().value); // searches add up: the oldest goes
  return value;
}
