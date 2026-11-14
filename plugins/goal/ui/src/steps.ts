// A check's steps as its record holds them (a task turn's activity, runtime.quick's steps), read for the page's
// rail. Pure.
import type { IconName } from '@wisp/ui/pure';
import type { RunStep } from './types.ts';

/** A step's icon by its tool kind (runtime's `ToolKind`) or its own kind. */
export const STEP_ICON: Readonly<Record<string, IconName>> = {
  tool: 'tool',
  read: 'read',
  edit: 'pen',
  run: 'terminal',
  bash: 'terminal',
  search: 'search',
  web: 'web',
  agent: 'agent',
  plan: 'plan',
  wait: 'clock',
  ask: 'ask',
  answer: 'ask',
  background: 'clock',
  text: 'text',
  thinking: 'spark',
  think: 'spark',
  tool_error: 'warn',
  blocked: 'lock',
  notice: 'info',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** One step as its turn's activity holds it (`{kind:'tool', tool, label, detail, output}`, `{kind:'text', text}`…):
 *  what it shows on the rail and what opening it shows. */
export function stepOf(s: RunStep): { readonly icon: IconName; readonly label: string; readonly detail?: string; readonly said?: string } {
  const tool = str(s['tool']) ?? s.kind;
  if (s.kind === 'text') return { icon: 'text', label: '', said: s.text ?? '' };
  const label = str(s.label) ?? str(s['title']) ?? (s.kind === 'tool_error' ? str(s['name']) : undefined) ?? str(s.detail) ?? str(s.text) ?? s.kind;
  const detail = [s.detail !== label ? str(s.detail) : undefined, str(s['output']), s.kind === 'tool_error' && s.text !== label ? str(s.text) : undefined]
    .filter((x): x is string => x !== undefined)
    .join('\n\n');
  return { icon: STEP_ICON[tool] ?? STEP_ICON[s.kind] ?? 'dots', label, ...(detail !== '' && { detail }) };
}

/** The rail: each `tool_output` folded into its call's opened detail (as a task's transcript shows it), a thinking
 *  step with nothing in it dropped, and a last text that is the answer itself left to "What it said" below. */
export function railOf(steps: readonly RunStep[], said?: string): readonly RunStep[] {
  const outputs = new Map<string, string>();
  for (const s of steps) {
    const id = str(s['callId']);
    if (s.kind === 'tool_output' && id !== undefined && s.text !== undefined) outputs.set(id, [outputs.get(id), s.text].filter(Boolean).join('\n'));
  }
  const out: RunStep[] = [];
  for (const s of steps) {
    const id = str(s['callId']);
    if (s.kind === 'tool_output' && id !== undefined && steps.some((c) => c.kind === 'tool' && c['callId'] === id)) continue;
    if (s.kind === 'thinking' && !str(s.text)) continue;
    const output = s.kind === 'tool' && id !== undefined ? outputs.get(id) : undefined;
    out.push(output !== undefined && str(s['output']) === undefined ? { ...s, output } : s);
  }
  const last = out[out.length - 1];
  if (said !== undefined && last?.kind === 'text' && last.text?.trim() === said.trim()) out.pop();
  return out;
}
