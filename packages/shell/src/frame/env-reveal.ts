// Which masked .env views a task shows as they are (v1 web/js/env-mask.js `shown`): a step's output, a code or diff
// block. Kept per task for this tab's life, so a refresh, a new turn or opening the task again doesn't hide them;
// Hide or a reload does. Masking itself follows the task's wisp's `git.maskEnvFiles` (Settings → Privacy, on unless
// switched off), the same setting wisp-git masks Changes by. The server masks before anything leaves (ADR-0050):
// Reveal asks it for the one item (`runtime.unmasked`), kept here for the tab's life; Hide drops it.
import { createSignal } from 'solid-js';
import { entityKey, ownerOf, type EntityKey, type SettingRow } from '@wisp/client';
import { useSignal, type EnvReveal } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import { unmasked } from './commands.ts';

type Raw = Readonly<Record<string, unknown>>;
const shownByTask = new Map<string, ReadonlySet<string>>();
const rawByTask = new Map<string, ReadonlyMap<string, Raw>>();
// one signal for every task's views: a flip is rare, and each reader filters to its own id
const [version, bump] = createSignal(0);

export const envShown = (task: string, id: string): boolean => (version(), shownByTask.get(task)?.has(id) ?? false);
export const envRaw = (task: string, id: string): Raw | undefined => (version(), rawByTask.get(task)?.get(id));

export function setEnvShown(task: string, id: string, on: boolean): void {
  const s = new Set(shownByTask.get(task));
  if (on) s.add(id);
  else s.delete(id);
  shownByTask.set(task, s);
  if (!on) setEnvRaw(task, id, undefined);
  bump((n) => n + 1);
}

function setEnvRaw(task: string, id: string, raw: Raw | undefined): void {
  const m = new Map(rawByTask.get(task));
  if (raw) m.set(id, raw);
  else m.delete(id);
  rawByTask.set(task, m);
}

/** What a view's id asks the server for: `step:<seq>`, `block:<index>`, `file:<path>`. */
export function askOf(id: string): { step: number } | { block: number } | { file: string } | undefined {
  const at = id.indexOf(':');
  const [kind, rest] = [id.slice(0, at), id.slice(at + 1)];
  if (kind === 'file' && rest) return { file: rest };
  const n = Number(rest);
  if (!Number.isInteger(n) || n < 0 || rest === '') return undefined;
  return kind === 'step' ? { step: n } : kind === 'block' ? { block: n } : undefined;
}

/** The setting as v1 read it: anything but 'off' (or false) is on. */
export const maskIsOn = (value: unknown): boolean => !(value === false || value === 'off');

/** A task's reveal state, its ids scoped by `prefix` (a turn's answer: `<turn>:`). Call while the view sets up. */
export function envReveal(shell: ShellContext, key: EntityKey, prefix: string): EnvReveal {
  const row = useSignal(shell.client.entities.row<SettingRow>('setting', entityKey(ownerOf(key), 'git.maskEnvFiles')));
  const turnId = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
  const ask = (id: string): void => {
    const what = askOf(id);
    if (!what || !turnId) return;
    shell.client.commands.run(unmasked, { id: key, turnId, ...what }).then(
      (raw) => {
        if (!envShown(key, prefix + id)) return; // hidden again before it came
        setEnvRaw(key, prefix + id, raw);
        bump((n) => n + 1);
      },
      (e: unknown) => {
        setEnvShown(key, prefix + id, false);
        shell.toast.error(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return {
    on: () => maskIsOn(row()?.value),
    shown: (id) => envShown(key, prefix + id),
    set: (id, on) => {
      setEnvShown(key, prefix + id, on);
      if (on && !envRaw(key, prefix + id)) ask(id);
    },
    raw: (id) => envRaw(key, prefix + id),
  };
}
