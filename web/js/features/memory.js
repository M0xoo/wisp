// Memory: what the background retros learned, as preferences and lessons per project.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { ago } from '../core/format.js';
import { launch, S } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { toastError, tryApi } from '../ui/toast.js';
import { reveal } from './feed.js';
import { loadConfig } from './live.js';
import { projectById, projectName } from './places.js';
import { agentName } from './runners.js';

const MEM_KINDS = [
  { kind: 'preferences', label: 'Preferences', one: 'preference', icon: 'spark', hint: 'How you like agents to work', empty: 'Corrections and “always / never” asks from your tasks land here.' },
  { kind: 'lessons', label: 'Lessons', one: 'lesson', icon: 'check', hint: 'A mistake an agent made, and the way that worked', empty: 'When an agent hits a wall and finds the fix, the fix lands here.' },
];
const MEM_CAP = 10;
const memCount = (x) => x.preferences.length + x.lessons.length;

export async function setLearning(on) {
  await api('/config', { method: 'PATCH', body: { defaults: { learn: on ? 'on' : 'off' } } });
  await loadConfig();
}

export function memorySummary(data) {
  if (!data) return '';
  if (!data.enabled) return 'Off · nothing learned or applied';
  const n = memCount(data.global) + data.projects.reduce((a, p) => a + memCount(p), 0);
  const last = data.history[0];
  if (data.running) return `Retro running · ${n} remembered`;
  return `${n ? `${n} remembered` : 'Nothing yet'}${last ? ` · last retro ${ago(last.at)}` : ''}`;
}

