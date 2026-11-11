// What a task's row says, decided from its summary alone (v1 feed.js renderHead, headPills, runLine,
// quickDone, quickLater; core/format.js statusPill). Pure and DOM-free: the row component only lays
// it out, so every rule here has a test. Text is an i18n key and its vars, never English.

import type { IconName } from '@wisp/ui';
import type { Tone } from '@wisp/tokens';
import type { Row, Agent, SessionRow } from '../types.ts';
import { resText } from './machine.ts';
import { isForLater, isScheduled, nextAt } from './sections.ts';

export interface Txt {
  readonly key: string;
  readonly vars?: Readonly<Record<string, string | number>>;
}
const tx = (key: string, vars?: Readonly<Record<string, string | number>>): Txt => (vars ? { key, vars } : { key });
/** Text the user or the agent wrote: shown as it is. */
export const RAW = 'shell-list.raw';
const raw = (text: string): Txt => ({ key: RAW, vars: { text } });

export interface PillView {
  readonly id: string;
  readonly label: Txt;
  readonly tone: Tone;
  readonly icon?: IconName;
  readonly dot?: boolean;
  readonly live?: boolean;
  readonly title?: Txt;
  readonly variant?: 'soft' | 'outline';
}

export interface SubView {
  readonly text: Txt;
  readonly icon?: IconName;
  readonly title?: Txt;
  /** the live line of a busy task: running or asking */
  readonly live?: 'running' | 'waiting';
  readonly held?: boolean;
}

export interface RunView {
  readonly agent: string;
  readonly agentName: string;
  readonly model?: string;
  readonly where: string;
  readonly remote: boolean;
  /** it runs in a sandbox of its own (ADR-0047): the machine's slot says Sandbox, with the box */
  readonly sandbox?: boolean;
  readonly title: Txt;
}

export type TimeView = { readonly kind: 'ago'; readonly at: number; readonly title?: Txt } | { readonly kind: 'ahead'; readonly at: number; readonly title?: Txt };

export type Mark = { readonly kind: 'agent'; readonly status?: Tone; readonly live: boolean } | { readonly kind: 'origin'; readonly icon: IconName; readonly title: Txt } | { readonly kind: 'bell' };

export interface RowView {
  readonly mark: Mark;
  readonly sub?: SubView;
  readonly run?: RunView;
  readonly pills: readonly PillView[];
  readonly ram: string;
  readonly time: TimeView;
  readonly unread: boolean;
  /** a finished task's title reads quieter (ink-2) */
  readonly quiet: boolean;
  readonly quickLater: 'save' | 'unsave' | 'gap';
  readonly quickDone: 'show' | 'gap' | 'none';
}

export interface RowContext {
  /** the list is beside the open task (split view) */
  readonly split: boolean;
  /** this row is the open task */
  readonly open: boolean;
  /** swipes mark done on this device (the phone app): rows keep neither the ✓ nor its space */
  readonly swipes: boolean;
  /** what this computer is called (This Mac, Studio) */
  readonly here: string;
  /** what a sandbox is called in the machine's slot ("Sandbox") */
  readonly sandbox?: string;
  readonly agents: ReadonlyMap<string, Row<Agent>>;
}

export const busy = (s: SessionRow): boolean => s.state === 'running' || s.state === 'waiting';

/** The agent's verdict word (core/format.js statusKey): Blocked is split into wisp's own halts. */
export function statusKey(s: SessionRow): string {
  if (s.status === 'blocked' && s.halt) return s.halt;
  return s.status && s.status !== 'running' ? s.status : 'done';
}
const STATUS_TONE: Readonly<Record<string, Tone>> = { done: 'good', partial: 'warn', blocked: 'warn', failed: 'bad', limit: 'warn', refused: 'warn', signedOut: 'warn', info: 'info', held: 'warn' };

export const agentName = (id: string, agents: ReadonlyMap<string, Row<Agent>>): string =>
  agents.get(id)?.name ?? (id === 'auto' ? 'Auto' : id === 'wisp' ? 'wisp' : id);

