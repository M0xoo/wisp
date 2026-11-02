// Harness watch (server/harness-watch.js): wisp pins each harness's program the first time it runs
// it, and says when it changed: on the task whose run found it, and on its row in Settings →
// Agents, each with Trust this version. An update (version up, same install folder) is an info
// line; another folder, or the same version with other bytes, is a warning.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $$, icon } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { S, setAgents } from '../core/state.js';
import { toastError } from '../ui/toast.js';
import { agentName } from './runners.js';

const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const label = (x) => x.version || x.path;

// "Claude Code changed since 2 Nov: 2.0.1 → 2.0.2" (server/harness-watch.js changeLine says the same).
export function changeText(agent, c) {
  const from = label(c.from);
  const moved = c.kind !== 'update' && c.from.real !== c.to.real && c.from.path !== c.to.path;
  const to = moved ? `${label(c.to)} at ${c.to.path}` : label(c.to);
  const what = from === to ? `${from}, but its program’s bytes differ` : `${from} → ${to}`;
  return `${agentName(agent)} changed since ${day(c.from.at)}: ${what}`;
}

const tip = (c) => `Was ${c.from.path}${c.from.real !== c.from.path ? ` (${c.from.real})` : ''}, sha256 ${c.from.sha256}\nNow ${c.to.path}${c.to.real !== c.to.path ? ` (${c.to.real})` : ''}, sha256 ${c.to.sha256}`;

// Still open: the harness hasn't been trusted since this change was seen (its pin is older).
export function stillChanged(agent, c) {
  const a = S.agents.find((x) => x.id === agent);
  return !!c && !c.checking && !(a?.pinnedAt >= c.at);
}

// The line itself, for a task's turn and a harness's row. Nothing when it was trusted since.
export function harnessNote(agent, c) {
  if (!stillChanged(agent, c)) return '';
  const warn = c.kind !== 'update';
  return `<div class="hw-note ${warn ? 'hw-warn' : 'hw-update'}" data-hw="${esc(agent)}" title="${esc(tip(c))}">
      ${icon(warn ? 'warn' : 'info')}<span class="hw-say">${esc(changeText(agent, c))}${warn ? '. If you didn’t install this, don’t run it.' : ''}</span>
      <button type="button" class="ghost sm" data-trust="${esc(agent)}">Trust this version</button>
    </div>`;
}

// Trust this version: every line about this harness goes at once; a refusal brings them back.
export async function trustHarness(agent) {
  const a = S.agents.find((x) => x.id === agent);
  const was = a && { changed: a.changed, pinnedAt: a.pinnedAt };
  const gone = $$(`.hw-note[data-hw="${CSS.escape(agent)}"]`).map((n) => [n, n.hidden]);
  for (const [n] of gone) n.hidden = true;
  if (a) Object.assign(a, { changed: undefined, pinnedAt: Date.now() });
  try {
    setAgents(await api(`/agents/${encodeURIComponent(agent)}/trust`, { method: 'POST', body: {} }));
    bus.emit('agents');
    return true;
  } catch (err) {
    if (a && was) Object.assign(a, was);
    for (const [n, hidden] of gone) n.hidden = hidden;
    toastError(err);
    return false;
  }
}

// One click handler for the whole page: the lines live in turns and in Settings.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.hw-note [data-trust]');
  if (b) trustHarness(b.dataset.trust);
});
