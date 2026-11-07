// A harness's event as a transcript step (v1 runner.js stepOf, stepOutput, clipOutput). A goal's
// check records its run with these too, so it reads like a task's.

import type { Activity } from '@wisp-plugin/runtime-api';
import type { HarnessEvent } from '@wisp-plugin/runtime-api';
import type { Step } from './model.ts';

const MAX_TEXT = 20_000; // an agent message, kept whole for the transcript up to this
const MAX_OUTPUT = 2_000; // what a tool call returned: its start and end past this
// The calls whose output the transcript shows. A read returns the file and an edit a confirmation.
export const OUTPUT_KINDS: ReadonlySet<string> = new Set(['run', 'search', 'web', 'tool', 'agent']);

/** A tool call's output: whole when short, else its first and last lines (how a test run ended). */
export function clipOutput(text: unknown): string {
  const out = String(text ?? '').replace(/\s+$/, '');
  if (out.length <= MAX_OUTPUT) return out;
  let head = out.slice(0, 600);
  let tail = out.slice(-1300);
  if (head.includes('\n')) head = head.slice(0, head.lastIndexOf('\n'));
  if (tail.includes('\n')) tail = tail.slice(tail.indexOf('\n') + 1);
  const cut = out.slice(head.length, out.length - tail.length);
  const lines = cut.split('\n').length - 1;
  return `${head}\n… ${lines > 1 ? `${lines} lines` : `${cut.length} characters`} cut …\n${tail}`;
}

type StepEvent = Extract<HarnessEvent, { type: 'tool' | 'text' | 'tool_error' }> | { type: 'tool'; kind: string; label: string; file?: string; detail?: string; id?: string; output?: string };

export function stepOf(ev: StepEvent, now: number): Step {
  const item: Step = { t: now, kind: ev.type === 'tool' ? ev.kind : ev.type === 'text' ? 'text' : 'error' };
  if (ev.type === 'tool') {
    if (ev.label !== undefined) item.label = ev.label;
    if (ev.file !== undefined) item.file = ev.file;
    if (ev.detail !== undefined) item.detail = ev.detail;
    if (ev.id) item.call = String(ev.id); // a tool_output later finds its call by this
    if (ev.output && OUTPUT_KINDS.has(item.kind)) item.output = clipOutput(ev.output);
  } else if (ev.type === 'text') item.label = ev.text.slice(0, MAX_TEXT);
  else item.label = `${ev.name || 'Tool'} failed: ${ev.text}`;
  return item;
}

/** What a call returned, on its step, matched by the harness's id: the step and what changed, or null. */
export function stepOutput(activity: Step[], ev: { id?: string; text: string }, now: number): { step: Step; fields: Partial<Step> } | null {
  const item = ev.id ? activity.findLast((a) => a.call === String(ev.id)) : undefined;
  if (!item || !OUTPUT_KINDS.has(item.kind)) return null;
  const fields: Partial<Step> = { outAt: now };
  const output = clipOutput(ev.text);
  if (output.trim()) fields.output = output;
  Object.assign(item, fields);
  return { step: item, fields };
}

/** A step in the api's normalised form (EVENTS.activity, runtime.activity). */
export function toActivity(s: Step): Activity {
  if (s.kind === 'text') return { kind: 'text', text: s.label ?? '' };
  if (s.kind === 'error') {
    const m = /^(.*?) failed: ([\s\S]*)$/.exec(s.label ?? '');
    return { kind: 'tool_error', name: m?.[1] ?? 'Tool', text: m?.[2] ?? s.label ?? '' };
  }
  const tools = ['read', 'edit', 'run', 'search', 'web', 'agent', 'plan', 'tool'] as const;
  const tool = tools.find((x) => x === s.kind);
  if (!tool) return { kind: 'notice', text: s.label ?? '', ...(s.kind === 'blocked' ? { tone: 'warn' as const } : {}) };
  return {
    kind: 'tool',
    tool,
    label: s.label ?? '',
    ...(s.file !== undefined && { file: s.file }),
    ...(s.detail !== undefined && { detail: s.detail }),
    ...(s.call !== undefined && { callId: s.call }),
    ...(s.output !== undefined && { output: s.output }),
  };
}