function heldSub(s: SessionRow, agents: ReadonlyMap<string, Row<Agent>>): Txt {
  const h = s.held;
  if (!h) return raw('');
  if (h.project) return tx(h.project.setup ? 'shell-list.held.setup' : 'shell-list.held.project');
  if (h.harness) return tx('shell-list.held.harness', { agent: agentName(s.agent, agents) });
  if (h.waiting) return tx('shell-list.held.reset', { label: (h.label ?? '').toLowerCase() });
  return tx('shell-list.held.window', { label: h.label ?? '', pct: Math.floor((h.used ?? 0) * 100) });
}

function laterLine(s: SessionRow): SubView | undefined {
  const l = s.later?.[0];
  if (!l) return undefined;
  if (l.held?.load) return { icon: 'pause', held: true, text: l.goal ? tx('shell-list.later.goal-computer', { n: l.goal }) : tx('shell-list.later.computer', { text: l.text }) };
  if (l.held) return { icon: 'pause', held: true, text: l.goal ? tx('shell-list.later.goal-plan', { n: l.goal }) : tx('shell-list.later.plan', { text: l.text }) };
  if (l.goal) return { icon: 'target', text: tx('shell-list.later.goal', { n: l.goal }) };
  return { icon: l.remind ? 'bell' : 'clock', text: raw(l.text) };
}

/** The line under the title: live text, held, scheduled, then the report's first line. */
export function subOf(s: SessionRow, c: RowContext): SubView | undefined {
  if (busy(s)) return s.live ? { text: raw(s.live), live: s.state === 'running' ? 'running' : 'waiting' } : undefined;
  if (c.open && !c.split) return undefined;
  if (s.held) return { icon: 'pause', held: true, text: heldSub(s, c.agents) };
  if (isScheduled(s)) return laterLine(s);
  if (s.preview) return { text: raw(s.preview) };
  if (s.foreign) return { text: tx('shell-list.sub.brought-in', { tool: s.foreign.charAt(0).toUpperCase() + s.foreign.slice(1) }) };
  return undefined;
}

/** Harness, model and where it runs: the machine is always named, this computer too. */
export function runOf(s: SessionRow, c: RowContext): RunView | undefined {
  if (!s.agent || s.agent === 'wisp' || s.kind === 'reminder') return undefined;
  const a = c.agents.get(s.agent);
  const model = (s.model && a?.models?.find((m) => m.id === s.model)?.label) || s.model || undefined;
  const sandbox = s.machine?.kind === 'sandbox';
  const where = sandbox ? (c.sandbox ?? 'Sandbox') : (s.machine?.name ?? c.here);
  const name = agentName(s.agent, c.agents);
  return {
    agent: s.agent,
    agentName: name,
    ...(model ? { model } : {}),
    where,
    remote: !!s.machine,
    ...(sandbox && { sandbox: true }),
    title: tx(s.effort ? 'shell-list.run.tip-effort' : 'shell-list.run.tip', { agent: name, model: model ?? '', effort: s.effort === 'xhigh' ? 'X-High' : s.effort ? s.effort.charAt(0).toUpperCase() + s.effort.slice(1) : '', where }),
  };
}

function statusPill(s: SessionRow): PillView | undefined {
  if (s.state === 'waiting') return { id: 'status', label: tx(s.approval ? 'shell-list.pill.approval' : 'shell-list.pill.asking'), tone: 'warn', dot: true, live: true };
  if (s.state !== 'review') return undefined;
  if (s.held) return { id: 'status', label: tx('shell-list.pill.held'), tone: 'warn', dot: true };
  if (s.reminder) return { id: 'status', label: tx('shell-list.pill.reminder'), tone: 'info', icon: 'bell', title: raw(s.reminder.text) };
  const k = statusKey(s);
  return { id: 'status', label: tx(`shell-list.status.${k}`), tone: STATUS_TONE[k] ?? 'neutral', dot: true };
}

function prPill(s: SessionRow): PillView | undefined {
  if (s.shipping) return { id: 'pr', label: tx('shell-list.pill.shipping'), tone: 'accent', icon: 'send', live: true, dot: true };
  const pr = s.pr;
  if (!pr) return undefined;
  const tone: Tone = pr.state === 'merged' ? 'good' : pr.state === 'closed' ? 'neutral' : pr.conflict || pr.checks === 'fail' ? 'bad' : pr.checks === 'pending' ? 'warn' : 'accent';
  const state = pr.state === 'open' ? (pr.draft ? 'draft' : pr.conflict ? 'conflict' : pr.checks === 'fail' ? 'failing' : 'open') : pr.state;
  return { id: 'pr', label: tx('shell-list.pill.pr', { n: pr.number }), tone, icon: 'merge', variant: 'outline', title: tx(`shell-list.pr.${state}`, { n: pr.number }) };
}

