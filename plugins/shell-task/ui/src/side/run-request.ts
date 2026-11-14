// Run app from a task's menu (v1 panel.js runApp): the Preview opens and starts the app with its command (the
// worktree's `run`, else the guess from package.json). The menu leaves the request here; the task's Preview, mounted or
// already open, takes it once it knows the command and nothing runs or failed there.
import { signal } from '@wisp/client';

/** the task (its bare id) whose app was asked to run */
export const runRequest = signal<string | undefined>(undefined);

/** The row's mark (wisp.terminal's `ext["wisp.terminal"].run`): its app is running. */
export function appRunning(row: { readonly ext?: Readonly<Record<string, unknown>> } | undefined): boolean {
  const run = (row?.ext?.['wisp.terminal'] as { run?: { running?: boolean } } | undefined)?.run;
  return run?.running === true;
}
