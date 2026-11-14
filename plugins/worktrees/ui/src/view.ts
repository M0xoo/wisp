// The Done folders dialog's params and title (the overlay view `worktrees.folders`): read eagerly by the shell,
// so they're here and the dialog itself loads on first use.
import { t } from './i18n.ts';

export interface DoneParams {
  /** the task marked done: its entity key (`<peer>:<id>`) */
  readonly key: string;
  /** Remove took the clean ones: these hold work */
  readonly only: boolean;
  /** how many rows (the title's count, the placeholders) */
  readonly n: number;
}

export function parseDone(p: unknown): DoneParams {
  const o = (p ?? {}) as Partial<DoneParams>;
  if (typeof o.key !== 'string' || !o.key.includes(':')) throw new Error('worktrees.folders: no task');
  return { key: o.key, only: o.only === true, n: typeof o.n === 'number' && o.n > 0 ? o.n : 1 };
}

/** Remove its worktree? / Remove its 3 worktrees? / This worktree holds work */
export const doneTitle = (p: DoneParams): string => t(p.only ? 'worktrees.folders.holds' : 'worktrees.folders.ask', { count: p.n });
