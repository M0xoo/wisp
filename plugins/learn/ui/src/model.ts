// Settings → Memory (v1 settings.js learn, memory modal), DOM-free: the line under "Remembered", the scopes in
// order (every project first, then each project by its folder's name), and an edit to one list.

export type Kind = 'preferences' | 'lessons';
export interface Lists {
  readonly preferences: readonly string[];
  readonly lessons: readonly string[];
  readonly updatedAt?: number;
}
export interface Change {
  readonly text: string;
  readonly kind: Kind;
  readonly scope: string;
}
export interface Retro {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly project: string;
  readonly agent: string;
  readonly turns: number;
  readonly at: number;
  readonly status: 'learned' | 'nothing' | 'failed' | (string & {});
  readonly added: readonly Change[];
  readonly removed: readonly Change[];
  readonly error?: string | null;
}
export interface View {
  readonly global: Lists;
  readonly projects: Readonly<Record<string, Lists>>;
  readonly history: readonly Retro[];
  readonly enabled: boolean;
}

export const count = (l: Lists): number => l.preferences.length + l.lessons.length;

/** "Nothing yet · last retro 5m", "12 things · last retro 2h", or just the count when no retro ran. */
export function rememberedLine(v: View, ago: (at: number) => string, t: (k: string, vars?: Readonly<Record<string, string | number>>) => string): string {
  const n = count(v.global) + Object.values(v.projects).reduce((s, l) => s + count(l), 0);
  const last = v.history.at(-1);
  const what = n === 0 ? t('learn.nothing') : t('learn.things', { count: n });
  return last ? `${what} · ${t('learn.lastRetro', { when: ago(last.at) })}` : what;
}

/** The scopes to show: every project first, then those with something, by folder name. */
export function scopes(v: View): { scope: string; name: string; lists: Lists }[] {
  const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  return [
    { scope: 'global', name: '', lists: v.global },
    ...Object.entries(v.projects)
      .filter(([, l]) => count(l) > 0)
      .map(([scope, lists]) => ({ scope, name: base(scope), lists }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/** A list after removing item `i`, or adding `text` (trimmed, not twice). */
export const without = (items: readonly string[], i: number): string[] => items.filter((_, k) => k !== i);
export function withItem(items: readonly string[], text: string): string[] {
  const x = text.trim();
  return !x || items.includes(x) ? [...items] : [...items, x];
}
