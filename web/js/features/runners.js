// How a task runs: the harness (a coding-agent CLI, or Auto), its model and thinking level, and
// the permission mode. Shared by the launcher, follow-ups, reruns, recipes and subagents.

import { esc } from '../md.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { machineById } from './places.js';

export const MODES = [
  { id: 'plan', label: 'Plan', icon: 'plan', hint: 'Read-only. The agent investigates and proposes.' },
  { id: 'edits', label: 'Edits', icon: 'pen', hint: 'May edit files. Anything else that needs approval comes to you to allow.' },
  { id: 'auto', label: 'Full auto', icon: 'spark', hint: 'No permission prompts at all. Trusted repos only.' },
];
// The default: just an icon on mode buttons; the others are spelled out so you can't miss them.
export const DEFAULT_MODE = MODES[2];

export const agentName = (id) => S.agents.find((a) => a.id === id)?.name || (id === 'auto' ? 'Auto' : id === 'wisp' ? 'wisp' : id);

// Auto: not a CLI but wisp's router (server/router.js), which picks harness and model per task.
// Its "models" are the goal it optimises for; there are no thinking levels to pick.
export const AUTO_GOALS = [
  { id: 'balanced', label: 'Balanced', hint: 'Best result per dollar' },
  { id: 'cheap', label: 'Cheap', hint: 'Lowest cost that still gets it done' },
  { id: 'best', label: 'Best', hint: 'Best result; cost only breaks ties' },
];
export const AUTO = { id: 'auto', name: 'Auto', available: true, delegates: true, models: AUTO_GOALS, efforts: [], hint: 'wisp picks the harness and model from what worked before' };

// Harness lists per place: '' is this computer, else a machine (what it reported when it came online).
export const agentsAt = (k) => (k ? (machineById(k)?.state === 'online' && machineById(k).remote?.agents) || null : S.agents);

// A harness's models and levels: this computer's if it's installed here, else the first machine's that has it.
export function agentById(id) {
  if (id === 'auto') return AUTO;
  const local = S.agents.find((a) => a.id === id);
  if (local?.available) return local;
  return S.machines.map((m) => agentsAt(m.id)?.find((a) => a.id === id && a.available)).find(Boolean) || local;
}

// The harnesses you can pick for the places under "Run on": installed on any of them counts (a union).
// `missing` names the picked places that don't have it. Machines not online yet don't count.
export function harnessesAt(places, { auto = false } = {}) {
  if (auto) return [AUTO, ...harnessesAt(places)];
  const known = places.map((k) => [k, agentsAt(k)]).filter(([, l]) => l);
  if (!known.length) known.push(['', S.agents]);
  const ids = [...new Set([...S.agents, ...known.flatMap(([, l]) => l)].map((a) => a.id))];
  return ids
    .map((id) => {
      const hits = known.filter(([, l]) => l.some((a) => a.id === id && a.available));
      const base = hits.length ? hits[0][1].find((a) => a.id === id) : S.agents.find((a) => a.id === id) || known.flatMap(([, l]) => l).find((a) => a.id === id);
      return { ...base, available: hits.length > 0, missing: hits.length ? known.filter((x) => !hits.includes(x)).map(([k]) => k) : [] };
    })
    .filter((a) => a.available || S.agents.some((x) => x.id === a.id));
}

// Harness logos for the request bubble, vendored from @lobehub/icons into web/logos/.
// `mono` marks are drawn in the text colour so they work in both themes.
const HARNESS_LOGO = {
  claude: { file: 'claudecode-color' },
  codex: { file: 'codex-color' },
  opencode: { file: 'opencode', mono: true },
  cursor: { file: 'cursor', mono: true },
  antigravity: { file: 'antigravity-color' },
  grok: { file: 'grok', mono: true },
};
export function harnessLogo(agent) {
  if (agent === 'auto') return `<i class="auto-mark">${icon('spark')}</i>`;
  const l = HARNESS_LOGO[agent];
  const src = l && `/logos/${l.file}.svg`;
  return !l ? icon('spark') : l.mono ? `<i class="mono" style="--logo:url(${src})"></i>` : `<img src="${src}" alt="">`;
}

