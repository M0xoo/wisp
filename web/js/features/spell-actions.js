// What spell buttons do to tasks, through the same functions the rest of the page uses. Loaded on
// first use, so spells.js doesn't import half the app.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast } from '../ui/toast.js';
import { setArchived, toggleDone } from './actions.js';
import { recipeParams, runRecipe } from './automations.js';
import { sendReply } from './composer.js';
import { shipDialog } from './ship.js';

// A follow-up: through the card's box when it's open (optimistic, like typing it), else straight to the API.
export async function sendTo(id, text) {
  if (S.full.has(id) && S.nodes.get(id)?.body) return sendReply(id, text);
  await api(`/sessions/${id}/reply`, { method: 'POST', body: { text } });
  toast('Sent');
}

const project = () => S.config.projects.find((p) => p.id === S.filter) || null;

export async function launchTask(v, s) {
  const cwd = v.cwd || s?.cwd || project()?.path || '';
  const out = await api('/sessions', { method: 'POST', body: { prompt: v.prompt, ...(cwd ? { cwd } : { scratch: true }), agent: v.agent || undefined, model: v.model || undefined, effort: v.effort || undefined, mode: v.mode || undefined } });
  toast(`Started <b>${esc(out.title)}</b>`);
}

// Rerun a task as a new one (its first request unless the spell gives a prompt), on another harness.
export async function rerunOn(s, v) {
  const full = S.full.get(s.id) || (await api(`/sessions/${s.id}`));
  const prompt = v.prompt || full.turns?.[0]?.prompt || s.title;
  const out = await api('/sessions', { method: 'POST', body: { prompt, cwd: s.scratch ? undefined : s.cwd, scratch: s.scratch || undefined, agent: v.agent || undefined, model: v.model ?? undefined, effort: v.effort || undefined, mode: v.mode || undefined } });
  toast(`Started <b>${esc(out.title)}</b> on ${esc(out.agent)}`);
}

// Fork the task from its latest turn, straight away: the spell says what the fork should try.
export async function forkOn(s, v) {
  const out = await api(`/sessions/${s.id}/fork`, { method: 'POST', body: { prompt: v.prompt, agent: v.agent || undefined, model: v.model || undefined, effort: v.effort || undefined, mode: v.mode || undefined } });
  toast(`Forked into <b>${esc(out.title)}</b>`);
}

export function recipe(name) {
  const loose = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const r = (S.config.recipes || []).find((x) => x.id === name || loose(x.name) === loose(name));
  if (!r) throw new Error(`No recipe named ${name}`);
  runRecipe({ ...r, params: recipeParams(r.prompt) });
}

export const ship = (id) => shipDialog(id);
export const done = (id) => toggleDone(id);
export const archive = (id) => setArchived(id, true);

export async function exec(id, command) {
  const out = await api(`/sessions/${id}/exec`, { method: 'POST', body: { command, key: `spell:${command}` } });
  const ok = out.exitCode === 0;
  toast(`${icon(ok ? 'check' : 'x')} <code>${esc(command)}</code> ${ok ? 'finished' : `exited ${esc(out.exitCode)}`}`, {
    tone: ok ? '' : 'bad',
    action: {
      label: 'Output',
      run: () => {
        const node = el(`<div class="modal sp-panel"><header><h2>${icon('terminal')} ${esc(command)}</h2><button class="icon-btn close">${icon('x')}</button></header><pre class="code sp-out"><code>${esc(out.output || '(no output)')}</code></pre></div>`);
        const close = overlay(node);
        $('.close', node).onclick = close;
      },
    },
    timeout: 8000,
  });
}