export function openMemory({ tab = 'global', host } = {}) {
  const node = el(`<div class="modal memory-modal">
      <header><h2>Memory</h2><span class="mem-live"></span><button class="switch" id="memOn" role="switch" title="Learn from tasks"></button><button class="icon-btn close">${icon('x')}</button></header>
      <p class="mem-lede">Learned from your tasks and added to every agent's prompt. What you ask always wins.</p>
      <div class="mem-tabs" role="tablist"></div>
      <div class="mem-body"></div>
    </div>`);
  const close = present(node, host);
  let data;
  let editing = null; // { scope, kind, index } (index -1 = adding)

  const render = async () => {
    data = (await api('/preferences').catch(() => null)) || data;
    if (!data || !node.isConnected) return;
    // Projects with something learned, plus the one picked in the launcher so you can add to it.
    const current = projectById(launch.project);
    const projects = data.projects.filter((p) => memCount(p) || p.path === current?.path);
    if (current && !projects.some((p) => p.path === current.path)) projects.push({ path: current.path, name: current.name, preferences: [], lessons: [] });
    const scopes = [{ scope: 'global', name: 'Everywhere', ...data.global }, ...projects.map((p) => ({ scope: p.path, ...p }))];
    if (tab !== 'retros' && !scopes.some((x) => x.scope === tab)) tab = 'global';
    $('#memOn', node).setAttribute('aria-checked', data.enabled);
    $('.mem-live', node).innerHTML = data.running ? `<span class="orb live"></span>Retro running` : data.enabled ? '' : 'Off';
    $('.mem-tabs', node).innerHTML =
      scopes.map((x) => `<button role="tab" data-tab="${esc(x.scope)}" class="${tab === x.scope ? 'on' : ''}" title="${esc(x.scope === 'global' ? 'Applies in every project' : x.scope.replace(S.config.home, '~'))}">${esc(x.name)}<span>${memCount(x)}</span></button>`).join('') +
      `<i></i><button role="tab" data-tab="retros" class="${tab === 'retros' ? 'on' : ''}">Retros<span>${data.history.length}</span></button>`;
    const body = $('.mem-body', node);
    body.classList.toggle('off', !data.enabled);
    const banner = data.enabled ? '' : `<div class="mem-off">${icon('info')}<span>Memory is off: no retros run, and nothing below reaches your agents.</span><button class="ghost xs" data-act="on">Turn on</button></div>`;
    body.innerHTML = banner + (tab === 'retros' ? retrosView() : scopeView(scopes.find((x) => x.scope === tab)));
    const input = $('.mem-edit input', body);
    if (input) input.focus(), input.setSelectionRange(input.value.length, input.value.length);
  };

  // Which retro added an item, if it's still in the log.
  const origin = (scope, kind, text) => data.history.find((h) => h.added?.some((a) => a.text === text && a.kind === kind && (a.scope === 'global') === (scope === 'global')));

  const scopeView = (x) => {
    const chars = [...(x.scope === 'global' ? [] : [...data.global.preferences, ...data.global.lessons]), ...x.preferences, ...x.lessons].reduce((a, t) => a + t.length + 3, 0);
    const budget = x.scope === 'global' ? `Added to every prompt · about ${Math.ceil(chars / 4)} tokens` : `Added to prompts in ${esc(x.name)}, with Everywhere · about ${Math.ceil(chars / 4)} tokens`;
    return `<p class="mem-budget muted xs">${budget}</p>` + MEM_KINDS.map((k) => {
      const items = x[k.kind];
      const row = (t, i) => {
        if (editing && editing.scope === x.scope && editing.kind === k.kind && editing.index === i) return editRow(t, k);
        const o = origin(x.scope, k.kind, t);
        return `<div class="mem-item" data-i="${i}"><span class="mem-ico">${icon(k.icon)}</span><div class="mem-main"><p>${esc(t)}</p>${o ? `<span class="mem-src">${o.sessionId && S.sessions.has(o.sessionId) ? `<a href="#" data-session="${esc(o.sessionId)}">${esc(o.title || 'task')}</a>` : esc(o.title || 'a task')} · ${ago(o.at)}</span>` : ''}</div>
          <span class="mem-acts"><button class="icon-btn" data-act="edit" title="Edit">${icon('pen')}</button><button class="icon-btn" data-act="forget" title="Forget">${icon('trash')}</button></span></div>`;
      };
      const adding = editing && editing.scope === x.scope && editing.kind === k.kind && editing.index === -1;
      return `<section class="mem-sec" data-scope="${esc(x.scope)}" data-kind="${k.kind}">
        <h4>${k.label}<span class="muted xs">${k.hint}</span><em class="${items.length >= MEM_CAP ? 'full' : ''}" title="At most ${MEM_CAP}; a retro drops the least useful when full">${items.length}/${MEM_CAP}</em></h4>
        ${items.map(row).join('') || (adding ? '' : `<p class="mem-empty">${k.empty}</p>`)}
        ${adding ? editRow('', k) : `<button class="mem-add" data-act="add">${icon('plus')}Add a ${k.one}</button>`}
      </section>`;
    }).join('');
  };
  const editRow = (t, k) => `<div class="mem-item mem-edit"><span class="mem-ico">${icon(k.icon)}</span><input value="${esc(t)}" maxlength="180" spellcheck="false" placeholder="One short sentence, e.g. “Run tests with node --test”"><span class="muted xs">↵ save · esc cancel</span></div>`;

  const retrosView = () => {
    const live = data.running ? `<div class="tl running"><span class="tl-dot"><span class="orb live"></span></span><div class="tl-main"><div class="tl-head"><b>${esc(data.running.title || 'task')}</b><span class="muted xs">now</span></div><p class="muted xs">Reading ${data.running.turns} turn${data.running.turns === 1 ? '' : 's'} with ${esc(agentName(data.running.agent))}…</p></div></div>` : '';
    const where = (a) => `<span class="tl-tag">${a.scope === 'global' ? 'everywhere' : 'project'} · ${a.kind === 'lessons' ? 'lesson' : 'preference'}</span>`;
    const entries = data.history.map((h) => {
      const status = h.status || 'learned';
      const lines =
        status === 'failed' ? `<p class="tl-err">${esc(h.error || 'The retro run failed.')}</p>`
        : status === 'nothing' ? '<p class="muted xs">Nothing new worth remembering.</p>'
        : [...h.added.map((a) => `<p class="tl-add">${esc(a.text ?? a)} ${a.kind ? where(a) : ''}</p>`), ...h.removed.map((a) => `<p class="tl-del"><s>${esc(a.text ?? a)}</s> ${a.kind ? where(a) : ''}</p>`)].join('');
      const title = S.sessions.has(h.sessionId) ? `<a href="#" data-session="${esc(h.sessionId)}">${esc(h.title || 'task')}</a>` : esc(h.title || 'task');
      return `<div class="tl ${status}"><span class="tl-dot"></span><div class="tl-main"><div class="tl-head"><b>${title}</b>${h.project ? `<span class="muted xs">${esc(projectName(h.project))}</span>` : ''}<span class="muted xs">${ago(h.at)}</span></div>${lines}</div></div>`;
    });
    return live + entries.join('') || `<p class="mem-empty">No retros yet. One runs 90 s after a task finishes, or as soon as you mark it done or archive it.</p>`;
  };

  const save = async (scope, kind, items) => {
    await api('/preferences', { method: 'PUT', body: { scope, kind, items } }).catch(toastError);
    editing = null;
    await render();
  };
  const commit = (input) => {
    if (!editing) return;
    const { scope, kind, index } = editing;
    editing = null; // Enter then blur must not save twice
    const list = ((scope === 'global' ? data.global : data.projects.find((p) => p.path === scope)) || { [kind]: [] })[kind].slice();
    const v = input.value.trim();
    if (index === -1) v ? list.push(v) : null;
    else v ? (list[index] = v) : list.splice(index, 1);
    save(scope, kind, list);
  };

  node.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-act],[data-session]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.tab) return (tab = t.dataset.tab), (editing = null), render();
    if (t.dataset.session) return close(), reveal(t.dataset.session);
    const act = t.dataset.act;
    if (act === 'on') return tryApi(() => setLearning(true)).then(render);
    const sec = t.closest('.mem-sec');
    const { scope, kind } = sec.dataset;
    const index = Number(t.closest('.mem-item')?.dataset.i ?? -1);
    if (act === 'add' || act === 'edit') return (editing = { scope, kind, index }), render();
    if (act === 'forget') {
      const list = (scope === 'global' ? data.global : data.projects.find((p) => p.path === scope))[kind].filter((_, i) => i !== index);
      return save(scope, kind, list);
    }
  });
  node.addEventListener('keydown', (e) => {
    if (!e.target.matches('.mem-edit input')) return;
    if (e.key === 'Enter') e.preventDefault(), commit(e.target);
    if (e.key === 'Escape') e.preventDefault(), e.stopPropagation(), (editing = null), render();
  });
  node.addEventListener('focusout', (e) => e.target.matches('.mem-edit input') && editing && commit(e.target));
  $('#memOn', node).onclick = async () => {
    await tryApi(() => setLearning(!data?.enabled));
    render();
  };
  bus.on('preferences', () => !editing && render(), { node });
  render();
}
