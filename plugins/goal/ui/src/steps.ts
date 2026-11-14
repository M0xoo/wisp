// A check's steps as its record holds them (a task turn's activity), read for the page's rail. Pure.
import type { IconName } from '@wisp/ui/pure';
import type { RunStep } from './types.ts';

export const STEP_ICON: Readonly<Record<string, IconName>> = { tool: 'tool', read: 'read', edit: 'pen', bash: 'terminal', search: 'search', text: 'text', think: 'spark' };

/** One step as its turn's activity holds it (`{kind:'tool', tool, label, detail}`, `{kind:'text', text}`…): what it
 *  shows on the rail and what opening it shows. */
export function stepOf(s: RunStep): { readonly icon: IconName; readonly label: string; readonly detail?: string; readonly said?: string } {
  const tool = typeof s['tool'] === 'string' ? (s['tool'] as string) : s.kind;
  if (s.kind === 'text') return { icon: 'text', label: '', said: s.text ?? '' };
  const label = s.label ?? s.detail ?? s.text ?? s.kind;
  const detail = s.detail && s.detail !== label ? s.detail : typeof s['output'] === 'string' ? (s['output'] as string) : undefined;
  return { icon: STEP_ICON[tool] ?? STEP_ICON[s.kind] ?? 'dots', label, ...(detail !== undefined && { detail }) };
}
