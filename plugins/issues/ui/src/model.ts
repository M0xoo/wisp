// Start a task from an issue (v1 web/js/features/issues.js), DOM-free: what the picker lists for a source (the
// project's open GitHub issues, or the Linear / Jira issues assigned to you), the other sources under them (or how
// to connect them), the problem line with its fix, and the prompt a picked issue writes. Nothing starts until you
// send it.

export type Source = 'github' | 'linear' | 'jira';

export interface Issue {
  readonly id: string;
  readonly ref: string;
  readonly number: number | string;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly assignee: string;
  readonly body: string;
  readonly updatedAt?: string | null;
}

/** `issues.list`'s answer. */
export interface IssueList {
  readonly source: Source;
  readonly issues: readonly Issue[];
  readonly linear: boolean;
  readonly jira: boolean;
  readonly repo?: string;
  readonly error?: string;
  readonly fix?: string;
  readonly scope?: string;
}

type T = (k: string, vars?: Readonly<Record<string, string | number>>) => string;

/** What an issue starts: what to do, the link, then what it says. */
export const issuePrompt = (i: Pick<Issue, 'ref' | 'title' | 'url' | 'body'>): string => `Fix ${i.ref}: ${i.title}\n\n${i.url}${i.body.trim() ? `\n\n${i.body.trim()}` : ''}`;

/** The list's heading. */
export function groupOf(source: Source, r: Pick<IssueList, 'repo' | 'scope'> | undefined, t: T): string {
  if (source === 'linear') return r?.scope === 'all' ? t('issues.group.linearAll') : t('issues.group.linear');
  if (source === 'jira') return t('issues.group.jira');
  return r?.repo ? t('issues.group.repo', { repo: r.repo }) : t('issues.group.open');
}

/** The line when nothing is open. */
export function emptyLine(source: Source, r: Pick<IssueList, 'repo'> | undefined, name: string, t: T): string {
  if (source === 'linear') return t('issues.empty.linear');
  if (source === 'jira') return t('issues.empty.jira');
  return t('issues.empty.github', { name: r?.repo || name });
}

export type Other = { kind: 'source'; source: Source; label: string; icon: 'github' | 'issue' } | { kind: 'connect'; source: 'linear' | 'jira'; label: string; sub: string; icon: 'plug' };

/** The other places issues come from, under the list: GitHub for the project, then Linear and Jira (or Connect…). */
export function others(source: Source, r: Pick<IssueList, 'linear' | 'jira'> | undefined, project: { id: string; name: string }, t: T): Other[] {
  const out: Other[] = [];
  if (source !== 'github' && project.id) out.push({ kind: 'source', source: 'github', label: t('issues.other.github', { name: project.name || t('issues.thisProject') }), icon: 'github' });
  if (source !== 'linear')
    out.push(
      r?.linear
        ? { kind: 'source', source: 'linear', label: t('issues.other.linear'), icon: 'issue' }
        : { kind: 'connect', source: 'linear', label: t('issues.connect.linear'), sub: t('issues.connect.linearSub'), icon: 'plug' },
    );
  if (source !== 'jira')
    out.push(
      r?.jira
        ? { kind: 'source', source: 'jira', label: t('issues.other.jira'), icon: 'issue' }
        : { kind: 'connect', source: 'jira', label: t('issues.connect.jira'), sub: t('issues.connect.jiraSub'), icon: 'plug' },
    );
  return out;
}

/** The button a problem offers (the server's `fix`), as an i18n key; unknown fixes offer none. */
export const fixLabel = (fix: string | undefined): string | undefined => (fix && ['signin', 'install', 'linear', 'jira', 'retry'].includes(fix) ? `issues.fix.${fix}` : undefined);

/** Narrow the list as you type (the server searches past the newest 50): the ref, title, labels and assignee. */
export function matches(i: Issue, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [i.ref, String(i.number), i.title, ...i.labels, i.assignee].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The picker's overlay view and its params (New task's Issue button: the launcher's project). */
export const PICKER = 'issues.picker';

export interface PickerParams {
  readonly project: string;
  readonly name: string;
  readonly source: Source;
}

export function parsePicker(p: unknown): PickerParams {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const source = o['source'] === 'linear' || o['source'] === 'jira' ? o['source'] : 'github';
  return { project: typeof o['project'] === 'string' ? o['project'] : '', name: typeof o['name'] === 'string' ? o['name'] : '', source };
}
