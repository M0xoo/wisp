// The PR pane, DOM-free (v1 features/panel.js paintPr, verdict, checksHtml, talkHtml, filesHtml): the one
// sentence about where the PR stands with its one next step, the checks (failing and running first, the passed
// folded behind one line), the reviewers, the conversation (live threads and people; outdated threads and bots
// folded) and the files (8, then "and N more"). Reads `ship.details` (wisp.ship's PrPanel, camelCase).

export interface CheckItem {
  readonly name: string;
  readonly workflow?: string;
  /** fail | pending | pass | skip */
  readonly state: string;
  readonly url?: string;
  readonly ms?: number | null;
}
export interface PrNote {
  readonly kind?: string;
  readonly state?: string;
  readonly author: string;
  readonly bot?: boolean;
  readonly body: string;
  readonly at?: number | null;
  readonly url?: string;
}
export interface PrThread {
  readonly path: string;
  readonly line?: number | null;
  readonly outdated?: boolean;
  readonly notes: readonly PrNote[];
}
export interface PrPanel {
  readonly repo?: string;
  readonly number: number;
  readonly url: string;
  readonly title?: string;
  readonly state: string;
  readonly draft?: boolean;
  readonly review?: string;
  readonly conflict?: boolean;
  readonly branch?: string;
  readonly base?: string;
  readonly mergedAt?: string | null;
  readonly checks?: { readonly fail?: number; readonly pending?: number; readonly pass?: number };
  readonly checkedAt?: number;
  readonly author?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly files?: readonly { readonly path: string; readonly additions: number; readonly deletions: number }[];
  readonly checkList?: readonly CheckItem[];
  readonly reviewers?: readonly { readonly author: string; readonly state: string }[];
  readonly notes?: readonly PrNote[];
  readonly threads?: readonly PrThread[];
  readonly error?: string;
}

export type Tone = 'merged' | 'closed' | 'fail' | 'pending' | 'draft' | 'pass';
export interface Verdict {
  readonly tone: Tone;
  readonly key: string;
  readonly vars?: Readonly<Record<string, string | number>>;
  readonly act?: 'merge' | 'fix';
  readonly primary?: boolean;
}

/** Where the PR stands, in one sentence, and its one next step (v1 verdict, less the cross-review line). */
export function verdict(p: PrPanel, o: { readonly fixing?: boolean; readonly canFix?: boolean } = {}): Verdict {
  const c = p.checks ?? {};
  const base = p.base || 'main';
  if (p.state === 'MERGED') return { tone: 'merged', key: 'shell-task.pr.merged', vars: { base } };
  if (p.state === 'CLOSED') return { tone: 'closed', key: 'shell-task.pr.closed' };
  if (p.conflict) return o.fixing ? { tone: 'pending', key: 'shell-task.pr.fixing' } : { tone: 'fail', key: 'shell-task.pr.conflict', vars: { base }, ...(o.canFix && { act: 'fix' as const }) };
  const changes = (p.reviewers ?? []).find((r) => r.state === 'CHANGES_REQUESTED');
  if (c.fail) return { tone: 'fail', key: 'shell-task.pr.failing', vars: { count: c.fail } };
  if (changes) return { tone: 'fail', key: 'shell-task.pr.changes', vars: { name: changes.author } };
  if (c.pending) return { tone: 'pending', key: 'shell-task.pr.waiting', vars: { count: c.pending }, act: 'merge' };
  if (p.draft) return { tone: 'draft', key: 'shell-task.pr.draft', act: 'merge' };
  if (p.review === 'REVIEW_REQUIRED') return { tone: 'pending', key: 'shell-task.pr.needsReview', act: 'merge' };
  return { tone: 'pass', key: 'shell-task.pr.ready', act: 'merge', primary: true };
}

/** Failing and running checks first; the passed and skipped behind one line unless nothing is wrong. */
export function checkGroups(list: readonly CheckItem[]): { bad: CheckItem[]; ok: CheckItem[]; passed: number; skipped: number; okOpen: boolean } {
  const bad = list.filter((c) => c.state === 'fail' || c.state === 'pending');
  const ok = list.filter((c) => c.state === 'pass' || c.state === 'skip');
  const passed = ok.filter((c) => c.state === 'pass').length;
  return { bad, ok, passed, skipped: ok.length - passed, okOpen: bad.length === 0 };
}

/** "1m 12s" for a check's run. */
export function dur(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A comment's gist: no HTML comments, images or tags, at most `max` characters (v1 gist). */
export function gist(body: string, max = 420): string {
  const t = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** The conversation: live threads, people's notes; outdated threads and bots folded (counted). Empty notes go. */
export function talk(p: PrPanel): { live: PrThread[]; outdated: PrThread[]; people: PrNote[]; bots: PrNote[] } {
  const notes = (p.notes ?? []).filter((n) => String(n.body || '').trim());
  const threads = (p.threads ?? []).filter((t) => t.notes.length > 0);
  return { live: threads.filter((t) => !t.outdated), outdated: threads.filter((t) => t.outdated), people: notes.filter((n) => !n.bot), bots: notes.filter((n) => n.bot) };
}

/** The files by path, the first 8 unless all are asked for; `more` counts the rest (GitHub's count when larger). */
export function prFiles(p: PrPanel, all: boolean): { shown: { path: string; additions: number; deletions: number }[]; more: number } {
  const files = [...(p.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const shown = all ? files : files.slice(0, 8);
  return { shown, more: Math.max(0, (p.changedFiles || files.length) - shown.length) };
}
