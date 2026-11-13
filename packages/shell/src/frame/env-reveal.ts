// Which masked .env views a task shows as they are (v1 web/js/env-mask.js `shown`): a step's output, a code or diff
// block. Kept per task for this tab's life, so a refresh, a new turn or opening the task again doesn't hide them;
// Hide or a reload does. Masking itself follows the task's wisp's `git.maskEnvFiles` (Settings → Privacy, on unless
// switched off), the same setting wisp-git masks Changes by.
import { createSignal } from 'solid-js';
import { entityKey, ownerOf, type EntityKey, type SettingRow } from '@wisp/client';
import { useSignal, type EnvReveal } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';

const shownByTask = new Map<string, ReadonlySet<string>>();
// one signal for every task's views: a flip is rare, and each reader filters to its own id
const [version, bump] = createSignal(0);

export const envShown = (task: string, id: string): boolean => (version(), shownByTask.get(task)?.has(id) ?? false);

export function setEnvShown(task: string, id: string, on: boolean): void {
  const s = new Set(shownByTask.get(task));
  if (on) s.add(id);
  else s.delete(id);
  shownByTask.set(task, s);
  bump((n) => n + 1);
}

/** The setting as v1 read it: anything but 'off' (or false) is on. */
export const maskIsOn = (value: unknown): boolean => !(value === false || value === 'off');

/** A task's reveal state, its ids scoped by `prefix` (a turn's answer: `<turn>:`). Call while the view sets up. */
export function envReveal(shell: ShellContext, key: EntityKey, prefix: string): EnvReveal {
  const row = useSignal(shell.client.entities.row<SettingRow>('setting', entityKey(ownerOf(key), 'git.maskEnvFiles')));
  return {
    on: () => maskIsOn(row()?.value),
    shown: (id) => envShown(key, prefix + id),
    set: (id, on) => setEnvShown(key, prefix + id, on),
  };
}
