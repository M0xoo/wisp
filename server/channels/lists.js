// What a channel can ask for (help, projects, models, crew, machines, status), and the first reply
// to a message. Text only, from the same ctx as the grammar. Every list ends with a working example
// in the user's own names: that's how people learn this.

import { handleOf } from '../crew.js';
import { truncate } from '../util.js';
import { MODE_LABEL } from './policy.js';

const firstModel = (ctx) => (ctx.agents || []).filter((a) => a.available).flatMap((a) => (a.models || []).filter((m) => m.id))[0]?.id || '';

// A message that would work here, with what this wisp really has.
export function example(ctx = {}) {
  const project = ctx.defaultProject || ctx.projects?.[0];
  const model = firstModel(ctx);
  return `Try: ${[project && `in ${project.name}`, model && `with ${model}`, 'plan:'].filter(Boolean).join(' ')} fix the flaky test`;
}

const crewExample = (ctx) => (ctx.crew?.[0] ? `Try: @${handleOf(ctx.crew[0].name)} look at the failing test` : example(ctx));
const machineExample = (ctx) => {
  const m = (ctx.machines || []).find((x) => x.usable);
  return m ? `Try: on ${m.name} ${ctx.defaultProject ? `in ${ctx.defaultProject.name} ` : ''}fix the flaky test` : example(ctx);
};

export const help = (ctx) =>
  [
    'Say what you’d type in wisp: options first, then the task.',
    '@name a crew member · in or #project · on machine · with model · plan or edits, then “:”',
    'Reply to wisp’s messages to answer or follow up; in a task’s thread, stop, done and status work too.',
    'Lists: projects, models, crew, machines, status. Start with “:” to send a message as written.',
    '',
    example(ctx),
  ].join('\n');

export function projects(ctx) {
  const list = ctx.projects || [];
  if (!list.length) return 'No projects yet. Open a folder in wisp first.';
  const where = (id) => (ctx.machines || []).find((m) => m.id === id)?.name || id;
  return truncate(`Projects:\n${list.map((p) => `• ${p.name}${p.machine ? ` (on ${where(p.machine)})` : ''}${p === ctx.defaultProject ? '  ← default' : ''}`).join('\n')}\n\nTry: in ${ctx.defaultProject?.name || list[0].name} fix the flaky test`, 4000);
}

// For the default place, or a machine named in arg.
export function models(ctx, arg = '') {
  const q = String(arg || '').replace(/^on\s+/i, '').trim().toLowerCase();
  const m = q ? (ctx.machines || []).find((x) => x.name.toLowerCase() === q) || (ctx.machines || []).find((x) => x.name.toLowerCase().startsWith(q)) : null;
  if (q && !m) return `No machine “${arg}”. Send machines to see them.`;
  const agents = m ? m.agents : ctx.agents || [];
  if (m && !agents) return `${m.name} is offline, so I can’t say what it has.`;
  const up = agents.filter((a) => a.available && a.id !== 'wisp');
  if (!up.length) return `Nothing is installed on ${m?.name || 'this computer'}.`;
  const line = (a) => {
    const list = (a.models || []).filter((x) => x.id).map((x) => x.id).slice(0, 12);
    return `• ${a.id}${list.length ? `: ${list.join(', ')}` : ''}${a.efforts?.length ? ` (thinking: ${a.efforts.join(', ')})` : ''}`;
  };
  const eg = up.flatMap((a) => (a.models || []).filter((x) => x.id).map((x) => `${x.id}${a.efforts?.includes('high') ? ' high' : ''}`))[0] || up[0].id;
  return truncate(`On ${m?.name || 'this computer'}:\n${up.map(line).join('\n')}\n• auto: ${(ctx.goals || []).join(', ')}\n\nTry: ${m ? `on ${m.name} ` : ''}with ${eg} fix the flaky test`, 4000);
}

export function crew(ctx) {
  const list = ctx.crewView || ctx.crew || [];
  if (!list.length) return `No crew yet. Add someone in wisp.\n\n${example(ctx)}`;
  const line = (m) => {
    const busy = m.paused ? 'paused' : m.running ? `on ${m.running} job${m.running > 1 ? 's' : ''}` : 'free';
    return `• @${handleOf(m.name)}${m.role ? ` · ${m.role}` : ''} · ${busy}${m.queue?.length ? `, ${m.queue.length} waiting` : ''}`;
  };
  return truncate(`Crew:\n${list.map(line).join('\n')}\n\n${crewExample(ctx)}`, 4000);
}

export function machines(ctx) {
  const list = ctx.machines || [];
  const lines = ['• this computer · online', ...list.map((m) => `• ${m.name} · ${m.usable ? (m.agents ? 'online' : 'asleep, wakes when it gets work') : 'offline'}`)];
  return truncate(`Machines:\n${lines.join('\n')}\n\n${machineExample(ctx)}`, 4000);
}

export function status(ctx) {
  const list = ctx.tasks || [];
  const running = list.filter((s) => s.state === 'running');
  const waiting = list.filter((s) => s.state === 'waiting');
  if (!list.length) return `Nothing running or waiting.\n\n${example(ctx)}`;
  const line = (s) => `• ${s.title}`;
  return truncate([running.length && `Running:\n${running.map(line).join('\n')}`, waiting.length && `Waiting for you:\n${waiting.map(line).join('\n')}`, example(ctx)].filter(Boolean).join('\n\n'), 4000);
}

export const LISTS = { help, projects, models, crew, machines, status };

// Why a message didn't start, and what would have worked.
export const refusal = (problems) =>
  truncate(
    problems
      .map((p) => `${p.text}${p.choices?.length ? `\nChoices: ${p.choices.slice(0, 30).join(', ')}` : ''}`)
      .concat('Nothing started. Start with “:” to send it as written.')
      .join('\n\n'),
    4000,
  );

// Opus high, Sonnet, or the harness when it runs on its default model.
export function modelLabel(ctx, agent, model, effort) {
  if (agent === 'auto') return `Auto${model ? ` ${model}` : ''}`;
  const a = [...(ctx.agents || []), ...(ctx.adapters || [])].find((x) => x.id === agent);
  const m = model && (a?.models || []).find((x) => x.id === model);
  return [m?.label || model || a?.name || agent, effort].filter(Boolean).join(' ');
}

const taskLine = (t) => {
  const s = truncate(String(t || '').replace(/\s+/g, ' ').trim(), 200);
  return s && `  ${s[0].toUpperCase()}${s.slice(1)}`;
};

// ▶ api · Opus high · Plan · on laptop
export const ackTask = ({ project, label, mode, machine, task, notes = [] }) => [`▶ ${[project, label, MODE_LABEL[mode], machine && `on ${machine}`].filter(Boolean).join(' · ')}`, taskLine(task), ...notes].filter(Boolean).join('\n');

// ▶ Ada has it (queued, 1 ahead) · api · Sonnet
export const ackCrew = ({ name, ahead = null, paused = false, project, label, mode, machine, task, notes = [] }) =>
  [`▶ ${name} has it${ahead !== null ? ` (queued, ${ahead} ahead)` : paused ? ' (paused, this one runs anyway)' : ''}${[project, label, mode && MODE_LABEL[mode], machine && `on ${machine}`].filter(Boolean).map((x) => ` · ${x}`).join('')}`, taskLine(task), ...notes].filter(Boolean).join('\n');
