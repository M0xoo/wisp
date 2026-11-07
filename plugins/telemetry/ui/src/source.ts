// A setting as a Settings row reads it (@wisp/ui's SettingSource), from @wisp/client's settings
// store. Two ways in:
//   fromStore(typed, key)   a key this plugin declared (client.settings(decls)): typed, with locks
//   fromRow(client, key)    any key, from the home peer's `setting` row (plan §4.1: setting(key,
//                           value, locked_by)); written with `settings.set`, whose optimistic patch
//                           shows the change at once
// v1 stored switches as 'on' / 'off' strings: onOff() reads either form and writes the string.
// A refused write rolls back and the shell's onError shows the toast, so set() never throws here.
// (Copied verbatim into each Settings pane package: a plugin ui can't import another's.)

import { computed, entityKey, setSetting, type Json, type PluginClient, type SettingDecl, type SettingRow, type TypedSettings } from '@wisp/client';
import type { SettingSource } from '@wisp/ui';

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the rollback toast comes from the client's onError
};

export function fromStore<const D extends readonly SettingDecl[], K extends D[number]['key']>(s: TypedSettings<D>, key: K): SettingSource<Json> {
  return {
    value: s.get(key) as () => Json,
    lockedBy: s.lockedBy(key) as () => string | undefined,
    set: (v) => quiet(s.set(key, v as never)),
  };
}

/** The `setting` row for `key` on this client's own wisp (`client.home`). */
export function fromRow(client: PluginClient, key: string, fallback: Json = null): SettingSource<Json> {
  const row = client.entities.row<SettingRow>('setting', entityKey(client.home, key));
  return {
    value: computed(() => (row()?.value ?? fallback) as Json),
    lockedBy: computed(() => row()?.locked_by ?? undefined),
    set: (value) => quiet(client.run(setSetting, { peer: client.home, key, value })),
  };
}

/** A switch over an 'on' / 'off' setting (or a boolean one). `dflt`: what unset means. */
export function onOff(s: SettingSource<Json>, dflt: boolean): SettingSource<boolean> {
  const read = (v: Json): boolean => (v === true || v === 'on' ? true : v === false || v === 'off' ? false : dflt);
  return {
    value: computed(() => read((s.value as () => Json)())),
    ...(s.lockedBy && { lockedBy: s.lockedBy }),
    set: (on) => s.set(on ? 'on' : 'off'),
  };
}

/** A text or enum setting as a string; `dflt` when unset. */
export function text(s: SettingSource<Json>, dflt: string): SettingSource<string> {
  return {
    value: computed(() => {
      const v = (s.value as () => Json)();
      return typeof v === 'string' && v !== '' ? v : dflt;
    }),
    ...(s.lockedBy && { lockedBy: s.lockedBy }),
    set: (v) => s.set(v),
  };
}
