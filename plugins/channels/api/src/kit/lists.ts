// What a channel can ask for (help, projects, models, crew, machines, status), and the first reply
// to a message. Text only, from the same ctx as the grammar. Every list ends with a working example
// in the user's own names: that's how people learn this. The port of v1 server/channels/lists.js.

import type { AgentView, ChannelCtx, MemberView, Mode, Problem } from '../index.ts';
import { handleOf } from './mentions.ts';
import { MODE_LABEL } from './policy.ts';
import { truncate } from './text.ts';

type Ctx = Partial<ChannelCtx>;

// ---------- models as a turn's stats name them (v1 web/js/cold-cache.js) ----------

export const bareModel = (id: unknown): string => String(id || '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');

interface ModelStat {
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * The model the main thread ran on: stats.models has its subagents' too, and most output doesn't
 * say which is which. A context this large is the main thread's, so it's the one that read most.
 */
export function mainModel(st: unknown): string {
  const s = isObj(st) ? st : {};
  const subs = new Set((Array.isArray(s['subagents']) ? s['subagents'] : []).filter((x): x is Record<string, unknown> => isObj(x) && !x['same'] && !!x['model']).map((x) => bareModel(x['model'])));
  const models: ModelStat[] = (Array.isArray(s['models']) ? s['models'] : []).filter(isObj);
  const read = (m: ModelStat): number => num(m.input) + num(m.cacheRead) + num(m.cacheWrite);
  return models.map((m) => ({ id: bareModel(m.model), read: read(m) })).filter((m) => !subs.has(m.id)).sort((a, b) => b.read - a.read)[0]?.id || '';
}

// ---------- lists ----------

const firstModel = (ctx: Ctx): string => (ctx.agents || []).filter((a) => a.available).flatMap((a) => (a.models || []).filter((m) => m.id))[0]?.id || '';

/** A message that would work here, with what this wisp really has. */
export function example(ctx: Ctx = {}): string {
  const project = ctx.defaultProject || ctx.projects?.[0];
  const model = firstModel(ctx);
  return `Try: ${[project && `in ${project.name}`, model && `with ${model}`, 'plan:'].filter(Boolean).join(' ')} fix the flaky test`;
}

const crewExample = (ctx: Ctx): string => (ctx.crew?.[0] ? `Try: @${handleOf(ctx.crew[0].name)} look at the failing test` : example(ctx));
const machineExample = (ctx: Ctx): string => {
  const m = (ctx.machines || []).find((x) => x.usable);
  return m ? `Try: on ${m.name} ${ctx.defaultProject ? `in ${ctx.defaultProject.name} ` : ''}fix the flaky test` : example(ctx);
};

export const help = (ctx: Ctx): string =>
  [
    'Say what you’d type in wisp: options first, then the task.',
    '@name a crew member · in or #project · on machine · with model · plan or edits, then “:”',
    'Reply to wisp’s messages to answer or follow up; in a task’s thread, stop, done and status work too.',
    'Lists: projects, models, crew, machines, status. Start with “:” to send a message as written.',
    '',
    example(ctx),
  ].join('\n');

export function projects(ctx: Ctx): string {
  const list = ctx.projects || [];
  const [first] = list;
  if (!first) return 'No projects yet. Open a folder in wisp first.';
  const where = (id: string): string => (ctx.machines || []).find((m) => m.id === id)?.name || id;
  return truncate(`Projects:\n${list.map((p) => `• ${p.name}${p.machine ? ` (on ${where(p.machine)})` : ''}${p === ctx.defaultProject ? '  ← default' : ''}`).join('\n')}\n\nTry: in ${ctx.defaultProject?.name || first.name} fix the flaky test`, 4000);
}

const agentLine = (a: AgentView): string => {
  const list = (a.models || []).filter((x) => x.id).map((x) => x.id).slice(0, 12);
  return `• ${a.id}${list.length ? `: ${list.join(', ')}` : ''}${a.efforts?.length ? ` (thinking: ${a.efforts.join(', ')})` : ''}`;
};

/** For the default place, or a machine named in arg. */
export function models(ctx: Ctx, arg = ''): string {
  const q = String(arg || '').replace(/^on\s+/i, '').trim().toLowerCase();
  const m = q ? (ctx.machines || []).find((x) => x.name.toLowerCase() === q) || (ctx.machines || []).find((x) => x.name.toLowerCase().startsWith(q)) : null;
  if (q && !m) return `No machine “${arg}”. Send machines to see them.`;
  const agents = m ? m.agents : ctx.agents || [];
  if (m && !agents) return `${m.name} is offline, so I can’t say what it has.`;
  const up = (agents || []).filter((a) => a.available && a.id !== 'wisp');
  const [top] = up;
  if (!top) return `Nothing is installed on ${m?.name || 'this computer'}.`;
  const eg = up.flatMap((a) => (a.models || []).filter((x) => x.id).map((x) => `${x.id}${a.efforts?.includes('high') ? ' high' : ''}`))[0] || top.id;
  return truncate(`On ${m?.name || 'this computer'}:\n${up.map(agentLine).join('\n')}\n• auto: ${(ctx.goals || []).join(', ')}\n\nTry: ${m ? `on ${m.name} ` : ''}with ${eg} fix the flaky test`, 4000);
}

export function crew(ctx: Ctx): string {
  const list = ctx.crewView || ctx.crew || [];
  if (!list.length) return `No crew yet. Add someone in wisp.\n\n${example(ctx)}`;
  const line = (m: MemberView): string => {
    const busy = m.paused ? 'paused' : m.running ? `on ${m.running} job${m.running > 1 ? 's' : ''}` : 'free';
    return `• @${handleOf(m.name)}${m.role ? ` · ${m.role}` : ''} · ${busy}${m.queue?.length ? `, ${m.queue.length} waiting` : ''}`;
  };
  return truncate(`Crew:\n${list.map(line).join('\n')}\n\n${crewExample(ctx)}`, 4000);
}

export function machines(ctx: Ctx): string {
  const list = ctx.machines || [];
  const lines = ['• this computer · online', ...list.map((m) => `• ${m.name} · ${m.usable ? (m.agents ? 'online' : 'asleep, wakes when it gets work') : 'offline'}`)];
  return truncate(`Machines:\n${lines.join('\n')}\n\n${machineExample(ctx)}`, 4000);
}

export function status(ctx: Ctx): string {
  const list = ctx.tasks || [];
  const running = list.filter((s) => s.state === 'running');
  const waiting = list.filter((s) => s.state === 'waiting');
  if (!list.length) return `Nothing running or waiting.\n\n${example(ctx)}`;
  const line = (s: { title: string }): string => `• ${s.title}`;
  return truncate([running.length && `Running:\n${running.map(line).join('\n')}`, waiting.length && `Waiting for you:\n${waiting.map(line).join('\n')}`, example(ctx)].filter(Boolean).join('\n\n'), 4000);
}

export type ListName = 'help' | 'projects' | 'models' | 'crew' | 'machines' | 'status';
export const LISTS: Readonly<Record<ListName, (ctx: Ctx, arg?: string) => string>> = { help, projects, models, crew, machines, status };
export const isList = (name: string | null | undefined): name is ListName => !!name && Object.hasOwn(LISTS, name);

/** Why a message didn't start, and what would have worked. */
export const refusal = (problems: readonly Problem[]): string =>
  truncate(
    problems
      .map((p) => `${p.text}${p.choices?.length ? `\nChoices: ${p.choices.slice(0, 30).join(', ')}` : ''}`)
      .concat('Nothing started. Start with “:” to send it as written.')
      .join('\n\n'),
    4000,
  );

// What the harness runs instead of that model in that mode, where it's known to.
const overrideOf = (ctx: Ctx, agent: string, model: string, mode: Mode): { label: string; note: string } | null | undefined =>
  (ctx.adapters || []).find((a) => a.id === agent)?.modelOverride?.({ model, mode });
export const modelNote = (ctx: Ctx, agent: string, model: string | null | undefined, mode: Mode): string => overrideOf(ctx, agent, model || '', mode)?.note || '';

/**
 * The model a finished turn's main thread ran on (read most, not a subagent's), when the task asked
 * for another, as the stats name it. An alias is the same model as its full id. A turn without
 * stats.totals may hold earlier turns' models.
 */
export function ranInstead(asked: unknown, stats: unknown): string {
  const want = bareModel(asked).toLowerCase();
  const ran = isObj(stats) && stats['totals'] ? mainModel(stats).toLowerCase() : '';
  return want && ran && ran !== want && !ran.startsWith(`${want}-`) && !ran.split('-').includes(want) ? ran : '';
}

/** Opus high, Sonnet, or the harness when it runs on its default model. With a mode: what really runs. */
export function modelLabel(ctx: Ctx, agent: string, model: string | null | undefined, effort: string | null | undefined, mode: Mode): string {
  if (agent === 'auto') return `Auto${model ? ` ${model}` : ''}`;
  const a = [...(ctx.agents || []), ...(ctx.adapters || [])].find((x) => x.id === agent);
  const m = model ? (a?.models || []).find((x) => x.id === model) : undefined;
  return [overrideOf(ctx, agent, model || '', mode)?.label || m?.label || model || a?.name || agent, effort].filter(Boolean).join(' ');
}

const taskLine = (t: unknown): string => {
  const s = truncate(String(t || '').replace(/\s+/g, ' ').trim(), 200);
  return s && `  ${(s[0] ?? '').toUpperCase()}${s.slice(1)}`;
};

export interface AckTask {
  project?: string;
  label?: string;
  mode?: Mode | null | undefined;
  machine?: string;
  task?: string;
  notes?: readonly string[];
}

/** ▶ api · Opus high · Plan · on laptop */
export const ackTask = ({ project, label, mode, machine, task, notes = [] }: AckTask): string =>
  [`▶ ${[project, label, mode && MODE_LABEL[mode], machine && `on ${machine}`].filter(Boolean).join(' · ')}`, taskLine(task), ...notes].filter(Boolean).join('\n');

/** ▶ Ada has it (queued, 1 ahead) · api · Sonnet */
export const ackCrew = ({ name, ahead = null, paused = false, project, label, mode, machine, task, notes = [] }: AckTask & { name: string; ahead?: number | null; paused?: boolean | undefined }): string =>
  [
    `▶ ${name} has it${ahead !== null ? ` (queued, ${ahead} ahead)` : paused ? ' (paused, this one runs anyway)' : ''}${[project, label, mode && MODE_LABEL[mode], machine && `on ${machine}`]
      .filter(Boolean)
      .map((x) => ` · ${x}`)
      .join('')}`,
    taskLine(task),
    ...notes,
  ]
    .filter(Boolean)
    .join('\n');
