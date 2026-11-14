// The Repo tab (ADR-0033 "A repo's history has its own place"), DOM-free: the repo's tracked tasks grouped by
// month, newest first, each row's line (who, which agent, the PR or commits it made), and the prompt Resume sends
// (as `wisp resume` writes it: carry on from the report, on today's code).

export interface RepoTask {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly by: string;
  readonly createdAt: number;
  readonly pr: string;
  readonly commits: number;
  readonly files: number;
  readonly level: string;
  readonly path: string;
}

type T = (k: string, vars?: Readonly<Record<string, string | number>>) => string;

/** Month groups, newest first: "November 2026" (the label from `month`), each with its tasks newest first. */
export function byMonth(list: readonly RepoTask[], month: (at: number) => string): { label: string; tasks: RepoTask[] }[] {
  const out: { label: string; tasks: RepoTask[] }[] = [];
  for (const t of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    const label = month(t.createdAt);
    const g = out.at(-1);
    if (g && g.label === label) g.tasks.push(t);
    else out.push({ label, tasks: [t] });
  }
  return out;
}

/** The row's second line: who, the agent, then the PR or how many commits. */
export function repoLine(r: RepoTask, t: T): string {
  const made = r.pr ? r.pr : r.commits ? t('history.commits', { count: r.commits }) : '';
  return [r.by, r.agent, made].filter(Boolean).join(' · ');
}

/** Resume (v1-less, ADR-0033): a new task that carries on from where that one stopped, on today's code. */
export function resumePrompt(title: string, asked: string, report: string): string {
  return `Carry on with an earlier task: "${title}".\n\nWhat was asked then:\n${asked}\n\nWhat happened (its report):\n${report.slice(0, 6000)}\n\nPick it up from there, on the code as it is today.`;
}
