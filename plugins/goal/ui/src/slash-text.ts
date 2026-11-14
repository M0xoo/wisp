// What a reply reads as a `/goal` (v1 slash-text.js goalAsk, isGoalDrop). Pure: slash.ts acts on it.

export type TypedGoal = { readonly t: 'set'; readonly text: string } | { readonly t: 'drop' } | { readonly t: 'bare' };

/** The `/goal` a reply reads as, or null when it isn't one (`/goals`, `/goal` later in the text). */
export function typedGoal(text: string): TypedGoal | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  if (!rest) return { t: 'bare' };
  return /^(drop|clear|off|none)$/i.test(rest) ? { t: 'drop' } : { t: 'set', text: rest };
}