/** What a row says about its task between the title and the time, in v1's order. */
export function pillsOf(s: SessionRow): PillView[] {
  const out: PillView[] = [];
  const status = statusPill(s);
  if (status) out.push(status);
  const l = s.later?.[0];
  if (l && !isScheduled(s)) out.push({ id: 'later', label: s.later && s.later.length > 1 ? tx('shell-list.pill.later-more', { n: s.later.length - 1, at: l.at }) : tx('shell-list.pill.later', { at: l.at }), tone: 'neutral', icon: l.remind ? 'bell' : 'clock', variant: 'outline' });
  if (s.queued) out.push({ id: 'queued', label: tx('shell-list.pill.queued', { n: s.queued }), tone: s.queueHeld ? 'warn' : 'neutral', title: tx(s.queueHeld ? 'shell-list.pill.queued-held-tip' : 'shell-list.pill.queued-tip', { n: s.queued }) });
  if (s.sideOf) out.push({ id: 'side', label: tx('shell-list.pill.side'), tone: 'neutral', icon: 'discuss', variant: 'outline', title: tx('shell-list.pill.side-tip', { title: s.sideOf.title }) });
  const pr = prPill(s);
  if (pr) out.push(pr);
  if (s.pinned) out.push({ id: 'pinned', label: tx('shell-list.pill.pinned'), tone: 'neutral', icon: 'pin', variant: 'outline' });
  return out;
}

const ORIGIN_ICON: Readonly<Record<string, IconName>> = { recipe: 'bolt', trigger: 'replay' };

function markOf(s: SessionRow): Mark {
  if (s.kind === 'reminder') return { kind: 'bell' };
  const ic = s.origin ? ORIGIN_ICON[s.origin.kind] : undefined;
  if (ic && s.origin) return { kind: 'origin', icon: ic, title: tx('shell-list.origin', { kind: s.origin.kind, name: s.origin.name ?? '' }) };
  const status: Tone | undefined = s.state === 'running' ? 'accent' : s.state === 'waiting' ? 'warn' : undefined;
  return { kind: 'agent', live: s.state === 'running', ...(status ? { status } : {}) };
}

function timeOf(s: SessionRow): TimeView {
  if (isScheduled(s)) return { kind: 'ahead', at: nextAt(s) };
  if (isForLater(s) && s.forLater) return { kind: 'ago', at: s.forLater.at, title: tx(s.forLater.by === 'crew' ? 'shell-list.time.filed' : 'shell-list.time.saved', { at: s.forLater.at, updated: s.updatedAt }) };
  return { kind: 'ago', at: s.updatedAt };
}

/** One-click Mark done on review rows; rows without one keep its space, so columns line up. */
function quickDone(s: SessionRow, c: RowContext): RowView['quickDone'] {
  if (c.swipes) return 'none';
  return s.state === 'review' && !s.parentId && !s.archived && (!c.open || c.split) ? 'show' : 'gap';
}

/** Save for later beside it: triage is one click either way. */
function quickLater(s: SessionRow, c: RowContext): RowView['quickLater'] {
  if (s.pending || s.archived || s.parentId || (c.open && !c.split)) return 'gap';
  if (isForLater(s)) return 'unsave';
  return s.state === 'review' ? 'save' : 'gap';
}

export function rowView(s: SessionRow, c: RowContext): RowView {
  const sub = subOf(s, c);
  const run = runOf(s, c);
  return {
    mark: markOf(s),
    ...(sub ? { sub } : {}),
    ...(run ? { run } : {}),
    pills: pillsOf(s),
    ram: resText(s),
    time: timeOf(s),
    unread: !!s.unread && !busy(s),
    quiet: s.state === 'done' || !!s.archived,
    quickLater: quickLater(s, c),
    quickDone: quickDone(s, c),
  };
}
