// The plugin's English catalogue as a `t`, with @wisp/client's rules ({name} placeholders, then
// key.one / key.other for a numeric count), so pure code is tested in the words people read.
import en from '../src/i18n/en.json' with { type: 'json' };

const cat: Readonly<Record<string, string>> = en;

export function t(key: string, vars?: Readonly<Record<string, string | number>>): string {
  const count = vars?.['count'];
  const plural = typeof count === 'number' ? cat[`${key}.${count === 1 ? 'one' : 'other'}`] : undefined;
  const s = plural ?? cat[key];
  if (s === undefined) throw new Error(`missing string ${key}`);
  return vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : m)) : s;
}
