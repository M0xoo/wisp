// t('key'): this plugin's strings (src/i18n/en.json for the rail, section, member page and pick;
// en.more.json for kit, notebook, record, share/import, team and org), registered with the client through the
// catalogue in index.ts). PluginClient has no `t` yet, so the lookup is local and follows
// @wisp/client's rules: `{name}` placeholders, and `key.one` / `key.other` with a numeric `count`.
// Keys are typed: a missing string fails typecheck.

import core from './i18n/en.json' with { type: 'json' };
import more from './i18n/en.more.json' with { type: 'json' };

const en = { ...core, ...more };
type Raw = keyof typeof core | keyof typeof more;
type Base<K> = K extends `${infer B}.one` ? B : K extends `${infer B}.other` ? B : K;
export type Key = Base<Raw> | Raw;
export type Vars = Readonly<Record<string, string | number>>;

export const catalogue: Readonly<Record<string, string>> = en;

const fill = (s: string, vars: Vars | undefined): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : m)) : s;

export function t(key: Key, vars?: Vars): string {
  const count = vars?.['count'];
  const plural = typeof count === 'number' ? catalogue[`${key}.${count === 1 ? 'one' : 'other'}`] : undefined;
  return fill(plural ?? catalogue[key] ?? key, vars);
}