// Reasoning levels the harness accepts for a model: the model's own list (opencode variants),
// else the harness-wide one. Empty means the harness has no knob for it.
export function effortsFor(agent, model) {
  const a = agentById(agent);
  return a?.models?.find((m) => m.id === model)?.efforts ?? a?.efforts ?? [];
}
export const effortLabel = (e) => ({ xhigh: 'X-High' })[e] || e.charAt(0).toUpperCase() + e.slice(1);

export function modelBadge(agent, model, effort, route) {
  if (agent === 'wisp') return '';
  const label = (model && agentById(agent)?.models?.find((x) => x.id === model)?.label) || model || 'Default model';
  const tip = route ? routeTip(route) : `${agentName(agent)} · ${label}${effort ? ` · ${effortLabel(effort)} thinking` : ''}`;
  const logo = harnessLogo(agent);
  return `<span class="model-logo${route ? ' routed' : ''}" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">${logo}</span>`;
}

// Why Auto picked what it picked, in one line.
function routeTip(r) {
  const goal = AUTO_GOALS.find((g) => g.id === r.goal)?.label || 'Balanced';
  const record = r.n ? `${Math.round(r.chance * 100)}% on your ${r.type} tasks (${r.n})` : `${Math.round(r.chance * 100)}% expected on ${r.type} tasks`;
  const why = r.trying ? 'new model, trying it out' : r.explored ? 'trying an alternative to learn' : record;
  return `Auto · ${goal} → ${r.label} · ${why}${r.usd ? ` · ~$${r.usd.toFixed(2)}` : ''}`;
}

// The model is remembered per harness (ids aren't portable between them).
export function savedModel(id) {
  const d = S.config.defaults;
  if (id === 'auto') return AUTO_GOALS.some((g) => g.id === d.models?.auto) ? d.models.auto : 'balanced';
  const want = d.models?.[id] ?? (id === d.agent ? d.model : '');
  const models = agentById(id)?.models || [];
  return models.some((m) => m.id === want) ? want : '';
}

// Thinking level too, and only if the chosen model still accepts it.
export function savedEffort(id, model) {
  const d = S.config.defaults;
  const want = d.efforts?.[id] ?? (id === d.agent ? d.effort : '');
  return effortsFor(id, model).includes(want) ? want : '';
}

// One launch runs on at most this many harnesses side by side (the server's MAX_COMPARE).
export const MAX_RUNNERS = 4;

// A runner button's tooltip, for when the pill is too full to show names.
export function runnerTip(agentId, model, effort) {
  const a = agentById(agentId);
  const m = (a?.models || []).find((x) => x.id === model);
  return [a?.name || agentName(agentId), m?.label || model || 'Default model', effort && effortLabel(effort)].filter(Boolean).join(' · ');
}

// The harness · model · thinking button, as in the launcher. agent '' reads "Launcher default".
export function paintRunnerBtn(btn, agentId, model, effort) {
  const a = agentById(agentId);
  const m = (a?.models || []).find((x) => x.id === model);
  btn.innerHTML = agentId
    ? `<span class="rb-logo">${harnessLogo(agentId)}</span><span class="rb-h">${esc(a?.name || agentName(agentId))}</span><span class="rb-m">${esc(m && m.id ? m.label : 'Default')}</span>${effort ? `<span class="rb-e">${esc(effortLabel(effort))}</span>` : ''}${icon('chevron', 'chev')}`
    : `<span class="rb-logo">${icon('spark')}</span><span class="rb-h">Launcher default</span>${icon('chevron', 'chev')}`;
}

export function modeMenu(anchor, current, pick) {
  const open = $('.menu.mode');
  if (open) return open.close();
  const menu = el(`
    <div class="menu mode" role="menu">
      ${MODES.map((m) => `<button role="menuitemradio" aria-checked="${m.id === current}" data-mode="${m.id}" class="m-${m.id}${m.id === current ? ' on' : ''}">
        ${icon(m.icon)}<span class="mm-text"><b>${m.label}</b><small>${esc(m.hint)}</small></span>${icon('check', 'mm-check')}
      </button>`).join('')}
    </div>`);
  menu.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    close();
    pick(b.dataset.mode);
    if (anchor.id === 'mode') $('#prompt')?.focus();
  };
  menu.addEventListener('keydown', (ev) => {
    const items = $$('button', menu);
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  const close = popover(menu, { anchor, onClose: () => anchor.classList.remove('open') });
  anchor.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : r.top - 6 - h}px`;
  $('button.on', menu)?.focus();
}
