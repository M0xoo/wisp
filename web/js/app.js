import { renderPresentation, icon, el, fmtDuration, copy, countChanges } from './blocks.js';
import { esc, md } from './md.js';
import { palette } from './palette.js';

// One page: the launcher on top, every session in a feed under it. Sessions
// expand in place; nothing navigates away.

// --- state -------------------------------------------------------------------

const S = {
  sessions: new Map(), // id -> summary
  full: new Map(), // id -> full session, for expanded items
  open: new Set(load('wisp.open', [])), // expanded item ids
  nodes: new Map(), // id -> { card, head, body, turnNodes, tray, showAll, unfolded, latestTurn }
  tasks: new Map(), // compare task key -> { card, head, runs, lead }
  focus: null, // id of the keyboard-focused item
  config: { defaults: {}, projects: [] },
  agents: [],
  machines: [], // other computers over SSH: GET /api/machines, kept fresh by the 'machines' event
  filter: load('wisp.filter', 'all'),
  showDone: load('wisp.showDone', false),
  showArchived: false,
  drafts: new Map(),
};

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const stage = $('#stage');
// How much of the feed the sticky top bar and docked launcher cover: the stage's scroll-padding-top,
// which scrollIntoView already honours, so hand-placed cards line up with scrolled-to ones.
const topInset = () => parseFloat(getComputedStyle(stage).scrollPaddingTop) || 0;

function load(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
}
function save(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}
const saveOpen = () => save('wisp.open', [...S.open]);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    // The server only accepts JSON on non-GET requests (CSRF guard), even body-less DELETEs.
    headers: method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const MODES = [
  { id: 'plan', label: 'Plan', icon: 'plan', hint: 'Read-only. The agent investigates and proposes.' },
  { id: 'edits', label: 'Edits', icon: 'pen', hint: 'May edit files. Shell commands that need approval are denied.' },
  { id: 'auto', label: 'Full auto', icon: 'spark', hint: 'No permission prompts at all. Trusted repos only.' },
];
const KIND_ICON = { read: 'read', edit: 'pen', run: 'terminal', search: 'search', web: 'web', agent: 'agent', plan: 'plan', tool: 'tool', text: 'text', error: 'warn', ask: 'ask', answer: 'check', wait: 'ask' };
const STATUS_LABEL = { done: 'Done', partial: 'Partial', blocked: 'Blocked', info: 'Report' };
const agentName = (id) => S.agents.find((a) => a.id === id)?.name || (id === 'wisp' ? 'wisp' : id);

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
function harnessLogo(agent) {
  const l = HARNESS_LOGO[agent];
  const src = l && `/logos/${l.file}.svg`;
  return !l ? icon('spark') : l.mono ? `<i class="mono" style="--logo:url(${src})"></i>` : `<img src="${src}" alt="">`;
}
// Reasoning levels the harness accepts for a model: the model's own list (opencode variants),
// else the harness-wide one. Empty means the harness has no knob for it.
function effortsFor(agent, model) {
  const a = S.agents.find((x) => x.id === agent);
  return a?.models?.find((m) => m.id === model)?.efforts ?? a?.efforts ?? [];
}
const effortLabel = (e) => ({ xhigh: 'X-High' })[e] || e.charAt(0).toUpperCase() + e.slice(1);

function modelBadge(agent, model, effort) {
  if (agent === 'wisp') return '';
  const label = (model && S.agents.find((a) => a.id === agent)?.models?.find((x) => x.id === model)?.label) || model || 'Default model';
  const tip = `${agentName(agent)} · ${label}${effort ? ` · ${effortLabel(effort)} thinking` : ''}`;
  const logo = harnessLogo(agent);
  return `<span class="model-logo" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">${logo}</span>`;
}
const projectById = (id) => S.config.projects.find((p) => p.id === id);

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// --- toasts & overlays -------------------------------------------------------

function toast(html, { tone = '', action, timeout = 4200 } = {}) {
  const t = el(`<div class="toast ${tone}"><span>${html}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}</div>`);
  if (action) t.querySelector('button').onclick = () => (action.run(), t.remove());
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), timeout);
  setTimeout(() => t.remove(), timeout + 400);
}

function overlay(node, { onClose } = {}) {
  const o = $('#overlay');
  o.innerHTML = '';
  o.append(node);
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('on'));
  const close = () => {
    o.classList.remove('on');
    // Another overlay may have replaced this one while it faded (palette → settings): leave that alone.
    setTimeout(() => o.firstChild === node && ((o.hidden = true), (o.innerHTML = '')), 200);
    onClose?.();
  };
  // A block body: an on* handler that returns false cancels the click, which would stop every
  // submit button inside the dialog from submitting its form.
  o.onclick = (e) => {
    if (e.target === o) close();
  };
  o.close = close;
  return close;
}
const closeOverlay = () => !$('#overlay').hidden && $('#overlay').close?.();
// A view opens as its own dialog, or inside another one (Settings) that hands it a host.
// Returns what closes it for good: the whole overlay either way.
function present(node, host) {
  if (host) return host(node);
  const close = overlay(node);
  $('.close', node).onclick = close;
  return close;
}

// --- feed ----------------------------------------------------------------------

function visible(list) {
  return S.filter === 'all' ? list : list.filter((s) => s.projectId === S.filter);
}

// Compare runs (one launch on several harnesses, sharing a groupId) are one task in the feed
// while two or more of them are on the same side of archived: a card with a row per run.
// Keeping one archives the rest, and what's left is an ordinary card again.
function runsOf(s) {
  if (!s.groupId) return [s];
  const runs = [...S.sessions.values()].filter((x) => x.groupId === s.groupId && !x.archived === !s.archived);
  return runs.length > 1 ? runs.sort((a, b) => a.createdAt - b.createdAt) : [s];
}
// The task as a whole: asking if any run asks, working while any works, done once all are.
function taskOf(s) {
  const runs = runsOf(s);
  if (runs.length < 2) return s;
  const state = runs.some((r) => r.state === 'waiting') ? 'waiting' : runs.some((r) => r.state === 'running') ? 'running' : runs.every((r) => r.state === 'done') ? 'done' : 'review';
  return {
    ...runs[0],
    key: `g:${s.groupId}${s.archived ? ':a' : ''}`,
    runs,
    state,
    unread: runs.some((r) => r.unread),
    createdAt: Math.min(...runs.map((r) => r.createdAt)),
    updatedAt: Math.max(...runs.map((r) => r.updatedAt)),
  };
}

function groups() {
  const every = [];
  const seen = new Set();
  for (const s of visible([...S.sessions.values()])) {
    const t = taskOf(s);
    if (t.runs && seen.has(t.key)) continue;
    if (t.runs) seen.add(t.key);
    every.push(t);
  }
  const all = every.filter((s) => !s.archived);
  const needs = all
    .filter((s) => s.state === 'review' || s.state === 'waiting')
    .sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.updatedAt - a.updatedAt);
  // Working items keep launch order so the feed doesn't reshuffle on every tool call.
  const working = all.filter((s) => s.state === 'running').sort((a, b) => b.createdAt - a.createdAt);
  const done = all.filter((s) => s.state === 'done').sort((a, b) => b.updatedAt - a.updatedAt);
  const archived = every.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  return { needs, working, done, archived };
}

function renderFeed() {
  const { needs, working, done, archived } = groups();
  const place = (sec, list, show = true) => {
    const box = $('.f-list', sec);
    sec.hidden = !list.length;
    $('h4 .n', sec).textContent = list.length || '';
    const want = show ? list : [];
    want.forEach((s, i) => {
      const { card } = s.runs ? taskItem(s) : item(s);
      // Only touch the DOM when the order actually changed: moving a node
      // would blur a composer the user is typing in.
      if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
    });
    while (box.children.length > want.length) box.lastElementChild.remove();
  };
  place($('#secNeeds'), needs);
  place($('#secWorking'), working);
  place($('#secDone'), done.slice(0, 60), S.showDone);
  $('#secDone').classList.toggle('collapsed', !S.showDone);
  place($('#secArchived'), archived.slice(0, 60), S.showArchived);
  $('#secArchived').classList.toggle('collapsed', !S.showArchived);

  // Drop nodes for sessions that are gone or filtered out of the feed entirely.
  const tasks = [...needs, ...working, ...done, ...archived];
  const shown = new Set(tasks.flatMap((s) => (s.runs || [s]).map((r) => r.id)));
  for (const [id, n] of S.nodes) if (!shown.has(id)) (n.card.remove(), S.nodes.delete(id), S.full.delete(id));
  const keys = new Set(tasks.map((t) => t.key));
  for (const [key, g] of S.tasks) if (!keys.has(key)) (g.card.remove(), S.tasks.delete(key));

  const empty = !needs.length && !working.length && !done.length && !archived.length;
  $('#feedEmpty').hidden = !empty;
  if (empty)
    $('#feedEmpty').innerHTML = `<div class="orb big"><i></i><i></i><i></i></div><p>${S.filter === 'all' ? 'Nothing yet. Describe a task above and send it off.' : 'Nothing in this project yet.'}</p>`;
  renderFeedHead(needs, working);

  const n = [...S.sessions.values()].filter((s) => (s.state === 'review' && s.unread) || s.state === 'waiting').length;
  document.title = n ? `(${n}) wisp` : 'wisp';
  renderProjects();
}

// A new project filter swaps the whole list; staying at the old offset would drop the user
// somewhere arbitrary in it, so bring the top of the feed back into view.
function feedToTop() {
  const top = $('#feed').getBoundingClientRect().top;
  if (top < topInset()) scrollByPx(top - topInset());
}

function renderFeedHead(needs, working) {
  const parts = [];
  if (working.length) parts.push(`<span class="hs working"><i></i>${working.length} working</span>`);
  if (needs.length) parts.push(`<span class="hs needs"><i></i>${needs.length} need${needs.length === 1 ? 's' : ''} you</span>`);
  // Group headings already carry the counts; only say something when the feed is calm.
  $('#feedHead').innerHTML = parts.length ? '' : '<span class="fh-status"><span class="muted">Nothing needs you.</span></span>';
  $('#feedHead').hidden = !!parts.length;
  placeCollapseAll();
}

// "Collapse all" floats over the page instead of living in the flow: showing it
// never shifts the feed, and it stays reachable deep inside a long open card.
const collapseAllBtn = el(`<button class="collapse-all" title="Collapse all (C) · Esc collapses the focused one"><span></span><kbd>C</kbd></button>`);
document.body.append(collapseAllBtn);
// Collapsing shrinks everything above the reader, which would leave them staring
// at unrelated cards far down the feed. Keep the card they were reading in view.
const collapseAll = () => {
  const anchor = readingCard();
  [...S.open].forEach((id) => collapse(id));
  if (!anchor) return;
  setFocus(anchor, { scroll: false });
  const card = S.nodes.get(anchor)?.card;
  if (card?.isConnected) card.scrollIntoView({ block: 'center' });
};
// The open card covering the most of the viewport; the focused one breaks ties.
function readingCard() {
  let best = null;
  let bestArea = 0;
  for (const id of S.open) {
    const card = S.nodes.get(id)?.card;
    if (!card?.isConnected) continue;
    const r = card.getBoundingClientRect();
    const seen = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) + (id === S.focus ? 1 : 0);
    if (seen > bestArea) (best = id), (bestArea = seen);
  }
  return best || (S.open.has(S.focus) ? S.focus : null);
}
collapseAllBtn.addEventListener('click', collapseAll);
function placeCollapseAll() {
  const open = [...S.open].filter((id) => S.nodes.get(id)?.card.isConnected).length;
  collapseAllBtn.classList.toggle('on', open > 0);
  if (open) collapseAllBtn.firstChild.textContent = open > 1 ? `Collapse all · ${open}` : 'Collapse';
}

// Get (or create) the card for a summary and refresh its header.
function item(s) {
  let n = S.nodes.get(s.id);
  if (!n) {
    const card = el(`<article class="item" data-id="${s.id}"><div class="it-head" role="button" tabindex="-1"></div></article>`);
    n = { card, head: $('.it-head', card), body: null, turnNodes: new Map(), tray: null, showAll: false, unfolded: new Set(), latestTurn: null };
    S.nodes.set(s.id, n);
    n.head.addEventListener('click', (e) => {
      if (n.head.querySelector('[contenteditable="true"]')) return;
      if (e.target.closest('[data-a="quick-done"]')) return toggleDone(s.id);
      setFocus(s.id);
      toggle(s.id);
    });
    card.addEventListener('mousedown', () => setFocus(s.id, { scroll: false }));
    n.head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setFocus(s.id, { scroll: false });
      taskMenu(s.id, e);
    });
    if (S.open.has(s.id)) expand(s.id, { scroll: false });
  }
  renderHead(n, s);
  return n;
}

function renderHead(n, s) {
  if (n.head.querySelector('[contenteditable="true"]')) return;
  const open = S.open.has(s.id);
  const live = s.state === 'running' || s.state === 'waiting';
  const pill =
    s.state === 'waiting'
      ? `<span class="pill st-waiting"><i></i>Asking</span>`
      : s.state === 'review'
        ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || 'Done'}</span>`
        : '';
  if (runsOf(s).length > 1) return renderRunHead(n, s, { open, live, pill });
  n.card.className = `item c-${s.color} st-${s.state} ${s.unread ? 'unread' : ''} ${open ? 'open' : ''} ${S.focus === s.id ? 'focused' : ''}`;
  n.head.innerHTML = `
    <span class="q-dot ${s.state === 'running' ? 'live' : ''} ${s.state === 'waiting' ? 'waiting' : ''}"></span>
    <span class="it-main">
      <span class="it-title">${esc(s.title)}</span>
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open ? '' : `<span class="it-sub">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${s.pr ? prPill(s.pr) : ''}
      ${s.team?.length ? teamStack(s.agent, s.team) : modelBadge(s.agent, s.model, s.effort)}
      ${s.machine ? machinePill(s.machine) : ''}
      <span class="q-proj">${esc(s.project)}</span>
      <span class="q-time">${ago(s.updatedAt)}</span>
      ${s.state === 'review' && !open && !s.archived ? `<button class="it-quick" data-a="quick-done" title="Mark done (E)">${icon('done')}</button>` : ''}
      ${icon('chevron', 'chev')}
    </span>`;
}

// One run inside a compare task: the harness and model stand in for the title the task shows.
function renderRunHead(n, s, { open, live, pill }) {
  const a = S.agents.find((x) => x.id === s.agent);
  const model = (s.model && a?.models?.find((m) => m.id === s.model)?.label) || s.model || 'Default model';
  n.card.className = `item run c-${s.color} st-${s.state} ${s.unread ? 'unread' : ''} ${open ? 'open' : ''} ${S.focus === s.id ? 'focused' : ''}`;
  n.head.innerHTML = `
    <span class="run-logo">${harnessLogo(s.agent)}</span>
    <span class="it-main">
      <span class="it-title"><b>${esc(a?.name || agentName(s.agent))}</b><span class="run-model">${esc(model)}${s.effort ? ` · ${esc(effortLabel(s.effort))}` : ''}</span></span>
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open ? '' : `<span class="it-sub">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${runsOf(s).some((r) => (r.machine?.id || '') !== (s.machine?.id || '')) ? `${s.machine ? machinePill(s.machine) : `<span class="q-machine" title="Runs on this computer">${icon('laptop')}<span>This computer</span></span>`}<span class="q-proj">${esc(s.project)}</span>` : ''}
      ${live && s.state === 'running' ? `<span class="pill st-running"><i></i>Working</span>` : pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${s.pr ? prPill(s.pr) : ''}
      <span class="q-time">${ago(s.updatedAt)}</span>
      ${icon('chevron', 'chev')}
    </span>`;
}

// The card for a compare task: the shared prompt on top, one row per run (each an ordinary,
// expandable item), and the side-by-side view one click away.
function taskItem(t) {
  let g = S.tasks.get(t.key);
  if (!g) {
    const card = el(`<section class="task-item"><header class="task-head"></header><div class="task-runs"></div></section>`);
    g = { card, head: $('.task-head', card), runs: $('.task-runs', card) };
    S.tasks.set(t.key, g);
    g.head.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      const ids = (taskOf(S.sessions.get(g.lead) || {}).runs || []).map((r) => r.id);
      if (a === 'compare') return compareView(g.lead);
      if (a === 'quick-done') return taskDone(ids.filter((id) => S.sessions.get(id)?.state === 'review'));
    });
  }
  g.lead = t.id;
  const finished = t.runs.filter((r) => r.state === 'review' || r.state === 'done').length;
  const places = new Set(t.runs.map((r) => r.machine?.id || '')).size;
  const status = t.state === 'waiting' ? 'A run is asking you' : t.state === 'running' ? `${finished} of ${t.runs.length} finished${places > 1 ? ` · on ${places} machines` : ''}` : t.state === 'done' ? 'Done' : places > 1 ? `All finished on ${places} machines` : 'All finished · pick one to keep';
  g.card.className = `task-item c-${t.color} st-${t.state} ${t.unread ? 'unread' : ''}`;
  g.head.innerHTML = `
    <span class="q-dot ${t.state === 'running' ? 'live' : ''} ${t.state === 'waiting' ? 'waiting' : ''}"></span>
    <span class="it-main">
      <span class="it-title">${esc(t.title)}</span>
      <span class="it-sub">${esc(status)}</span>
    </span>
    <span class="it-side">
      <button class="ghost xs" data-a="compare" title="Side by side: time, cost, changes, tests and each presentation"><b class="vs-mark">vs</b><span>Compare</span></button>
      ${places > 1 ? '' : `<span class="q-proj">${esc(t.project)}</span>`}
      <span class="q-time">${ago(t.updatedAt)}</span>
      ${t.state === 'review' && !t.archived ? `<button class="it-quick" data-a="quick-done" title="Mark every run done">${icon('done')}</button>` : ''}
    </span>`;
  t.runs.forEach((r, i) => {
    const { card } = item(r);
    if (g.runs.children[i] !== card) g.runs.insertBefore(card, g.runs.children[i] || null);
  });
  while (g.runs.children.length > t.runs.length) g.runs.lastElementChild.remove();
  return g;
}

function setFocus(id, { scroll = true } = {}) {
  if (S.focus === id) return;
  S.nodes.get(S.focus)?.card.classList.remove('focused');
  S.focus = id;
  const n = S.nodes.get(id);
  n?.card.classList.add('focused');
  // A card taller than the screen would land with its header out of view ('nearest' aligns
  // its far edge when moving up), so bring its top in instead.
  if (scroll && n) n.card.scrollIntoView({ block: n.card.offsetHeight > stage.clientHeight - topInset() ? 'start' : 'nearest', behavior: 'smooth' });
}

function toggle(id) {
  S.open.has(id) ? collapse(id) : expand(id);
}

async function expand(id, { scroll = true } = {}) {
  const n = S.nodes.get(id);
  if (!n) return;
  S.open.add(id);
  saveOpen();
  n.card.classList.add('open');
  renderHead(n, S.sessions.get(id));
  if (!n.body) {
    n.body = el(`<div class="it-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>`);
    n.card.append(n.body);
  }
  renderFeedHead(groups().needs, groups().working);
  if (scroll) requestAnimationFrame(() => n.card.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  if (!S.full.has(id)) await fetchFull(id);
  else renderBody(id, { fresh: true });
}

function collapse(id) {
  const n = S.nodes.get(id);
  S.open.delete(id);
  saveOpen();
  S.full.delete(id);
  if (n) {
    n.body?.remove();
    n.body = null;
    n.turnNodes.clear();
    n.tray = null;
    n.showAll = false;
    n.card.classList.remove('open');
    const s = S.sessions.get(id);
    if (s) renderHead(n, s);
  }
  renderFeedHead(groups().needs, groups().working);
}

async function fetchFull(id) {
  const s = await api(`/sessions/${id}`).catch(() => null);
  if (!s) {
    S.open.delete(id);
    saveOpen();
    return;
  }
  if (!S.open.has(id)) return; // collapsed while loading
  const fresh = !S.full.has(id);
  S.full.set(id, s);
  renderBody(id, { fresh });
  if (s.unread && s.state !== 'running' && document.hasFocus()) api(`/sessions/${id}`, { method: 'PATCH', body: { unread: false } }).catch(() => {});
}

const refetchTimers = new Map();
function scheduleRefetch(id) {
  if (!S.open.has(id)) return;
  clearTimeout(refetchTimers.get(id));
  refetchTimers.set(id, setTimeout(() => (refetchTimers.delete(id), fetchFull(id)), 120));
}

// --- attachments ---------------------------------------------------------------

function attachTray() {
  const items = [];
  const node = el(`<div class="tray" hidden></div>`);
  const fileInput = el(`<input type="file" multiple hidden>`);
  document.body.append(fileInput);
  const render = () => {
    node.hidden = !items.length;
    node.innerHTML = items
      .map(
        (it, i) => `<div class="att ${it.status}" data-i="${i}" title="${esc(it.name)}">
          ${it.thumb ? `<img src="${it.thumb}" alt="">` : `<span class="att-ic">${icon(it.mime.startsWith('video') ? 'web' : 'file')}</span>`}
          <span class="att-name">${esc(it.name)}</span><span class="att-size">${fmtSize(it.size)}</span>
          <button class="att-x" title="Remove">${icon('x')}</button>
        </div>`,
      )
      .join('');
  };
  node.addEventListener('click', (e) => {
    const x = e.target.closest('.att-x');
    if (x) {
      items.splice(Number(x.closest('.att').dataset.i), 1);
      render();
    }
  });
  const add = (files) => {
    for (const f of files) {
      const it = { name: f.name || 'pasted', size: f.size, mime: f.type || '', status: 'uploading', thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      items.push(it);
      it.promise = fetch(`/api/uploads?name=${encodeURIComponent(it.name)}&type=${encodeURIComponent(it.mime)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: f,
      })
        .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
        .then((j) => ((it.id = j.id), (it.status = 'ready'), render()))
        .catch((err) => ((it.status = 'failed'), render(), toast(`Upload failed: ${esc(err.message)}`, { tone: 'bad' })));
    }
    render();
  };
  fileInput.onchange = () => (add(fileInput.files), (fileInput.value = ''));
  return {
    node,
    add,
    pick: () => fileInput.click(),
    async ids() {
      await Promise.allSettled(items.map((i) => i.promise));
      return items.filter((i) => i.id).map((i) => i.id);
    },
    clear() {
      items.length = 0;
      render();
    },
    get busy() {
      return items.some((i) => i.status === 'uploading');
    },
  };
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Wire paste + drag/drop of files onto a container.
function acceptFiles(container, textarea, tray) {
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      tray.add(files);
    }
  });
  container.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('drop');
    }
  });
  container.addEventListener('dragleave', (e) => !container.contains(e.relatedTarget) && container.classList.remove('drop'));
  container.addEventListener('drop', (e) => {
    container.classList.remove('drop');
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      tray.add(e.dataTransfer.files);
    }
  });
}

function autosize(ta, max = 340) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

// --- launcher ----------------------------------------------------------------------

let launchProject = load('wisp.launchProject', null); // the project picked in the first place below
// Where the launcher sends a prompt: '' = this computer, else machine ids. Several run in parallel,
// each in the project picked for it (launchPicks[place]), and show up as one task.
let launchWhere = load('wisp.launchWhere', ['']);
let launchPicks = load('wisp.launchPicks', {});
const placeOf = (p) => p?.machine || '';
const placeName = (k) => (k ? machineById(k)?.name || 'machine' : 'This computer');
const recentFirst = (a, b) => (b.lastUsedAt || b.addedAt) - (a.lastUsedAt || a.addedAt);
const projectsAt = (k) => S.config.projects.filter((p) => placeOf(p) === k).sort(recentFirst);
const saveWhere = () => (save('wisp.launchWhere', launchWhere), save('wisp.launchPicks', launchPicks), save('wisp.launchProject', launchProject));
function syncWhere() {
  launchWhere = launchWhere.filter((k, i) => (!k || machineById(k)) && launchWhere.indexOf(k) === i);
  if (!launchWhere.length) launchWhere = [''];
  // Filtering the feed to a project points the launcher at it (its machine joins if it wasn't picked).
  const f = S.filter !== 'all' && projectById(S.filter);
  if (f) {
    if (!launchWhere.includes(placeOf(f))) launchWhere = [placeOf(f)];
    launchPicks[placeOf(f)] = f.id;
  } else if (projectById(launchProject) && !Object.values(launchPicks).includes(launchProject)) launchPicks[placeOf(projectById(launchProject))] ??= launchProject;
  for (const k of launchWhere) if (!projectsAt(k).some((p) => p.id === launchPicks[k])) launchPicks[k] = projectsAt(k)[0]?.id || null;
  launchProject = launchPicks[launchWhere[0]] || null;
}

// The model is remembered per harness (ids aren't portable between them).
function savedModel(id) {
  const d = S.config.defaults;
  const want = d.models?.[id] ?? (id === d.agent ? d.model : '');
  const models = S.agents.find((a) => a.id === id)?.models || [];
  return models.some((m) => m.id === want) ? want : '';
}
// Thinking level too, and only if the chosen model still accepts it.
function savedEffort(id, model) {
  const d = S.config.defaults;
  const want = d.efforts?.[id] ?? (id === d.agent ? d.effort : '');
  return effortsFor(id, model).includes(want) ? want : '';
}

function renderLauncher() {
  const box = $('#launcher');
  const mode = S.config.defaults.mode || 'edits';
  const ready = S.agents.filter((a) => a.available);
  const chosen = S.agents.find((a) => a.id === (S.config.defaults.agent || 'claude'));
  let agent = chosen?.available ? chosen : ready[0] || chosen || S.agents[0];
  box.innerHTML = `
    <div class="l-projects"></div>
    <textarea id="prompt" rows="2" spellcheck="false"></textarea>
    <div class="l-bar">
      <button class="icon-btn" id="attach" title="Attach files">${icon('clip')}</button>
      <button class="mode-btn" id="mode" aria-haspopup="menu"></button>
      <div class="runners">
        <button class="runner-btn" id="runner" title="Harness and model" aria-haspopup="dialog"></button>
        <button class="vs-btn" id="compareBtn" aria-pressed="false"><span>vs</span>${icon('x')}</button>
        <button class="runner-btn" id="runner2" title="Second harness to compare with" aria-haspopup="dialog" hidden></button>
      </div>
      <button class="tog-btn where-btn" id="whereBtn" aria-haspopup="menu"></button>
      <button class="tog-btn team-btn" id="teamBtn" aria-haspopup="dialog"></button>
      <span class="grow"></span>
      <button class="tog-btn" id="wtBtn"></button>
      <button class="send" id="launch" title="Launch (Enter · Shift+Enter for newline)">${icon('enter')}</button>
    </div>
    <div class="l-recipes"></div>`;
  renderLaunchChips();

  const ta = $('#prompt', box);
  const tray = attachTray();
  ta.before(tray.node);
  acceptFiles(box, ta, tray);
  autosize(ta);
  ta.value = S.drafts.get('home') || '';
  ta.addEventListener('input', () => (S.drafts.set('home', ta.value), paintSaveRecipe()));
  // While focus is elsewhere, the placeholder advertises the shortcut that brings you back.
  const hint = () => (ta.placeholder = document.activeElement === ta
    ? 'What should I go do? Paste screenshots, drop logs or videos…'
    : `What should I go do? Press ${combo('L')} to start typing`);
  ta.addEventListener('focus', hint);
  ta.addEventListener('blur', hint);
  hint();
  // Docked and folded to one line, a click anywhere on it opens it up for typing.
  box.addEventListener('mousedown', (e) => {
    if (!box.matches('.docked:not(:focus-within)')) return;
    e.preventDefault();
    ta.focus();
  });
  $('#attach', box).onclick = tray.pick;
  $('#whereBtn', box).onclick = (e) => whereMenu(e.currentTarget);
  paintWhereBtn();

  // Mode is set-and-forget, so it's one small button: just an icon on the default (Edits),
  // spelled out when it's Plan or Full auto so you can't miss it.
  let curMode = mode;
  const modeBtn = $('#mode', box);
  const paintMode = () => {
    const m = MODES.find((x) => x.id === curMode) || MODES[1];
    modeBtn.className = `mode-btn m-${m.id}`;
    modeBtn.innerHTML = `${icon(m.icon)}${m.id === 'edits' ? '' : `<span>${m.label}</span>`}`;
    modeBtn.title = `${m.label}: ${m.hint}\nShift+Tab to switch`;
  };
  const setMode = (id) => {
    curMode = id;
    S.config.defaults.mode = id;
    paintMode();
    api('/config', { method: 'PATCH', body: { defaults: { mode: id } } }).catch(() => {});
  };
  paintMode();
  modeBtn.onclick = () => modeMenu(modeBtn, curMode, setMode);
  box.mode = () => curMode;
  let curModel = savedModel(agent?.id);
  let curEffort = savedEffort(agent?.id, curModel);
  const runnerBtn = $('#runner', box);
  const paintRunner = () => {
    paintRunnerBtn(runnerBtn, agent?.id, curModel, curEffort);
    runnerBtn.title = `Harness, model and thinking level${curEffort ? `\nThinking: ${effortLabel(curEffort)}` : ''}`;
  };
  paintRunner();

  // Worktree: each launch gets a fresh branch from the remote's default branch (git repos only).
  const wtBtn = $('#wtBtn', box);
  const paintWt = () => {
    const on = S.config.defaults.worktree !== 'off';
    wtBtn.classList.toggle('on', on);
    wtBtn.innerHTML = `${icon('branch')}<span>${on ? 'Worktree' : 'In place'}</span>`;
    wtBtn.title = on
      ? 'Worktree: runs on its own branch from origin/main in a separate checkout, so parallel agents never collide (git repos; not in Plan mode). Click to work in the project folder instead.'
      : 'In place: edits the project folder directly. Click to give each task its own worktree and branch.';
  };
  paintWt();
  wtBtn.onclick = () => {
    const worktree = S.config.defaults.worktree === 'off' ? 'on' : 'off';
    S.config.defaults.worktree = worktree;
    paintWt();
    api('/config', { method: 'PATCH', body: { defaults: { worktree } } }).catch(() => {});
  };

  // Subagents: remembered like the other picks, so a team stays set until you clear it.
  let team = (S.config.defaults.subagents || []).filter((m) => S.agents.some((a) => a.id === m.agent));
  let teamPreset = S.config.defaults.teamPreset || '';
  const teamBtn = $('#teamBtn', box);
  const paintTeam = () => paintTeamBtn(teamBtn, team, teamPreset, agent?.id);
  paintTeam();
  teamBtn.onclick = () =>
    teamEditor(teamBtn, { lead: agent?.id, team, presetId: teamPreset }, (members, preset) => {
      if (JSON.stringify([members, preset]) === JSON.stringify([team, teamPreset])) return;
      team = members;
      teamPreset = preset;
      Object.assign(S.config.defaults, { subagents: team, teamPreset });
      paintTeam();
      api('/config', { method: 'PATCH', body: { defaults: { subagents: team, teamPreset } } }).catch(() => {});
    });

  // Compare: a second harness gets the same task; picks here don't touch the launcher defaults.
  let compare = null;
  const vsBtn = $('#compareBtn', box);
  const runner2 = $('#runner2', box);
  const paintCompare = () => {
    vsBtn.parentElement.classList.toggle('cmp', !!compare);
    vsBtn.setAttribute('aria-pressed', String(!!compare));
    vsBtn.title = compare ? 'Stop comparing' : 'Compare: run the same task on a second harness, side by side';
    runner2.hidden = !compare;
    if (compare) paintRunnerBtn(runner2, compare.agent, compare.model, compare.effort);
  };
  paintCompare();
  vsBtn.onclick = () => {
    if (compare) compare = null;
    else {
      const other = S.agents.find((a) => a.available && a.id !== agent?.id) || agent;
      compare = { agent: other?.id, model: savedModel(other?.id), effort: savedEffort(other?.id, savedModel(other?.id)) };
    }
    paintCompare();
  };
  runner2.onclick = () =>
    runnerPicker(runner2, { ...compare, savedModel, savedEffort }, (id, model, effort) => {
      compare = { agent: id, model, effort };
      paintCompare();
    });
  runnerBtn.onclick = () =>
    runnerPicker(runnerBtn, { agent: agent?.id, model: curModel, effort: curEffort, savedModel, savedEffort }, (id, model, effort) => {
      agent = S.agents.find((a) => a.id === id);
      curModel = model;
      curEffort = effort;
      paintRunner();
      paintTeam();
      const d = S.config.defaults;
      const models = { ...d.models, [id]: model };
      // A model without levels leaves the harness's saved level alone, so switching back restores it.
      const efforts = effort || effortsFor(id, model).length ? { ...d.efforts, [id]: effort } : d.efforts;
      Object.assign(d, { agent: id, model, models, effort, efforts });
      api('/config', { method: 'PATCH', body: { defaults: { agent: id, model, models, effort, efforts } } }).catch(() => {});
    });

  const launch = async () => {
    const prompt = ta.value.trim();
    if (!prompt) return ta.focus();
    // One run per place picked under "Run on", each in the project picked for it.
    const targets = launchWhere.map((k) => ({ k, m: k ? machineById(k) : null, project: projectById(launchPicks[k]) }));
    const unset = targets.find((t) => !t.project);
    if (unset) return openProjects({ focusAdd: true, machine: unset.k || null });
    const off = targets.find((t) => t.m && t.m.state !== 'online');
    if (off) return offlineToast(off.k);
    const wanted = [agent?.id, ...(compare ? [compare.agent] : [])];
    for (const t of targets) {
      const missing = t.m?.remote?.agents && wanted.find((id) => !t.m.remote.agents.some((x) => x.id === id && x.available));
      if (missing) return toast(`${esc(agentName(missing))} isn’t installed on <b>${esc(t.m.name)}</b>`, { tone: 'bad' });
    }
    const btn = $('#launch', box);
    btn.disabled = true;
    btn.classList.add('busy'); // a fetch and fresh worktrees can take a second or two
    try {
      const attachments = await tray.ids();
      // Several places: one shared groupId, so the runs land as one task with a row each.
      const groupId = targets.length > 1 ? [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('') : undefined;
      const results = await Promise.allSettled(
        targets.map((t) =>
          api('/sessions', {
            method: 'POST',
            body: { prompt, cwd: t.project.path, machine: t.k || undefined, groupId, agent: agent?.id || 'claude', mode: curMode, model: curModel, effort: curEffort, attachments, worktree: S.config.defaults.worktree === 'off' && !compare ? false : undefined, compare: compare ? [compare] : undefined, subagents: team.length && canLead(agent?.id) ? team : undefined },
          }),
        ),
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') toast(`${esc(placeName(targets[i].k))}: ${esc(r.reason.message)}`, { tone: 'bad' });
      });
      const started = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (!started.length) return;
      for (const x of started.flatMap((y) => y.group || [y])) S.sessions.set(x.id, x);
      const s = started[0];
      if (compare) (compare = null), paintCompare();
      ta.value = '';
      S.drafts.delete('home');
      tray.clear();
      ta.dispatchEvent(new Event('input'));
      if (S.filter !== 'all' && (started.length > 1 || S.filter !== s.projectId)) {
        S.filter = 'all';
        save('wisp.filter', S.filter);
      }
      renderFeed();
      const card = S.nodes.get(s.id)?.card;
      showLaunched(btn, card?.closest('.task-item') || card);
      askNotify();
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      ta.focus();
    }
  };
  $('#launch', box).onclick = launch;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      launch();
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setMode(MODES[(MODES.findIndex((m) => m.id === curMode) + 1) % MODES.length].id);
    }
  });
}

// The harness · model · thinking button, as in the launcher. agent '' reads "Launcher default".
function paintRunnerBtn(btn, agentId, model, effort) {
  const a = S.agents.find((x) => x.id === agentId);
  const m = (a?.models || []).find((x) => x.id === model);
  btn.innerHTML = agentId
    ? `<span class="rb-logo">${harnessLogo(agentId)}</span><span class="rb-h">${esc(a?.name || agentName(agentId))}</span><span class="rb-m">${esc(m && m.id ? m.label : 'Default')}</span>${effort ? `<span class="rb-e">${esc(effortLabel(effort))}</span>` : ''}${icon('chevron', 'chev')}`
    : `<span class="rb-logo">${icon('spark')}</span><span class="rb-h">Launcher default</span>${icon('chevron', 'chev')}`;
}

// --- subagents -------------------------------------------------------------------
// A team the lead can delegate to: any harness, model and thinking level per member, plus the
// user's "use it for" note. Picked in the launcher, saved as presets, shown on cards and turns.

const MAX_TEAM = 6; // rows
const MAX_COPIES = 5; // parallel copies of one row
const MAX_INSTANCES = 12; // copies across the team
const copiesOf = (m) => Math.max(1, m.count || 1);
const teamSize = (team) => team.reduce((n, m) => n + copiesOf(m), 0);
const canLead = (id) => S.agents.find((a) => a.id === id)?.delegates !== false;
const memberLabel = (m) => {
  const a = S.agents.find((x) => x.id === m.agent);
  const model = (m.model && a?.models?.find((x) => x.id === m.model)?.label) || m.model || 'Default model';
  return `${a?.name || agentName(m.agent)} · ${model}${m.effort ? ` · ${effortLabel(m.effort)}` : ''}`;
};
const slugName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
// Same rule as the server: blank names become the harness id, repeats get -2, -3…
function uniqueNames(members) {
  const taken = new Set();
  return members.map((m) => {
    const base = slugName(m.name) || m.agent;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    return { ...m, name };
  });
}

// The lead's logo with its subagents' tucked behind it; they fan out on hover. A member that
// is working pulses; one the lead never used is dimmed.
function teamStack(lead, team) {
  const shown = team.slice(0, 4);
  const tip = `${agentName(lead)} with ${team.map((m) => `${m.name}${m.busy ? ' (working)' : m.used === false ? ' (unused)' : ''}`).join(', ')}`;
  return `<span class="team-stack" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">
    <span class="ts-l">${harnessLogo(lead)}</span>
    ${shown.map((m, i) => `<span class="ts-m${m.used === false ? ' idle' : ''}${m.busy ? ' busy' : ''}" style="--i:${i}">${harnessLogo(m.agent)}</span>`).join('')}
    ${team.length > shown.length ? `<span class="ts-m ts-more" style="--i:${shown.length}">+${team.length - shown.length}</span>` : ''}
  </span>`;
}

// Launcher button: a stack of the members' logos and the preset's name, or just "Subagents".
function paintTeamBtn(btn, team, presetId, lead) {
  const ok = canLead(lead);
  const flat = team.flatMap((m) => Array(copiesOf(m)).fill(m));
  const n = flat.length;
  const p = (S.config.teams || []).find((x) => x.id === presetId);
  btn.classList.toggle('on', team.length > 0 && ok);
  btn.classList.toggle('off', team.length > 0 && !ok);
  btn.innerHTML = team.length
    ? `<span class="tb-stack">${flat.slice(0, 5).map((m, i) => `<span class="ts-m" style="--i:${i}">${harnessLogo(m.agent)}</span>`).join('')}${n > 5 ? `<span class="ts-m ts-more" style="--i:5">+${n - 5}</span>` : ''}</span><span class="tb-label">${esc(p?.name || `${n} subagent${n > 1 ? 's' : ''}`)}</span>`
    : `${icon('agent')}<span class="tb-label">Subagents</span>`;
  btn.title = !team.length
    ? 'Subagents: give the lead a team on other harnesses to delegate to'
    : ok
      ? `Subagents the lead can delegate to:\n${team.map((m) => `• ${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n')}`
      : `${agentName(lead)} can't delegate (wisp can't give it tools), so this launch runs without subagents`;
}

function teamEditor(anchor, { lead, team, presetId }, onChange) {
  const open = $('.team-pop');
  if (open) return open.close();
  let members = team.map((m) => ({ ...m }));
  let preset = presetId;
  const r = anchor.getBoundingClientRect();
  const width = Math.min(540, innerWidth - 24);
  const left = Math.max(12, Math.min(r.left, innerWidth - 12 - width));
  const below = r.bottom + 440 < innerHeight;
  const node = el(`
    <div class="team-pop" role="dialog" aria-label="Subagents" style="left:${left}px;width:${width}px;${below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <header class="tp-head">
        <div class="tp-title"><b>Subagents</b><small>The lead hands tasks to these, each on its own harness. Tell it what each one is for.</small></div>
        <button class="ghost xs tp-presets" aria-haspopup="menu">${icon('agent')}<span>Presets</span>${icon('chevron', 'chev')}</button>
      </header>
      <div class="tp-warn" hidden></div>
      <div class="tp-list"></div>
      <footer class="tp-foot"></footer>
    </div>`);
  const list = $('.tp-list', node);
  const foot = $('.tp-foot', node);
  const commit = () => onChange(uniqueNames(members), preset);
  let typing;
  const commitSoon = () => (clearTimeout(typing), (typing = setTimeout(commit, 300)));

  const paintWarn = () => {
    const w = $('.tp-warn', node);
    w.hidden = canLead(lead);
    w.innerHTML = `${icon('warn')}<span>${esc(agentName(lead))} can't delegate: wisp can't give it tools. Pick Claude Code, Codex or opencode as the lead to use these.</span>`;
  };
  const paintFoot = () => {
    foot.innerHTML = `
      <button class="ghost sm tp-add" ${members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES ? 'disabled' : ''}>${icon('plus')}Add subagent</button>
      <span class="tp-count" title="Agents in all, counting copies (max ${MAX_INSTANCES})">${teamSize(members)} agent${teamSize(members) === 1 ? '' : 's'}</span>
      <span class="grow"></span>
      ${members.length ? `<button class="link xs tp-clear">Clear</button><button class="ghost sm tp-save">${icon('check')}Save as preset</button>` : ''}`;
  };
  const paintList = () => {
    const named = uniqueNames(members);
    list.innerHTML = members.length
      ? members
          .map(
            (m, i) => `<div class="tp-row" data-i="${i}">
              <div class="tp-top">
                <button class="runner-btn tp-runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button>
                <span class="tp-copies${copiesOf(m) > 1 ? ' on' : ''}" title="Copies: identical agents that take tasks in parallel">
                  <button class="tp-dec" aria-label="One copy fewer" ${copiesOf(m) <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
                  <b>×${copiesOf(m)}</b>
                  <button class="tp-inc" aria-label="One copy more" ${copiesOf(m) >= MAX_COPIES || teamSize(members) >= MAX_INSTANCES ? 'disabled' : ''}>${icon('plus')}</button>
                </span>
                <label class="field sm mono tp-name" title="What the lead calls it"><span>@</span><input value="${esc(m.name || '')}" placeholder="${esc(named[i].name)}" maxlength="24" spellcheck="false" autocomplete="off"></label>
                <button class="icon-btn tp-del" title="Remove">${icon('x')}</button>
              </div>
              <label class="field sm tp-use"><span>Use for</span><input value="${esc(m.use || '')}" placeholder="e.g. image and UI work · research · writing tests" maxlength="300" spellcheck="false" autocomplete="off"></label>
            </div>`,
          )
          .join('')
      : `<div class="tp-empty">${icon('agent')}<p>No subagents yet. Add one per harness you want the lead to use, like Codex for tests or opencode for research.</p></div>`;
    $$('.tp-row', list).forEach((row, i) => paintRunnerBtn($('.tp-runner', row), members[i].agent, members[i].model, members[i].effort));
    paintFoot();
  };
  const add = () => {
    if (members.length >= MAX_TEAM || teamSize(members) >= MAX_INSTANCES) return;
    const used = new Set([lead, ...members.map((m) => m.agent)]);
    const a = S.agents.find((x) => x.available && !used.has(x.id)) || S.agents.find((x) => x.available && x.id !== lead) || S.agents.find((x) => x.available);
    if (!a) return toast('No harness is installed.', { tone: 'bad' });
    const model = savedModel(a.id);
    members.push({ name: '', agent: a.id, model, effort: savedEffort(a.id, model), use: '', count: 1 });
    paintList();
    commit();
    $(`.tp-row[data-i="${members.length - 1}"] .tp-use input`, list)?.focus();
  };

  // Save: name it; an existing preset's name updates that preset.
  const askName = () => {
    const cur = (S.config.teams || []).find((x) => x.id === preset);
    foot.innerHTML = `<form class="tp-saveform"><input class="input sm" placeholder="Preset name, e.g. Review crew" value="${esc(cur?.name || '')}" maxlength="60"><button class="primary sm">Save</button><button type="button" class="link xs tp-cancel">Cancel</button></form>`;
    const input = $('input', foot);
    input.focus();
    input.select();
    $('.tp-cancel', foot).onclick = paintFoot;
    $('form', foot).onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return input.focus();
      const same = (S.config.teams || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
      try {
        const p = await api(same ? `/teams/${same.id}` : '/teams', { method: same ? 'PATCH' : 'POST', body: { name, members: uniqueNames(members) } });
        S.config.teams = [...(S.config.teams || []).filter((x) => x.id !== p.id), p];
        preset = p.id;
        commit();
        paintFoot();
        toast(`${same ? 'Updated' : 'Saved'} preset <b>${esc(p.name)}</b>`);
      } catch (err) {
        toast(esc(err.message), { tone: 'bad' });
      }
    };
  };

  const presetMenu = (btn) => {
    const prev = $('.menu.tp-menu');
    if (prev) return prev.close();
    const teams = S.config.teams || [];
    const b = btn.getBoundingClientRect();
    const menu = el(`
      <div class="menu tp-menu" role="menu" style="top:${b.bottom + 4}px;right:${innerWidth - b.right}px">
        ${teams.length
          ? teams
              .map(
                (t) => `<button role="menuitem" data-id="${esc(t.id)}" class="${t.id === preset ? 'on' : ''}">
                  <span class="tb-stack">${t.members.slice(0, 4).map((m, i) => `<span class="ts-m" style="--i:${i}">${harnessLogo(m.agent)}</span>`).join('')}</span>
                  <span class="mm-text"><b>${esc(t.name)}</b><small>${esc(t.members.map((m) => m.name).join(', '))}</small></span>
                  <span class="tp-mdel" data-del="${esc(t.id)}" title="Delete preset">${icon('trash')}</span>
                </button>`,
              )
              .join('')
          : `<div class="tp-mempty">No presets yet. Set up a team, then <b>Save as preset</b>.</div>`}
      </div>`);
    const close = () => (menu.remove(), document.removeEventListener('mousedown', outsideMenu, true));
    const outsideMenu = (ev) => !menu.contains(ev.target) && !btn.contains(ev.target) && close();
    menu.close = close;
    setTimeout(() => document.addEventListener('mousedown', outsideMenu, true));
    menu.onclick = async (ev) => {
      const del = ev.target.closest('[data-del]');
      if (del) {
        ev.stopPropagation();
        const t = teams.find((x) => x.id === del.dataset.del);
        await api(`/teams/${t.id}`, { method: 'DELETE' }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
        S.config.teams = (S.config.teams || []).filter((x) => x.id !== t.id);
        if (preset === t.id) (preset = ''), commit();
        close();
        return toast(`Deleted preset <b>${esc(t.name)}</b>`);
      }
      const item = ev.target.closest('button[data-id]');
      if (!item) return;
      const t = teams.find((x) => x.id === item.dataset.id);
      members = t.members.map((m) => ({ ...m }));
      preset = t.id;
      close();
      paintList();
      commit();
    };
    document.body.append(menu);
  };

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.tp-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('.tp-del')) {
      members.splice(i, 1);
      paintList();
      return commit();
    }
    const step = e.target.closest('.tp-inc') ? 1 : e.target.closest('.tp-dec') ? -1 : 0;
    if (step) {
      const m = members[i];
      const next = copiesOf(m) + step;
      if (next < 1 || next > MAX_COPIES || (step > 0 && teamSize(members) >= MAX_INSTANCES)) return;
      m.count = next;
      paintList();
      $(`.tp-row[data-i="${i}"] ${step > 0 ? '.tp-inc' : '.tp-dec'}`, list)?.focus();
      return commit();
    }
    const rb = e.target.closest('.tp-runner');
    if (rb) {
      const m = members[i];
      runnerPicker(rb, { agent: m.agent, model: m.model, effort: m.effort, savedModel, savedEffort }, (agent, model, effort) => {
        Object.assign(m, { agent, model, effort });
        paintList();
        commit();
      });
    }
  });
  list.addEventListener('input', (e) => {
    const row = e.target.closest('.tp-row');
    if (!row) return;
    const m = members[Number(row.dataset.i)];
    if (e.target.closest('.tp-name')) m.name = e.target.value;
    else m.use = e.target.value;
    commitSoon();
  });
  foot.addEventListener('click', (e) => {
    if (e.target.closest('.tp-add')) add();
    if (e.target.closest('.tp-save')) askName();
    if (e.target.closest('.tp-clear')) {
      members = [];
      preset = '';
      paintList();
      commit();
    }
  });
  $('.tp-presets', node).onclick = (e) => presetMenu(e.currentTarget);

  const close = () => {
    clearTimeout(typing);
    commit();
    node.remove();
    $('.menu.tp-menu')?.close();
    anchor.classList.remove('open');
    document.removeEventListener('mousedown', outside);
  };
  node.close = close;
  // The harness picker and preset menu float outside the popover; clicks there keep it open.
  const outside = (e) => !node.contains(e.target) && !anchor.contains(e.target) && !e.target.closest('.picker, .tp-menu') && close();
  node.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), close(), anchor.focus()));
  setTimeout(() => document.addEventListener('mousedown', outside));
  paintWarn();
  paintList();
  document.body.append(node);
  anchor.classList.add('open');
  if (!members.length) $('.tp-add', node)?.focus();
}

// One delegation with the child session and turn it ran as (from the lead's childSessions).
function delegationsOf(s, t) {
  return (t.delegations || []).map((d) => {
    const child = s.childSessions?.[d.sessionId];
    return { d, child, ct: child?.turns.find((x) => x.id === d.turnId) };
  });
}
const subKey = (s, t) => delegationsOf(s, t).map(({ ct }) => ct?.status || '?').join(',');
const subStatus = (ct) => {
  if (!ct || ct.status === 'running') return { cls: 'waiting', label: 'Working' };
  if (ct.status === 'stopped') return { cls: 'partial', label: 'Stopped' };
  if (ct.status === 'error') return { cls: 'blocked', label: 'Failed' };
  const st = ct.presentation?.blocks?.find((b) => b.type === 'hero')?.status || 'done';
  return { cls: st, label: STATUS_LABEL[st] || 'Done' };
};

// While the lead works: one live line per subagent it's waiting on.
function teamLiveHtml(s, t) {
  const list = delegationsOf(s, t);
  if (!list.length) return '';
  return `<div class="team-live">${list
    .map(({ d, ct }) => {
      const running = !ct || ct.status === 'running';
      const hero = ct?.presentation?.blocks?.find((b) => b.type === 'hero');
      const last = ct?.activity?.findLast((a) => a.kind !== 'text')?.label;
      const st = subStatus(ct);
      return `<div class="tl-row ${running ? 'live' : `st-${st.cls}`}" data-sub="${esc(d.sessionId)}">
        <span class="tl-logo">${harnessLogo(d.agent)}</span>
        <b class="tl-name">@${esc(d.name)}</b>
        <span class="tl-live">${esc(running ? last || 'Starting up' : hero?.title || st.label)}</span>
        ${running ? `<span class="elapsed" data-start="${ct?.startedAt || d.startedAt}">${fmtDuration(Date.now() - (ct?.startedAt || d.startedAt))}</span>` : `<span class="pill st-${st.cls}"><i></i>${st.label}</span>`}
      </div>`;
    })
    .join('')}</div>`;
}

// After the run: the team's reports, one card each, opening into the subagent's own presentation.
const subOpen = new Set(); // delegation ids the user unfolded
function renderSubs(s, t) {
  const list = delegationsOf(s, t);
  if (!list.length) return null;
  const names = [...new Set(list.map(({ d }) => `@${d.name}`))];
  const node = el(`
    <section class="subs">
      <div class="subs-head">
        ${teamStack(s.agent, list.map(({ d, ct }) => ({ name: d.name, agent: d.agent, busy: ct?.status === 'running' })))}
        <b>${list.length} delegated task${list.length > 1 ? 's' : ''}</b>
        <span class="subs-to">${esc(names.join(', '))}</span>
      </div>
      <div class="subs-list"></div>
    </section>`);
  const box = $('.subs-list', node);
  for (const { d, child, ct } of list) {
    const st = subStatus(ct);
    const hero = ct?.presentation?.blocks?.find((b) => b.type === 'hero');
    const files = ct?.changes?.length || 0;
    const card = el(`
      <article class="sub st-${st.cls} ${subOpen.has(d.id) ? 'open' : ''}">
        <button class="sub-head" aria-expanded="${subOpen.has(d.id)}">
          <span class="sub-logo">${harnessLogo(d.agent)}</span>
          <span class="sub-main">
            <span class="sub-top"><b>@${esc(d.name)}</b><span class="sub-model">${esc(memberLabel(d))}</span></span>
            <span class="sub-title">${esc(hero?.title || (ct?.status === 'running' ? ct.activity?.findLast((a) => a.kind !== 'text')?.label || 'Working' : d.prompt))}</span>
          </span>
          <span class="sub-side">
            ${files ? `<span class="sub-files">${files} file${files > 1 ? 's' : ''}</span>` : ''}
            ${ct?.endedAt ? `<span class="sub-dur">${fmtDuration(ct.endedAt - ct.startedAt)}</span>` : ''}
            <span class="pill st-${st.cls}"><i></i>${st.label}</span>
            ${icon('chevron', 'chev')}
          </span>
        </button>
        <div class="sub-body" ${subOpen.has(d.id) ? '' : 'hidden'}></div>
      </article>`);
    const body = $('.sub-body', card);
    const fill = () => {
      body.innerHTML = `<div class="sub-task"><span>Task from ${esc(agentName(s.agent))}</span><p>${esc(d.prompt)}</p></div>`;
      if (ct?.presentation && child) {
        // Its "next" and question blocks draft into the lead's composer: the lead stays in charge.
        const ctx = { ...ctxFor(child, ct, false), reply: (text) => draftInto(s.id, `Ask @${d.name} to: ${text}`), draft: (text) => draftInto(s.id, `Ask @${d.name} to: ${text}`) };
        body.append(renderPresentation(ct.presentation, ctx));
      } else if (ct?.status === 'running') body.append(el(`<p class="muted sub-wait">Still working…</p>`));
    };
    if (subOpen.has(d.id)) fill();
    $('.sub-head', card).onclick = () => {
      const opening = body.hidden;
      opening ? subOpen.add(d.id) : subOpen.delete(d.id);
      card.classList.toggle('open', opening);
      $('.sub-head', card).setAttribute('aria-expanded', String(opening));
      if (opening) fill();
      body.hidden = !opening;
    };
    box.append(card);
  }
  return node;
}

function draftInto(id, text) {
  const ta = $('.reply', S.nodes.get(id)?.card);
  if (!ta) return;
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
}

// A subagent's summary: its lead's card shows it, so update the live line or re-fetch the lead.
const childState = new Map();
function onChildSummary(c) {
  const row = $(`.tl-row[data-sub="${CSS.escape(c.id)}"] .tl-live`);
  if (row && c.state === 'running' && c.live) row.textContent = c.live;
  if (childState.get(c.id) !== c.state) {
    childState.set(c.id, c.state);
    scheduleRefetch(c.parentId);
  }
}

function modeMenu(anchor, current, pick) {
  const open = $('.menu.mode');
  if (open) return open.close();
  const menu = el(`
    <div class="menu mode" role="menu">
      ${MODES.map((m) => `<button role="menuitemradio" aria-checked="${m.id === current}" data-mode="${m.id}" class="m-${m.id}${m.id === current ? ' on' : ''}">
        ${icon(m.icon)}<span class="mm-text"><b>${m.label}</b><small>${esc(m.hint)}</small></span>${icon('check', 'mm-check')}
      </button>`).join('')}
    </div>`);
  const close = () => (menu.remove(), anchor.classList.remove('open'), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && !anchor.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    close();
    pick(b.dataset.mode);
    $('#prompt')?.focus();
  };
  menu.addEventListener('keydown', (ev) => {
    const items = $$('button', menu);
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') (ev.stopPropagation(), close(), anchor.focus());
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  document.body.append(menu);
  anchor.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : r.top - 6 - h}px`;
  $('button.on', menu)?.focus();
}

function renderLaunchChips() {
  const box = $('#launcher .l-projects');
  if (!box) return;
  syncWhere();
  const multi = launchWhere.length > 1;
  // One group per place: its name (unless it's only this computer), its projects, a way to add one.
  const group = (k) => {
    const m = k && machineById(k);
    const list = projectsAt(k);
    const off = m && m.state !== 'online';
    const label = k || multi ? `<span class="lp-gl ${off ? 'off' : ''}" title="${esc(k ? `${m?.target} · ${MACHINE_STATE[m?.state] || ''}` : 'This computer')}">${icon(k ? 'server' : 'laptop')}${esc(placeName(k))}${off ? `<button class="link xs" data-connect="${k}">${m.state === 'connecting' || m.state === 'reconnecting' ? 'connecting…' : 'Connect'}</button>` : ''}</span>` : '';
    const chips = list.map((p) => `<button class="lp-chip c-${p.color} ${p.id === launchPicks[k] ? 'on' : ''}" data-id="${p.id}" data-k="${k}" title="${esc(projectTitle(p))}"><i class="p-dot"></i>${esc(p.name)}</button>`).join('');
    const add = list.length
      ? `<button class="lp-chip add" data-add="${k}" title="Another folder${k ? ` on ${esc(placeName(k))}` : ''}">${icon('folder')}${multi ? '' : 'Other folder…'}</button>`
      : `<button class="lp-chip add" data-add="${k}">${icon('folder')}${k ? `Pick a project on ${esc(placeName(k))}…` : 'Choose a project folder…'}</button>`;
    return `<span class="lp-group">${label}${chips}${add}</span>`;
  };
  box.innerHTML = `<span class="l-in">in</span>${launchWhere.map(group).join('')}`;
  box.onclick = (e) => {
    const chip = e.target.closest('.lp-chip[data-id]');
    if (chip) {
      launchPicks[chip.dataset.k] = chip.dataset.id;
      if (chip.dataset.k === launchWhere[0]) launchProject = chip.dataset.id;
      saveWhere();
      $$(`.lp-chip[data-k="${chip.dataset.k}"]`, box).forEach((x) => x.classList.toggle('on', x === chip));
      renderLaunchRecipes();
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) openProjects({ focusAdd: true, machine: add.dataset.add || null });
    const conn = e.target.closest('[data-connect]');
    if (conn) connectMachine(conn.dataset.connect);
  };
  renderLaunchRecipes();
  paintWhereBtn();
}

// "Run on": this computer and/or machines. The button says where; its menu picks one or several.
function paintWhereBtn() {
  const b = $('#whereBtn');
  if (!b) return;
  const n = launchWhere.length;
  const remote = n > 1 || !!launchWhere[0];
  b.classList.toggle('on', remote);
  b.classList.toggle('bare', !S.machines.length && !remote);
  b.innerHTML = `${icon(remote ? 'server' : 'laptop')}<span>${esc(n > 1 ? `${n} places` : placeName(launchWhere[0]))}</span>${icon('chevron', 'chev')}`;
  b.title = n > 1 ? `Runs in parallel on ${launchWhere.map(placeName).join(', ')}` : S.machines.length ? `Runs on ${placeName(launchWhere[0])}. Pick several to run in parallel.` : 'Runs on this computer. Add a machine to run on other computers too.';
}

function whereMenu(anchor) {
  if ($('.menu.where-menu')) return $('.menu.where-menu').close();
  const box = el(`<div class="menu where-menu" role="menu"></div>`);
  const paint = () => {
    const row = (k, m) => {
      const on = launchWhere.includes(k);
      const st = m ? m.state : 'online';
      const ready = m ? (m.remote?.agents || []).filter((a) => a.available) : [];
      return `<button class="wm-row ${on ? 'on' : ''}" data-k="${k}" role="menuitemcheckbox" aria-checked="${on}">
        <span class="wm-check">${icon('check')}</span>
        <span class="wm-icon">${icon(k ? 'server' : 'laptop')}${m ? `<i class="dot ${st === 'online' ? 'ok' : st === 'error' ? 'bad' : ''}"></i>` : ''}</span>
        <span class="wm-name"><b>${esc(placeName(k))}</b><small>${m ? esc(st === 'online' ? m.target : `${m.target} · ${MACHINE_STATE[st]}`) : `${projectsAt('').length} project${projectsAt('').length === 1 ? '' : 's'}`}</small></span>
        ${m && st === 'online' && ready.length ? `<span class="wm-agents">${ready.map((a) => `<span class="model-logo">${harnessLogo(a.id)}</span>`).join('')}</span>` : ''}
        <span class="wm-only" data-only="${k}" title="Only here">only</span>
      </button>`;
    };
    box.innerHTML = `<div class="wm-h">Run on <small>pick several to run in parallel</small></div>
      ${row('', null)}${S.machines.map((m) => row(m.id, m)).join('')}
      <div class="wm-sep"></div>
      <button data-a="add">${icon('plus')}${S.machines.length ? 'Add a machine…' : 'Add a machine to run on another computer…'}</button>
      ${S.machines.length ? `<button data-a="manage">${icon('settings')}Manage machines</button>` : ''}`;
  };
  const set = (list) => {
    launchWhere = list.length ? list : [''];
    // A machine picked while disconnected starts connecting; you asked to run there.
    for (const k of launchWhere) if (k && machineById(k)?.state === 'off') connectMachine(k);
    renderLaunchChips();
    paint();
    saveWhere();
  };
  box.onclick = (e) => {
    const only = e.target.closest('[data-only]');
    if (only) return set([only.dataset.only]);
    const r = e.target.closest('.wm-row');
    if (r) {
      const k = r.dataset.k;
      return set(launchWhere.includes(k) ? launchWhere.filter((x) => x !== k) : [...launchWhere, k]);
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    shut();
    openMachines({ focusAdd: a === 'add' });
  };
  const shut = () => {
    box.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', esc_, true);
  };
  const outside = (ev) => {
    if (!box.contains(ev.target) && !anchor.contains(ev.target)) shut();
  };
  const esc_ = (ev) => {
    if (ev.key === 'Escape') (ev.stopPropagation(), shut());
  };
  box.close = shut;
  box.refresh = paint;
  paint();
  document.body.append(box);
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const h = box.offsetHeight;
  box.style.left = `${Math.min(r.left, innerWidth - box.offsetWidth - 8)}px`;
  box.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  setTimeout(() => document.addEventListener('mousedown', outside));
  document.addEventListener('keydown', esc_, true);
}

// Recipes for the picked project (and the ones tied to none), one click from the launcher.
// With text in the box, "Save as recipe" turns it into one.
function renderLaunchRecipes() {
  const row = $('#launcher .l-recipes');
  if (!row) return;
  const path = projectById(launchProject)?.path;
  const all = S.config.recipes || [];
  const list = all.filter((r) => !r.cwd || r.cwd === path).sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
  const hidden = all.length - list.length;
  row.innerHTML = `
    <span class="l-in">${icon('spark')}Recipes</span>
    ${list.map((r) => `<button class="lp-chip rc" data-recipe="${esc(r.id)}" title="${esc(r.prompt.replace(/\s+/g, ' ').slice(0, 200))}">${esc(r.name)}${recipeParams(r.prompt).length ? '<i class="rc-f">…</i>' : ''}</button>`).join('')}
    ${list.length ? '' : `<span class="muted xs lr-empty">${hidden ? `None for this project · ${hidden} elsewhere` : 'Prompts you send again and again, one click away'}</span>`}
    <button class="lp-chip add" id="lrSave" hidden>${icon('plus')}Save as recipe</button>
    <button class="lp-chip add" id="lrNew">${icon('plus')}New</button>`;
  row.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.recipe) {
      const r = all.find((x) => x.id === b.dataset.recipe);
      return r && runRecipe({ ...r, params: recipeParams(r.prompt) });
    }
    const draft = { name: '', prompt: '', cwd: path || '', mode: $('#launcher').mode?.() };
    if (b.id === 'lrSave') openAutomations({ tab: 'recipes', edit: { type: 'recipe', draft: { ...draft, prompt: $('#prompt').value.trim() } } });
    if (b.id === 'lrNew') openAutomations({ tab: 'recipes', edit: { type: 'recipe', draft } });
  };
  paintSaveRecipe();
}
function paintSaveRecipe() {
  const has = !!$('#prompt')?.value.trim();
  const save = $('#lrSave');
  if (!save) return;
  save.hidden = !has;
  $('#lrNew').hidden = has;
}

// Top bar: always one click to recipes and triggers. The badge counts triggers that are on;
// the tooltip says what fires next.
async function paintAutoBtn() {
  const btn = $('#autoBtn');
  const on = (S.config.triggers || []).filter((t) => t.enabled);
  const n = $('.ab-n', btn);
  n.hidden = !on.length;
  n.textContent = on.length;
  btn.classList.toggle('live', !!on.length);
  const r = S.config.recipes?.length || 0;
  let title = `Automations: ${r} recipe${r === 1 ? '' : 's'} · ${on.length} trigger${on.length === 1 ? '' : 's'} on`;
  if (on.length) {
    const next = (await api('/triggers').catch(() => [])).filter((t) => t.enabled && t.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (next) title += `\nNext: ${next.name} · ${whenLabel(next.nextAt)}`;
  }
  btn.title = title;
}

// A little wisp flies from the launch button to the new item in the feed.
function launchedFx(from, to) {
  to?.classList.add('arrived');
  setTimeout(() => to?.classList.remove('arrived'), 1600);
  if (!to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const w = el(`<div class="flying-wisp"></div>`);
  w.style.left = `${a.left + a.width / 2}px`;
  w.style.top = `${a.top + a.height / 2}px`;
  document.body.append(w);
  const dx = b.left + 24 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  w.animate(
    [
      { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.4}px), calc(-50% + ${dy * 0.4 - 60}px)) scale(1.3)`, opacity: 1, offset: 0.35 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.4)`, opacity: 0 },
    ],
    { duration: 800, easing: 'cubic-bezier(.5,0,.3,1)' },
  ).onfinish = () => w.remove();
}

// A new card lands in Working, below everything in "Needs you", so it's often off-screen. Scroll
// it into view (just enough) and flash it; the flying wisp only plays when the card is already
// on screen, since the launcher it starts from may scroll away or fold into the dock.
function showLaunched(btn, card) {
  if (!card) return;
  const r = card.getBoundingClientRect();
  if (r.top >= topInset() && r.bottom <= innerHeight) return launchedFx(btn, card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.classList.add('arrived');
  setTimeout(() => card.classList.remove('arrived'), 1600);
}

// --- project filter (top bar) ---------------------------------------------------

function renderProjects() {
  const all = [...S.sessions.values()];
  const stats = (pid) => {
    const l = pid === 'all' ? all : all.filter((s) => s.projectId === pid);
    return { run: l.filter((s) => s.state === 'running').length, need: l.filter((s) => s.state === 'waiting' || (s.state === 'review' && s.unread)).length };
  };
  const chip = (id, name, color) => {
    const st = stats(id);
    return `<button class="p-chip ${S.filter === id ? 'on' : ''} c-${color}" data-id="${id}" title="${esc(id === 'all' ? 'All projects' : projectTitle(projectById(id)))}">
      ${id === 'all' ? '' : '<i class="p-dot"></i>'}<span>${esc(name)}</span>${projectById(id)?.machine ? icon('server', 'p-where') : ''}${st.run ? `<span class="p-run" title="${st.run} working"></span>` : ''}${st.need ? `<span class="p-need">${st.need}</span>` : ''}
    </button>`;
  };
  $('#projects').innerHTML = `${chip('all', 'All', 'slate')}${S.config.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt || b.addedAt) - (a.lastUsedAt || a.addedAt))
    .map((p) => chip(p.id, p.name, p.color))
    .join('')}<button class="p-chip add" id="manageProjects" title="Manage projects">${icon('plus')}</button>`;
  $$('.p-chip[data-id]').forEach((b) =>
    b.addEventListener('click', () => {
      S.filter = S.filter === b.dataset.id ? 'all' : b.dataset.id;
      save('wisp.filter', S.filter);
      renderFeed();
      feedToTop();
      renderLaunchChips();
    }),
  );
  $$('.p-chip[data-id]:not([data-id="all"])').forEach((b) =>
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      projectMenu(b.dataset.id, e);
    }),
  );
  $('#manageProjects').onclick = () => openProjects();
}

function projectMenu(id, e) {
  const p = projectById(id);
  if (!p) return;
  $('.menu.project')?.close();
  const menu = el(`
    <div class="menu project" style="top:${e.clientY}px;left:${e.clientX}px">
      <button data-a="manage">${icon('pen')}Manage projects…</button>
      <button data-a="delete" class="danger">${icon('trash')}Remove project</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'manage') openProjects();
    if (a === 'delete' && confirm(`Remove “${p.name}” from wisp? Sessions and files are kept.`)) {
      try {
        await api(`/projects/${id}`, { method: 'DELETE' });
      } catch (err) {
        return toast(esc(err.message), { tone: 'bad' });
      }
      if (S.filter === id) {
        S.filter = 'all';
        save('wisp.filter', S.filter);
      }
      await loadConfig();
      renderFeed();
    }
  };
  document.body.append(menu);
  // Keep the menu on-screen when right-clicking near the window edge.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

// --- expanded item body ------------------------------------------------------------

function ctxFor(s, turn, isLatest) {
  return {
    session: s,
    turn,
    isLatest,
    reply: (text) => sendReply(s.id, text),
    draft: (text) => {
      const ta = $('.reply', S.nodes.get(s.id)?.card);
      if (!ta) return;
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
    },
    openFile: (p, line) => openInEditor(s, p, line),
    fileUrl: (p) => `/api/sessions/${s.id}/file?path=${encodeURIComponent(p)}`,
    zoom: (src) => overlay(el(`<img class="lightbox" src="${esc(src)}">`)),
    revertFile: (file, restore) => revertFile(s.id, turn.id, file, restore),
    exec: (command, key) => execAction(s.id, turn.id, command, key),
  };
}

// Older turns render as one-line folded rows; past this many they hide behind "Show earlier".
const VISIBLE_TURNS = 8;

function renderBody(id, { fresh }) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  if (!s || !n) return;
  const summary = S.sessions.get(id) || {};

  if (fresh || !n.body?.querySelector('.turns')) {
    n.turnNodes.clear();
    const body = el(`
      <div class="it-body">
        <div class="it-bar">
          <div class="it-meta"></div>
          <div class="it-actions">
            <button class="ghost xs" data-a="replay" title="Replay presentation (R)">${icon('replay')}</button>
            <button class="ghost xs" data-a="takeover" title="Take over in your terminal (T)">${icon('terminal')}</button>
            <button class="ghost xs" data-a="ship" title="Commit, push and open a pull request (S)" hidden>${icon('send')}<span>Ship it</span></button>
            <button class="ghost xs" data-a="more" title="More">${icon('dots')}</button>
          </div>
        </div>
        <div class="pr-strip" hidden></div>
        <button class="link xs earlier" hidden></button>
        <div class="turns"></div>
        <div class="it-dock"></div>
      </div>`);
    n.body ? n.body.replaceWith(body) : n.card.append(body);
    n.body = body;
    $('.it-bar', body).addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'replay') replay(id);
      if (a === 'takeover') takeOver(id);
      if (a === 'ship') shipDialog(id);
      if (a === 'more') moreMenu(id, e.target.closest('button'));
    });
    $('.earlier', body).onclick = () => ((n.showAll = true), renderBody(id, { fresh: false }));
    renderDock(id);
  }

  const body = n.body;
  const proj = projectById(summary.projectId);
  // The head already shows the harness, model and project, the task head has Compare, and Done
  // sits by the composer. This bar only says how the run was set up: a mode worth noticing
  // (Plan or Full auto, as on the launcher), the branch, and what launched it.
  const mode = MODES.find((m) => m.id === s.mode);
  const where = (proj?.path || s.cwd).replace(S.config.home || '', '~');
  $('.it-meta', body).title = [agentName(s.agent), s.model, s.effort && `${effortLabel(s.effort)} thinking`, mode?.label, where].filter(Boolean).join(' · ');
  $('.it-meta', body).innerHTML = `
    ${mode && mode.id !== 'edits' ? `<span class="m mode m-${mode.id}" title="${esc(mode.hint)}">${icon(mode.icon)}${esc(mode.label)}</span>` : ''}
    ${s.worktree ? `<span class="m branch" title="Worktree: ${esc(s.worktree.path)}\nFrom ${esc(s.worktree.baseRef)}">${icon('branch')}${esc(s.worktree.branch)}</span>` : ''}
    ${s.subagents?.length ? `<span class="m team-m" title="${esc(s.subagents.map((m) => `@${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n'))}">${icon('agent')}${teamSize(s.subagents)} subagent${teamSize(s.subagents) > 1 ? 's' : ''}</span>` : ''}
    ${s.origin ? `<span class="m" title="Launched by a ${esc(s.origin.kind)}">${icon(s.origin.kind === 'trigger' ? 'replay' : 'spark')}${esc(s.origin.name)}</span>` : ''}`;
  const live = s.state === 'running' || s.state === 'waiting';
  // Ship sits in the top bar and again next to the composer, so it's there after reading the result.
  $$('[data-a="ship"]', body).forEach((b) => (b.hidden = !s.worktree || live || s.agent === 'wisp' || s.pr?.state === 'MERGED'));
  renderPrStrip(id);
  $$('[data-a="done"]', body).forEach((b) => {
    b.classList.toggle('on', s.state === 'done');
    b.hidden = s.state === 'running' || s.state === 'waiting';
    $('span', b).textContent = s.state === 'done' ? 'Reopen' : 'Mark done';
  });
  $('[data-a="takeover"]', body).hidden = !s.agentSessionId;

  // Turns: keep nodes whose content hasn't changed so animations don't replay.
  const turnsEl = $('.turns', body);
  const turns = n.showAll ? s.turns : s.turns.slice(-VISIBLE_TURNS);
  const hiddenCount = s.turns.length - turns.length;
  const earlier = $('.earlier', body);
  earlier.hidden = !hiddenCount;
  earlier.textContent = `Show ${hiddenCount} earlier turn${hiddenCount === 1 ? '' : 's'}`;
  // A new turn re-folds everything older, so the latest exchange is what's open by default.
  const latestId = s.turns.at(-1)?.id;
  if (n.latestTurn !== latestId) (n.unfolded.clear(), (n.latestTurn = latestId));
  const keep = new Set();
  let firstNew = null;
  turns.forEach((t) => {
    const isLatest = t.id === latestId;
    const folded = !isLatest && !n.unfolded.has(t.id);
    const revKey = `${t.rolledBackAt || 0}:${(t.changes || []).map((c) => (c.reverted ? 1 : 0)).join('')}`;
    const key = `${t.status}|${isLatest}|${folded}|${revKey}|${t.status === 'running' ? (s.ask?.id || '') + s.queue?.length : ''}|${subKey(s, t)}`;
    const prev = n.turnNodes.get(t.id);
    let node = prev?.node;
    if (!prev || prev.key !== key) {
      const toggle = () => (n.unfolded.has(t.id) ? n.unfolded.delete(t.id) : n.unfolded.add(t.id), renderBody(id, { fresh: false }));
      node = folded ? renderFoldedTurn(t, toggle) : renderTurn(s, t, isLatest, isLatest ? null : toggle);
      if (prev) prev.node.replaceWith(node);
      if (!prev && !fresh && !folded) firstNew ??= node;
      if (prev && prev.status === 'running' && t.status !== 'running') firstNew ??= node;
      n.turnNodes.set(t.id, { key, node, status: t.status });
    }
    keep.add(t.id);
    turnsEl.append(node); // re-append keeps order
  });
  for (const [tid, v] of n.turnNodes) if (!keep.has(tid)) (v.node.remove(), n.turnNodes.delete(tid));

  updateDock(id);
  if (firstNew && watching(id)) requestAnimationFrame(() => firstNew.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// Whether the user is reading a card, not just catching its edge at the top or bottom of the
// screen: it crosses the middle of the viewport, or it's focused and a fair share of it shows.
// Anything that moves the page on a card's behalf asks this first.
function watching(id) {
  const card = S.nodes.get(id)?.card;
  if (!card?.isConnected) return false;
  const r = card.getBoundingClientRect();
  const mid = innerHeight / 2;
  if (r.top <= mid && r.bottom >= mid) return true;
  const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return S.focus === id && shown >= Math.min(r.height, innerHeight) / 3;
}

const sectionOf = (s) => {
  const t = taskOf(s);
  return t.archived ? 'archived' : t.state === 'running' ? 'working' : t.state === 'done' ? 'done' : 'needs';
};

// Run a DOM change without moving `card` on screen. The browser's own scroll anchoring misses
// cards that are moved between lists, so feed re-renders do this explicitly.
function keepInPlace(card, change) {
  const top = card?.isConnected ? card.getBoundingClientRect().top : null;
  change();
  if (top !== null && card.isConnected) scrollByPx(card.getBoundingClientRect().top - top);
}

// Any write to scrollTop cancels a smooth scroll in flight (j/k, Open, a launch), so only
// write when there's an actual shift to undo.
function scrollByPx(dy) {
  if (Math.abs(dy) >= 1) stage.scrollTop += dy;
}

// The card to hold still while the feed changes around it: the first one showing under the top
// bar and docked launcher, skipping `id` (the card that's changing). None at the very top of the page, where new
// cards should push the list down, or when `id` itself is the top card on screen: then the next
// one should slide up into its place.
function feedAnchor(id) {
  if (stage.scrollTop < 1) return null;
  const moving = id && S.nodes.get(id)?.card;
  const inset = topInset();
  for (const card of $$('#feed .item')) {
    const r = card.getBoundingClientRect();
    if (r.bottom > inset) return card === moving ? null : card;
  }
  return null;
}

function renderFoldedTurn(t, unfold) {
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  const node = el(`
    <article class="turn folded" data-turn="${t.id}">
      <button class="t-fold" title="Show this exchange">
        ${icon('chevron', 'chev')}
        <span class="t-prompt">${esc(t.prompt.replace(/\s+/g, ' '))}</span>
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
        ${hero?.title ? `<span class="t-result">${esc(hero.title)}</span>` : ''}
        <time>${new Date(t.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      </button>
    </article>`);
  $('.t-fold', node).onclick = unfold;
  return node;
}

// `fold` is set for older turns the user unfolded, so they can tuck them away again.
function renderTurn(s, t, isLatest, fold) {
  const node = el(`<article class="turn ${t.rolledBackAt ? 'is-rolled-back' : ''}" data-turn="${t.id}"></article>`);
  const long = t.prompt.length > 360 || t.prompt.split('\n').length > 5;
  const cp = t.checkpoint;
  const cpLabel = cp?.head ? `${cp.branch ? `${cp.branch}@` : ''}${cp.head.slice(0, 7)}${cp.dirty ? '*' : ''}` : '';
  const ask = el(`
    <div class="ask">
      <div class="ask-text ${long ? 'clamped' : ''}">${esc(t.prompt)}</div>
      ${long ? '<button class="link xs more-btn">Show all</button>' : ''}
      ${t.attachments?.length ? `<div class="ask-atts">${t.attachments.map((a) => (a.mime?.startsWith('image/') ? `<img src="/api/uploads/${a.id}" alt="${esc(a.name)}" title="${esc(a.name)}">` : `<a class="att-pill" href="/api/uploads/${a.id}" target="_blank">${icon('file')}${esc(a.name)}</a>`)).join('')}</div>` : ''}
      <div class="ask-foot">
        ${modelBadge(t.agent || s.agent, t.model ?? s.model, t.effort ?? s.effort)}
        <time>${new Date(t.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        ${cpLabel ? `<span class="cp-sha" title="Git checkpoint before this turn (${esc(cp.head)}${cp.dirty ? ' + uncommitted changes' : ''})">${icon('branch')}${esc(cpLabel)}</span>` : ''}
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
      </div>
      ${fold ? `<button class="ghost xs t-unfold" title="Collapse this exchange">${icon('chevron', 'chev')}</button>` : ''}
    </div>`);
  if (fold) ask.querySelector('.t-unfold').onclick = fold;
  ask.querySelector('.more-btn')?.addEventListener('click', (e) => {
    ask.querySelector('.ask-text').classList.toggle('clamped');
    e.target.textContent = ask.querySelector('.ask-text').classList.contains('clamped') ? 'Show all' : 'Show less';
  });
  ask.querySelectorAll('.ask-atts img').forEach((img) => img.addEventListener('click', () => overlay(el(`<img class="lightbox" src="${img.src}">`))));
  node.append(ask);

  if (t.status === 'running') {
    node.append(renderWorking(s, t));
  } else {
    node.append(renderPresentation(t.presentation, ctxFor(s, t, isLatest)));
    const subs = renderSubs(s, t);
    if (subs) node.append(subs);
    node.append(renderTrail(s, t));
  }
  return node;
}

function renderWorking(s, t) {
  const waiting = !!s.ask;
  const node = el(`
    <div class="w-panel ${waiting ? 'waiting' : ''}">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status">
          <b>${waiting ? `${esc(agentName(s.agent))} is waiting for you` : `${esc(agentName(s.agent))} is working`}</b>
          <span class="elapsed" data-start="${t.startedAt}">${fmtDuration(Date.now() - t.startedAt)}</span>
          <span class="w-count">${t.activity.filter((a) => a.kind !== 'text').length} actions</span>
        </div>
        <div class="ask-slot"></div>
        ${teamLiveHtml(s, t)}
        <ul class="ticker"></ul>
        <div class="w-actions">
          <button class="link xs peek">Show all activity</button>
          ${s.queue?.length ? `<span class="w-queued">${s.queue.length} follow-up${s.queue.length > 1 ? 's' : ''} queued</span>` : ''}
          <span class="grow"></span>
          <button class="ghost sm danger stop">${icon('stop')}Stop</button>
        </div>
        <ul class="log" hidden></ul>
      </div>
    </div>`);
  if (waiting) $('.ask-slot', node).append(renderAskCard(s));
  const ticker = $('.ticker', node);
  t.activity
    .filter((a) => a.kind !== 'text')
    .slice(-5)
    .forEach((a) => ticker.prepend(actItem(a)));
  $('.stop', node).onclick = async () => {
    await api(`/sessions/${s.id}/stop`, { method: 'POST', body: {} }).catch((e) => toast(esc(e.message), { tone: 'bad' }));
  };
  $('.peek', node).onclick = (e) => {
    const log = $('.log', node);
    log.hidden = !log.hidden;
    e.target.textContent = log.hidden ? 'Show all activity' : 'Hide activity';
    if (!log.hidden) log.innerHTML = t.activity.map((a) => actItem(a).outerHTML).join('');
  };
  return node;
}

function actItem(a) {
  return el(`<li class="act k-${a.kind}">${icon(KIND_ICON[a.kind] || 'tool')}<span>${esc(a.label || '')}</span></li>`);
}

function renderAskCard(s) {
  const a = s.ask;
  const node = el(`
    <div class="ask-card">
      <div class="q-head">${icon('ask')}<span>Needs your call</span></div>
      <p class="q-text">${esc(a.question)}</p>
      ${a.context ? `<div class="prose q-context">${md(a.context)}</div>` : ''}
      ${a.options?.length ? `<div class="q-opts">${a.options.map((o, i) => `<button class="opt" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}</button>`).join('')}</div>` : ''}
      <form class="q-own"><input class="input" placeholder="${a.options?.length ? 'Or answer in your own words…' : 'Your answer…'}"><button class="primary sm">Answer</button></form>
    </div>`);
  const answer = async (text) => {
    if (!text.trim()) return;
    node.classList.add('sent');
    await api(`/sessions/${s.id}/answer`, { method: 'POST', body: { text } }).catch((e) => toast(esc(e.message), { tone: 'bad' }));
  };
  node.addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (b) answer(a.options[b.dataset.i]);
  });
  $('form', node).onsubmit = (e) => (e.preventDefault(), answer($('input', node).value));
  return node;
}

function renderTrail(s, t) {
  const acts = t.activity || [];
  const count = (k) => acts.filter((a) => a.kind === k).length;
  const parts = [
    ['read', 'read', count('read')],
    ['pen', 'edited', count('edit')],
    ['terminal', 'ran', count('run')],
    ['search', 'searched', count('search')],
    ['web', 'web', count('web')],
  ].filter((p) => p[2]);
  const totals = (t.changes || []).reduce((acc, c) => {
    const n = countChanges(c.edits);
    return { add: acc.add + n.add, del: acc.del + n.del };
  }, { add: 0, del: 0 });
  const st = t.stats || {};
  const canRollback = s.agent !== 'wisp' && s.state !== 'running' && (t.changes?.length || t.checkpoint?.commit);
  const rolledBack = !!t.rolledBackAt;
  const node = el(`
    <div class="trail">
      <div class="trail-bar">
        ${parts.map(([ic, l, n]) => `<span class="tb" title="${n} ${l}">${icon(ic)}${n}</span>`).join('')}
        ${t.endedAt ? `<span class="tb">${fmtDuration(t.endedAt - t.startedAt)}</span>` : ''}
        ${st.costUsd ? `<span class="tb">$${st.costUsd.toFixed(2)}</span>` : ''}
        <span class="grow"></span>
        ${canRollback ? `<button class="link xs cp-rollback ${rolledBack ? 'rolled-back' : ''}" data-a="rollback" title="${rolledBack ? 'Re-apply changes from this turn' : `Restore working tree to before this turn${t.checkpoint?.head ? ` (${t.checkpoint.head.slice(0, 7)})` : ''}`}">${icon(rolledBack ? 'rerun' : 'replay')}${rolledBack ? 'Re-apply turn' : 'Restore to before this turn'}</button>` : ''}
        ${t.changes?.length ? `<button class="link xs" data-tab="changes">${t.changes.length} file${t.changes.length > 1 ? 's' : ''} <span class="plus">+${totals.add}</span> <span class="minus">−${totals.del}</span></button>` : ''}
        ${acts.length ? `<button class="link xs" data-tab="activity">Activity</button>` : ''}
        ${t.presentation?.notes ? `<button class="link xs" data-tab="notes">Agent notes</button>` : ''}
      </div>
      <div class="trail-body" hidden></div>
    </div>`);
  const body = $('.trail-body', node);
  let open = null;
  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-a="rollback"]')) {
      return rollbackTurn(s.id, t.id, rolledBack);
    }
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    $$('[data-tab]', node).forEach((x) => x.classList.toggle('on', x === b && open !== tab));
    if (open === tab) {
      open = null;
      body.hidden = true;
      return;
    }
    open = tab;
    body.hidden = false;
    body.innerHTML = '';
    if (tab === 'activity') body.append(el(`<ul class="log">${acts.map((a) => actItem(a).outerHTML).join('')}</ul>`));
    if (tab === 'notes') body.append(el(`<div class="prose">${md(t.presentation.notes)}</div>`));
    if (tab === 'changes') {
      body.append(renderPresentation({ blocks: t.changes.map((c) => ({ type: 'diff', file: c.file })) }, ctxFor(s, t, false)));
    }
  });
  return node;
}

// Live activity without re-rendering the whole turn.
function onActivity({ sessionId, turnId, item }) {
  const s = S.full.get(sessionId);
  if (!s) return;
  const turn = s.turns.find((t) => t.id === turnId);
  if (turn && !turn.activity.includes(item)) turn.activity.push(item);
  const node = S.nodes.get(sessionId)?.turnNodes.get(turnId)?.node;
  if (!node || item.kind === 'text') return;
  const ticker = $('.ticker', node);
  if (ticker) {
    const li = actItem(item);
    li.classList.add('new');
    ticker.prepend(li);
    while (ticker.children.length > 5) ticker.lastElementChild.remove();
  }
  const log = $('.log', node);
  if (log && !log.hidden) log.append(actItem(item));
  const c = $('.w-count', node);
  if (c && turn) c.textContent = `${turn.activity.filter((a) => a.kind !== 'text').length} actions`;
}

// --- per-item composer ---------------------------------------------------------

function renderDock(id) {
  const n = S.nodes.get(id);
  const dock = $('.it-dock', n.body);
  const comp = el(`
    <div class="composer">
      <ul class="c-queued"></ul>
      <textarea class="reply" rows="1" spellcheck="false"></textarea>
      <div class="c-bar">
        <button class="icon-btn c-attach" title="Attach files">${icon('clip')}</button>
        <span class="c-hint"></span>
        <button class="ghost sm c-ship" data-a="ship" title="Commit, push and open a pull request (S)" hidden>${icon('send')}<span>Ship it</span></button>
        <button class="ghost sm c-done" data-a="done" title="Mark done (E)">${icon('done')}<span>Mark done</span></button>
        <button class="ghost xs c-queue" hidden>${icon('queue')}<span>Queue</span></button>
        <button class="send" title="Send (Enter · Shift+Enter for newline)">${icon('enter')}</button>
      </div>
    </div>`);
  dock.append(comp);
  n.tray = attachTray();
  comp.prepend(n.tray.node);
  const ta = $('.reply', comp);
  autosize(ta, 260);
  acceptFiles(comp, ta, n.tray);
  $('.c-attach', comp).onclick = n.tray.pick;
  $('.c-done', comp).onclick = () => toggleDone(id);
  $('.c-ship', comp).onclick = () => shipDialog(id);
  $('.c-queue', comp).onclick = toggleQueue;
  ta.value = S.drafts.get(id) || '';
  ta.addEventListener('input', () => S.drafts.set(id, ta.value));
  ta.addEventListener('focus', () => setFocus(id, { scroll: false }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendReply(id, ta.value);
    }
  });
  $('.send', comp).onclick = () => sendReply(id, ta.value);
}

function updateDock(id) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  const ta = n && $('.reply', n.card);
  if (!s || !ta) return;
  const name = agentName(s.agent);
  const tour = s.agent === 'wisp';
  ta.disabled = tour;
  ta.placeholder = tour
    ? 'This is the tour — launch a real wisp from the box at the top'
    : s.ask
      ? `Answer ${name}…`
      : s.state === 'running'
        ? queueing()
          ? `Queue a follow-up — sent when ${name} finishes`
          : `Steer ${name} — interrupts and sends now`
        : s.state === 'done'
          ? 'Follow up to reopen…'
          : `Follow up with ${name}…`;
  $('.c-hint', n.card).innerHTML = s.queue?.length ? `${s.queue.length} queued` : '';
  renderQueued(s, $('.c-queued', n.card), name);
  const q = $('.c-queue', n.card);
  q.hidden = tour || s.state !== 'running';
  q.classList.toggle('on', queueing());
  q.title = queueing()
    ? `Queueing: follow-ups wait until ${name} finishes. Click to send now instead.`
    : `Sending now: follow-ups interrupt ${name}. Click to queue them instead.`;
}

// Follow-ups waiting their turn, shown above the composer so it's clear what goes out next.
function renderQueued(s, list, name) {
  const key = (s.queue || []).map((q) => q.id).join();
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.innerHTML = '';
  (s.queue || []).forEach((q, i) => {
    const li = el(`
      <li class="cq">
        <span class="cq-tag">${i === 0 ? `Next · after ${esc(name)} finishes` : `Queued #${i + 1}`}</span>
        <span class="cq-text">${esc(q.text)}</span>
        <button class="att-x" title="Cancel this follow-up">${icon('x')}</button>
      </li>`);
    const cancel = () => {
      // Items queued by a wisp older than queue ids get one when wisp restarts.
      if (!q.id) return toast('Restart wisp to cancel this follow-up.', { tone: 'bad' });
      const short = q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text;
      if (!confirm(`Cancel this queued follow-up?\n\n“${short}”`)) return;
      api(`/sessions/${s.id}/queue?item=${encodeURIComponent(q.id)}`, { method: 'DELETE' }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
    };
    $('.att-x', li).onclick = cancel;
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      queuedMenu(e, cancel);
    });
    list.append(li);
  });
}

// Right-click on a queued follow-up.
function queuedMenu(e, cancel) {
  $('.menu.queued')?.close();
  const menu = el(`
    <div class="menu queued" style="top:${e.clientY}px;left:${e.clientX}px">
      <button data-a="cancel" class="danger">${icon('x')}Cancel follow-up</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'cancel') cancel();
  };
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

// Follow-ups sent while an agent works interrupt it, unless the user flipped this on.
const queueing = () => S.config?.defaults?.followUp === 'queue';

async function toggleQueue() {
  const followUp = queueing() ? 'now' : 'queue';
  S.config.defaults.followUp = followUp;
  S.nodes.forEach((_, id) => updateDock(id));
  await api('/config', { method: 'PATCH', body: { defaults: { followUp } } }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
}

async function sendReply(id, text) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  text = (text || '').trim();
  if (!s || !text) return;
  if (n?.tray?.busy) toast('Waiting for uploads…');
  const attachments = n?.tray ? await n.tray.ids() : [];
  try {
    const r = s.ask && !attachments.length
      ? await api(`/sessions/${id}/answer`, { method: 'POST', body: { text } })
      : await api(`/sessions/${id}/reply`, { method: 'POST', body: { text, attachments, queue: queueing() } });
    const ta = n && $('.reply', n.card);
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    n?.tray?.clear();
    if (r.queued)
      toast(r.ahead ? `Queued behind ${r.ahead} earlier follow-up${r.ahead > 1 ? 's' : ''} — they go out first, in order.` : 'Queued — it goes out as soon as the agent finishes.');
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

// --- item actions ------------------------------------------------------------------

async function toggleDone(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.state === 'running' || s.state === 'waiting') return toast('Still working — stop it first or let it finish.');
  const next = s.state === 'done' ? 'review' : 'done';
  const leave = next === 'done' && handOff(id); // measured before the live update moves the card
  await api(`/sessions/${id}`, { method: 'PATCH', body: { state: next } });
  if (leave) {
    leave(() => S.sessions.set(id, { ...S.sessions.get(id), state: 'done' }));
    toast(`Marked done`, { action: { label: 'Undo', run: () => api(`/sessions/${id}`, { method: 'PATCH', body: { state: 'review' } }) } });
  }
}

// Every finished run of a compare task at once, with one toast to undo them all.
async function taskDone(ids) {
  if (!ids.length) return;
  const card = S.nodes.get(ids[0])?.card.closest('.task-item');
  const next = card?.nextElementSibling?.querySelector('.item')?.dataset.id || card?.nextElementSibling?.dataset.id;
  const set = (state) => Promise.all(ids.map((id) => api(`/sessions/${id}`, { method: 'PATCH', body: { state } })));
  await set('done').catch((err) => toast(esc(err.message), { tone: 'bad' }));
  for (const id of ids) S.sessions.set(id, { ...S.sessions.get(id), state: 'done' });
  renderFeed();
  if (next && S.nodes.has(next)) setFocus(next);
  toast(`Marked ${ids.length} runs done`, { action: { label: 'Undo', run: () => set('review') } });
}

async function revertFile(id, turnId, file, restore = false) {
  try {
    await api(`/sessions/${id}/revert`, { method: 'POST', body: { turnId, file, restore } });
    toast(restore ? `Re-applied ${esc(file)}` : `Reverted ${esc(file)}`, {
      action: { label: 'Undo', run: () => revertFile(id, turnId, file, !restore) },
    });
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

async function rollbackTurn(id, turnId, restore = false) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  const turn = s?.turns?.find((t) => t.id === turnId) || s?.turns?.at(-1);
  if (!turn) return;
  try {
    const r = await api(`/sessions/${id}/rollback`, { method: 'POST', body: { turnId: turn.id, restore } });
    toast(
      restore
        ? `Re-applied turn changes`
        : `Restored working tree to before this turn${r.head ? ` (${esc(r.head.slice(0, 7))})` : ''}`,
      { action: { label: 'Undo', run: () => rollbackTurn(id, turn.id, !restore) } },
    );
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

async function execAction(id, turnId, command, key) {
  try {
    const r = await api(`/sessions/${id}/exec`, { method: 'POST', body: { command, turnId } });
    if (key) S.actionRuns.set(key, r);
    return r;
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
    return null;
  }
}

async function takeOver(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  if (!s?.agentSessionId) return;
  if (s.state === 'running' && !confirm(`${agentName(s.agent)} is still running. Stop it and take over in your terminal?`)) return;
  try {
    const { command } = await api(`/sessions/${id}/takeover`, { method: 'POST', body: {} });
    toast(`${icon('terminal')} Opened in your terminal`, { action: { label: 'Copy command', run: () => copy(command) } });
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

function rename(id) {
  const n = S.nodes.get(id);
  const title = n && $('.it-title', n.head);
  if (!title) return;
  title.contentEditable = 'true';
  title.focus();
  document.getSelection().selectAllChildren(title);
  const done = (commit) => {
    title.contentEditable = 'false';
    const s = S.sessions.get(id);
    const t = title.textContent.trim();
    if (commit && t && t !== s.title) api(`/sessions/${id}`, { method: 'PATCH', body: { title: t } }).catch((e) => toast(esc(e.message), { tone: 'bad' }));
    else title.textContent = s.title;
  };
  title.onkeydown = (e) => {
    if (e.key === 'Enter') (e.preventDefault(), title.blur());
    if (e.key === 'Escape') ((title.textContent = S.sessions.get(id).title), title.blur());
  };
  title.onclick = (e) => e.stopPropagation();
  title.onblur = () => done(true);
}

// One popover for all three choices: harnesses on the left, the focused harness's models on the
// right, and its thinking levels underneath. Clicking (or arrowing to) a harness previews its
// models; picking a model commits harness + model, picking a thinking level commits it in place.
function runnerPicker(anchor, { agent, model, effort, savedModel, savedEffort }, pick) {
  const open = $('.picker');
  if (open) return open.close();
  let focusAgent = S.agents.find((a) => a.id === agent && a.available) ? agent : S.agents.find((a) => a.available)?.id;

  const r = anchor.getBoundingClientRect();
  const width = Math.min(580, innerWidth - 24);
  // Stay inside the launcher card when there's room, else inside the window.
  const box = anchor.closest('.launcher')?.getBoundingClientRect();
  const right = Math.min(innerWidth - 12, box && box.width >= width ? box.right : innerWidth - 12);
  const left = Math.max(12, Math.min(r.left, right - width));
  const below = r.bottom + 440 < innerHeight;
  const node = el(`
    <div class="picker" role="dialog" aria-label="Harness, model and thinking level" style="left:${left}px;width:${width}px;${below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <div class="pk-side" role="listbox" aria-label="Harness">
        <div class="pk-head">Harness</div>
        ${S.agents
          .map(
            (a) => `<button class="pk-h${a.available ? '' : ' off'}" role="option" data-id="${esc(a.id)}" ${a.available ? '' : 'disabled'}>
              <span class="pk-logo">${harnessLogo(a.id)}</span>
              <span class="pk-text"><b>${esc(a.name)}</b><small>${esc(a.available ? `${(a.models || []).length > 1 ? `${a.models.length - 1} models` : 'Default model'}` : 'Not installed')}</small></span>
              ${a.id === agent ? '<span class="pk-dot" title="In use"></span>' : ''}
            </button>`,
          )
          .join('')}
      </div>
      <div class="pk-main">
        <label class="field pk-search">${icon('search')}<input spellcheck="false" autocomplete="off"></label>
        <div class="pk-list" role="listbox" aria-label="Model"></div>
        <div class="pk-effort" role="radiogroup" aria-label="Thinking level"></div>
      </div>
    </div>`);
  const input = $('.pk-search input', node);
  const list = $('.pk-list', node);
  const sideRows = $$('.pk-h', node);
  const seg = $('.pk-effort', node);
  const modelOf = (id) => (id === agent ? model : savedModel(id));
  const effortOf = (id) => (id === agent ? effort : savedEffort(id, modelOf(id)));

  const paintEffort = () => {
    const levels = effortsFor(focusAgent, modelOf(focusAgent));
    const current = effortOf(focusAgent);
    seg.hidden = !levels.length;
    seg.innerHTML = `<span class="pk-ehead">Thinking</span><span class="pk-seg">${['', ...levels]
      .map((e) => `<button role="radio" aria-checked="${e === current}" class="${e === current ? 'on' : ''}" data-e="${esc(e)}" title="${e ? `${esc(effortLabel(e))} reasoning effort` : 'Whatever the harness is set to'}">${esc(e ? effortLabel(e) : 'Default')}</button>`)
      .join('')}</span>`;
  };
  const markInUse = (id) => {
    $$('.pk-dot', node).forEach((d) => d.remove());
    sideRows.find((b) => b.dataset.id === id)?.insertAdjacentHTML('beforeend', '<span class="pk-dot" title="In use"></span>');
  };
  const chooseEffort = (e) => {
    const m = modelOf(focusAgent);
    if (focusAgent === agent && e === effort) return;
    if (focusAgent !== agent) markInUse(focusAgent);
    agent = focusAgent;
    model = m;
    effort = e;
    pick(agent, model, effort);
    paintEffort();
    $(`button[data-e="${CSS.escape(e)}"]`, seg)?.focus();
  };

  const paintModels = () => {
    const a = S.agents.find((x) => x.id === focusAgent);
    sideRows.forEach((b) => b.classList.toggle('on', b.dataset.id === focusAgent));
    const models = a?.models || [{ id: '', label: 'Default' }];
    const current = focusAgent === agent ? model : savedModel(focusAgent);
    input.placeholder = `Search ${a?.name || ''} models`;
    $('.pk-search', node).hidden = models.length <= 6;
    // opencode-style ids (provider/model) group by provider.
    const groups = new Map();
    for (const m of models) {
      const g = m.id && m.id.includes('/') ? m.hint || '' : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    list.innerHTML = [...groups]
      .map(
        ([g, ms]) =>
          `<div class="pk-group">${g ? `<div class="pk-ghead">${esc(g)}</div>` : ''}${ms
            .map(
              (m) => `<button class="pk-m${m.id === current ? ' on' : ''}" role="option" aria-selected="${m.id === current}" data-id="${esc(m.id)}">
                <span class="pk-text"><b>${esc(m.id ? m.label : 'Default')}</b><small>${esc(m.id ? (m.hint && m.hint !== g ? m.hint : '') : m.hint || `Whatever ${a?.name} is set to`)}</small></span>${icon('check', 'pk-check')}
              </button>`,
            )
            .join('')}</div>`,
      )
      .join('') + '<div class="pk-empty" hidden>No models match</div>';
    filter();
    paintEffort();
  };
  const rows = () => $$('.pk-m', list).filter((b) => !b.hidden);
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    for (const b of $$('.pk-m', list)) b.hidden = !!q && !`${b.dataset.id} ${b.textContent}`.toLowerCase().includes(q);
    for (const g of $$('.pk-group', list)) g.hidden = !$$('.pk-m', g).some((b) => !b.hidden);
    $('.pk-empty', list).hidden = rows().length > 0;
  };
  const focusModels = () => {
    const rs = rows();
    const target = rs.find((b) => b.classList.contains('on')) || rs[0];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };
  const preview = (id, { focus } = {}) => {
    if (id !== focusAgent) {
      focusAgent = id;
      input.value = '';
      paintModels();
    }
    if (focus) sideRows.find((b) => b.dataset.id === id)?.focus();
  };

  // Picking a harness applies it straight away with the model and level it shows as selected.
  const useAgent = (id) => {
    preview(id);
    if (id === agent) return;
    markInUse(id);
    agent = id;
    model = savedModel(id);
    effort = savedEffort(id, model);
    pick(agent, model, effort);
  };

  const close = () => {
    node.remove();
    anchor.classList.remove('open');
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', keys, true);
  };
  node.close = close;
  const choose = (m) => {
    close();
    anchor.focus();
    // Carry the thinking level over when the new model accepts it, else fall back to the saved one.
    const cur = effortOf(focusAgent);
    const e = effortsFor(focusAgent, m).includes(cur) ? cur : savedEffort(focusAgent, m);
    if (focusAgent !== agent || m !== model || e !== effort) pick(focusAgent, m, e);
  };
  const outside = (e) => !node.contains(e.target) && !anchor.contains(e.target) && close();
  const step = (items, d) => {
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    return next;
  };
  const keys = (e) => {
    const inSide = sideRows.includes(document.activeElement);
    const live = sideRows.filter((b) => !b.disabled);
    const segBtns = $$('button', seg);
    const inSeg = segBtns.includes(document.activeElement);
    if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), close(), anchor.focus();
    // Tab hops from the model list to the thinking levels and back; anywhere else it leaves.
    if (e.key === 'Tab' && !seg.hidden && (inSeg ? e.shiftKey : !e.shiftKey && !inSide)) {
      e.preventDefault();
      return inSeg ? focusModels() : (segBtns.find((b) => b.classList.contains('on')) || segBtns[0]).focus();
    }
    if (e.key === 'Tab') return close();
    if (inSeg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      return step(segBtns, e.key === 'ArrowRight' ? 1 : -1);
    }
    if (inSeg && e.key === 'ArrowUp') return e.preventDefault(), focusModels();
    if (inSeg && (e.key === 'Enter' || e.key === ' ')) return e.preventDefault(), chooseEffort(document.activeElement.dataset.e);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      if (inSide) preview(step(live, d)?.dataset.id);
      else step(rows(), d);
    } else if (e.key === 'ArrowLeft' && document.activeElement !== input) {
      e.preventDefault();
      preview(focusAgent, { focus: true });
    } else if ((e.key === 'ArrowRight' || e.key === 'Enter') && inSide) {
      e.preventDefault();
      if (e.key === 'Enter') useAgent(focusAgent);
      focusModels();
    } else if (e.key === 'Enter' && document.activeElement === input && rows()[0]) {
      e.preventDefault();
      choose(rows()[0].dataset.id);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !$('.pk-search', node).hidden && document.activeElement !== input) {
      input.focus(); // type-to-search from anywhere in the picker
    }
  };
  sideRows.forEach((b) => (b.onclick = () => useAgent(b.dataset.id)));
  list.onclick = (e) => {
    const b = e.target.closest('.pk-m');
    if (b) choose(b.dataset.id);
  };
  input.oninput = filter;
  seg.onclick = (e) => {
    const b = e.target.closest('button[data-e]');
    if (b) chooseEffort(b.dataset.e);
  };

  paintModels();
  setTimeout(() => document.addEventListener('mousedown', outside));
  document.addEventListener('keydown', keys, true);
  document.body.append(node);
  anchor.classList.add('open');
  focusModels(); // scrolls the current model into view…
  if (!$('.pk-search', node).hidden) input.focus({ preventScroll: true }); // …then search is ready to type
}

function moreMenu(id, anchor) {
  const s = S.full.get(id);
  if (!s) return;
  const lastTurn = s.turns?.at(-1);
  const canRollback = s.agent !== 'wisp' && s.state !== 'running' && (lastTurn?.changes?.length || lastTurn?.checkpoint?.commit);
  const rolledBack = !!lastTurn?.rolledBackAt;
  const r = anchor.getBoundingClientRect();
  const menu = el(`
    <div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      <button data-a="rename">${icon('pen')}Rename${keyHint('M')}</button>
      ${s.agentSessionId ? `<button data-a="copy">${icon('copy')}Copy resume command</button>` : ''}
      <button data-a="folder">${icon('folder')}Open project in editor</button>
      ${canRollback ? `<button data-a="rollback">${icon(rolledBack ? 'rerun' : 'replay')}${rolledBack ? 'Re-apply latest turn' : 'Restore to before latest turn'}</button>` : ''}
      ${s.archived ? `<button data-a="unarchive">${icon('archive')}Unarchive${keyHint('A')}</button>` : s.state !== 'running' && s.state !== 'waiting' ? `<button data-a="archive">${icon('archive')}Archive${keyHint('A')}</button>` : ''}
      <button data-a="delete" class="danger">${icon('trash')}Delete session${keyHint('⌫')}</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (e) => !menu.contains(e.target) && close();
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'rename') rename(id);
    if (a === 'copy') {
      const { command } = await api(`/sessions/${id}/takeover`);
      copy(command);
      toast('Copied resume command');
    }
    if (a === 'folder') openInEditor(s, '.');
    if (a === 'rollback') rollbackTurn(id, lastTurn?.id, rolledBack);
    if (a === 'archive' || a === 'unarchive') setArchived(id, a === 'archive');
    if (a === 'delete') deleteSession(id);
  };
  document.body.append(menu);
}

// Right-click on a feed item.
function taskMenu(id, e) {
  const s = S.sessions.get(id);
  if (!s) return;
  $('.menu.task')?.close();
  const busy = s.state === 'running' || s.state === 'waiting';
  const menu = el(`
    <div class="menu task" style="top:${e.clientY}px;left:${e.clientX}px">
      ${S.open.has(id) ? `<button data-a="collapse">${icon('chevron')}Collapse${keyHint('O')}</button>` : `<button data-a="open">${icon('chevron')}Open${keyHint('O')}</button>`}
      <button data-a="rename">${icon('pen')}Rename${keyHint('M')}</button>
      <button data-a="rerun">${icon('rerun')}Rerun…${keyHint('⇧R')}</button>
      ${s.branch && !busy && s.pr?.state !== 'MERGED' ? `<button data-a="ship">${icon('send')}${s.pr?.state === 'OPEN' ? `Push to PR #${s.pr.number}` : 'Ship it…'}${keyHint('S')}</button>` : ''}
      ${s.pr?.state === 'OPEN' ? `<button data-a="merge">${icon('check')}Merge PR #${s.pr.number}…</button>` : ''}
      ${s.groupId ? `<button data-a="compare"><b class="vs-mark">vs</b>Compare runs</button>` : ''}
      <button data-a="recipe">${icon('spark')}Save as recipe…</button>
      ${busy || s.archived ? '' : `<button data-a="done">${icon('done')}${s.state === 'done' ? 'Reopen' : 'Mark done'}${keyHint('E')}</button>`}
      ${s.archived ? `<button data-a="unarchive">${icon('archive')}Unarchive${keyHint('A')}</button>` : busy ? '' : `<button data-a="archive">${icon('archive')}Archive${keyHint('A')}</button>`}
      <button data-a="delete" class="danger">${icon('trash')}Delete session${keyHint('⌫')}</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'open') expand(id);
    if (a === 'collapse') collapse(id);
    if (a === 'rename') rename(id);
    if (a === 'rerun') rerun(id);
    if (a === 'ship') shipDialog(id);
    if (a === 'merge') mergePr(id);
    if (a === 'compare') compareView(id);
    if (a === 'recipe') saveAsRecipe(id);
    if (a === 'done') toggleDone(id);
    if (a === 'archive' || a === 'unarchive') setArchived(id, a === 'archive');
    if (a === 'delete') deleteSession(id);
  };
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

// The keyboard shortcut for a menu item, shown at its right edge. Menus act on the
// focused card, so the key does the same thing as the click.
const keyHint = (k) => `<kbd class="menu-kbd">${k}</kbd>`;

async function deleteSession(id) {
  if (!confirm('Delete this session from wisp? (The agent’s own history is kept.)')) return;
  const leave = handOff(id);
  const ok = await api(`/sessions/${id}`, { method: 'DELETE' }).then(() => true, (err) => toast(esc(err.message), { tone: 'bad' }));
  if (ok) leave(() => S.sessions.delete(id));
}

// Launch the task again as a new session in the same folder: same prompt and attachments,
// optionally edited, on whichever harness, model and thinking level you pick. The original stays.
async function rerun(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch((err) => toast(esc(err.message), { tone: 'bad' })));
  const first = s?.turns?.[0];
  if (!first?.prompt) return toast('Nothing to rerun — this session has no prompt.', { tone: 'bad' });
  const has = (a) => S.agents.some((x) => x.id === a && x.available);
  let agent = has(s.agent) ? s.agent : S.agents.find((x) => x.available)?.id || s.agent;
  const models = S.agents.find((x) => x.id === agent)?.models || [];
  let model = agent === s.agent && models.some((m) => m.id === s.model) ? s.model : savedModel(agent);
  let effort = agent === s.agent && effortsFor(agent, model).includes(s.effort) ? s.effort : savedEffort(agent, model);
  let mode = MODES.some((m) => m.id === s.mode) ? s.mode : S.config.defaults.mode || 'edits';
  const files = first.attachments || [];

  const node = el(`
    <div class="modal rerun-modal">
      <header><h2>Rerun task</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="rr-box">
        <textarea class="rr-prompt" rows="3" spellcheck="false"></textarea>
        ${files.length ? `<div class="rr-files">${files.map((f) => `<span class="rr-file">${icon('clip')}${esc(f.name)}</span>`).join('')}</div>` : ''}
        <div class="l-bar">
          <button class="mode-btn" data-a="mode" aria-haspopup="menu"></button>
          <button class="runner-btn" data-a="runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button>
          <span class="grow"></span>
          <button class="primary sm" data-a="go">${icon('rerun')}Rerun</button>
        </div>
      </div>
      <p class="hint">Starts a new session in <code>${esc(s.cwd)}</code>. “${esc(s.title)}” is kept as it is.</p>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const ta = $('.rr-prompt', node);
  ta.value = first.prompt;
  autosize(ta);
  const modeBtn = $('[data-a="mode"]', node);
  const paintMode = () => {
    const m = MODES.find((x) => x.id === mode) || MODES[1];
    modeBtn.className = `mode-btn m-${m.id}`;
    modeBtn.innerHTML = `${icon(m.icon)}<span>${m.label}</span>`;
    modeBtn.title = m.hint;
  };
  const runnerBtn = $('[data-a="runner"]', node);
  const paintRunner = () => paintRunnerBtn(runnerBtn, agent, model, effort);
  paintMode();
  paintRunner();
  modeBtn.onclick = () => modeMenu(modeBtn, mode, (m) => ((mode = m), paintMode(), ta.focus()));
  // Picks here only apply to this rerun; the launcher's remembered defaults are left alone.
  runnerBtn.onclick = () =>
    runnerPicker(runnerBtn, { agent, model, effort, savedModel, savedEffort }, (a, m, e) => {
      [agent, model, effort] = [a, m, e];
      paintRunner();
    });

  const go = async () => {
    const prompt = ta.value.trim();
    if (!prompt) return ta.focus();
    const btn = $('[data-a="go"]', node);
    btn.disabled = true;
    try {
      const next = await api('/sessions', { method: 'POST', body: { prompt, cwd: s.cwd, agent, mode, model, effort, attachments: files.map((f) => f.id) } });
      S.sessions.set(next.id, next);
      close();
      if (S.filter !== 'all' && S.filter !== next.projectId) {
        S.filter = 'all';
        save('wisp.filter', S.filter);
      }
      renderFeed();
      setFocus(next.id);
      toast(`Rerunning on ${esc(agentName(agent))}`);
    } catch (err) {
      btn.disabled = false;
      toast(esc(err.message), { tone: 'bad' });
    }
  };
  $('[data-a="go"]', node).onclick = go;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), go());
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      mode = MODES[(MODES.findIndex((m) => m.id === mode) + 1) % MODES.length].id;
      paintMode();
    }
  });
  requestAnimationFrame(() => (ta.focus(), ta.setSelectionRange(ta.value.length, ta.value.length)));
}

async function setArchived(id, archived) {
  const leave = archived && handOff(id);
  try {
    await api(`/sessions/${id}`, { method: 'PATCH', body: { archived } });
  } catch (err) {
    return toast(esc(err.message), { tone: 'bad' });
  }
  if (leave) {
    leave(() => S.sessions.set(id, { ...S.sessions.get(id), archived: true }));
    toast('Archived', { action: { label: 'Undo', run: () => setArchived(id, false) } });
  }
}

function replay(id) {
  const n = S.nodes.get(id);
  if (!n?.body) return;
  for (const v of n.turnNodes.values()) v.node.remove();
  n.turnNodes.clear();
  renderBody(id, { fresh: false });
  $('.turns', n.body).lastElementChild?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

const EDITORS = {
  vscode: (f, l) => `vscode://file${f}${l ? `:${l}` : ''}`,
  cursor: (f, l) => `cursor://file${f}${l ? `:${l}` : ''}`,
  windsurf: (f, l) => `windsurf://file${f}${l ? `:${l}` : ''}`,
  zed: (f, l) => `zed://file${f}${l ? `:${l}` : ''}`,
  idea: (f, l) => `idea://open?file=${encodeURIComponent(f)}${l ? `&line=${l}` : ''}`,
};

// VS Code and its forks open a file on a machine through their Remote - SSH extension.
const REMOTE_EDITORS = new Set(['vscode', 'cursor', 'windsurf']);

function openInEditor(s, p, line) {
  const editor = S.config.defaults.editor || 'vscode';
  const abs = p.startsWith('/') ? p : `${s.cwd}/${p}`.replace(/\/\.$/, '');
  if (s.machine) {
    if (!REMOTE_EDITORS.has(editor)) {
      copy(abs);
      return toast(`Copied path ${esc(abs)} (on ${esc(s.machine.name)})`);
    }
    location.href = `${editor}://vscode-remote/ssh-remote+${encodeURIComponent(s.machine.target)}${abs}${line ? `:${line}` : ''}`;
    return;
  }
  if (editor === 'none' || !EDITORS[editor]) {
    copy(abs);
    return toast(`Copied path ${esc(abs)}`);
  }
  location.href = EDITORS[editor](abs, line);
}

// Bring an item into view, expanded — used by notifications and links.
function reveal(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.archived) S.showArchived = true;
  else if (s.state === 'done' && !S.showDone) {
    S.showDone = true;
    save('wisp.showDone', true);
  }
  if (S.filter !== 'all' && S.filter !== s.projectId) {
    S.filter = 'all';
    save('wisp.filter', S.filter);
    renderLaunchChips();
  }
  renderFeed();
  setFocus(id, { scroll: false });
  if (S.open.has(id)) S.nodes.get(id)?.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  else expand(id);
}

// --- projects modal ---------------------------------------------------------------------

const COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];

// where: a machine id to add folders on that computer (server/machines.js), else this one.
async function openProjects({ focusAdd = false, machine = null, host } = {}) {
  const node = el(`
    <div class="modal projects-modal">
      <header><h2>Projects</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="mem-tabs where"></div>
      <div class="add-row">
        <div class="field lg mono path-input">
          ${window.wispDesktop ? `<button class="browse" title="Browse…">${icon('folder')}</button>` : icon('folder')}
          <input id="ppath" placeholder="~/code/my-app" spellcheck="false" autocomplete="off">
          <div class="suggest" hidden></div>
        </div>
        ${window.wispDesktop ? `<button class="ghost" id="pbrowse">${icon('folder')}Browse…</button>` : ''}
        <button class="primary" id="padd">Add</button>
      </div>
      <p class="hint"></p>
      <div class="plist" id="plist"></div>
      <div class="discover" id="discover"><h4>Found on this machine</h4><p class="muted">Looking for git repos…</p></div>
    </div>`);
  present(node, host);
  const input = $('#ppath', node);
  const sug = $('.suggest', node);
  let where = machine && machineById(machine) ? machine : null;
  const here = () => machineById(where);
  const home = () => (where ? here()?.remote?.home : S.config.home) || '';
  const tilde = (p) => (home() && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);

  const paintWhere = () => {
    const tabs = $('.where', node);
    tabs.innerHTML = `<button data-w="" class="${where ? '' : 'on'}">${icon('folder')}This computer</button>${S.machines
      .map((m) => `<button data-w="${m.id}" class="${where === m.id ? 'on' : ''}" title="${esc(m.target)} · ${esc(MACHINE_STATE[m.state] || m.state)}">${icon('server')}${esc(m.name)}<i class="dot ${m.state === 'online' ? 'ok' : m.state === 'error' ? 'bad' : ''}"></i></button>`)
      .join('')}<i></i>${host ? '' : `<button data-w="+" title="Run agents on another computer over SSH">${icon('plus')}Machine</button>`}`;
    const m = here();
    input.placeholder = m ? `~/code/my-app on ${m.name}` : '~/code/my-app';
    $$('#pbrowse, .browse', node).forEach((b) => (b.hidden = !!m));
    $('.hint', node).innerHTML = m
      ? `Folders on <b>${esc(m.name)}</b>. Agents run there, in its own worktrees; you follow along here.`
      : 'Tip: run <code>wisp add</code> inside any folder, or launch from a terminal with <code>wisp "task"</code> — the folder is added automatically.';
  };
  $('.where', node).addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    if (b.dataset.w === '+') {
      openMachines({ focusAdd: true });
      return;
    }
    where = b.dataset.w || null;
    sug.hidden = true;
    paintWhere();
    list();
    discover();
    input.focus();
  });

  const add = async (p) => {
    try {
      const proj = await api('/projects', { method: 'POST', body: { path: p, ...(where && { machine: where }) } });
      await loadConfig();
      launchPicks[placeOf(proj)] = proj.id;
      if (!launchWhere.includes(placeOf(proj))) launchWhere = [placeOf(proj)];
      if (placeOf(proj) === launchWhere[0]) launchProject = proj.id;
      saveWhere();
      renderLaunchChips();
      toast(`Added <b>${esc(proj.name)}</b>${where ? ` on ${esc(here()?.name || '')}` : ''}`);
      input.value = '';
      sug.hidden = true;
      list();
      discover();
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    }
  };
  $('#padd', node).onclick = () => {
    if (input.value.trim()) add(input.value.trim());
  };
  const browse = async () => {
    const dir = await window.wispDesktop.pickFolder();
    if (dir) add(dir);
  };
  $$('#pbrowse, .browse', node).forEach((b) => (b.onclick = browse));

  let sel = -1;
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value;
      if (!q) return (sug.hidden = true);
      const dirs = await api(`${where ? `/machines/${where}/fs` : '/fs'}?q=${encodeURIComponent(q)}`).catch(() => []);
      sel = -1;
      sug.hidden = !dirs.length;
      sug.innerHTML = dirs.map((d) => `<button data-p="${esc(d)}">${esc(tilde(d))}</button>`).join('');
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    const opts = $$('button', sug);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('on', i === sel));
    } else if (e.key === 'Tab' && opts.length) {
      e.preventDefault();
      input.value = tilde(opts[Math.max(0, sel)].dataset.p + '/');
      input.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(sel >= 0 ? opts[sel].dataset.p : input.value.trim());
    }
  });
  sug.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) add(b.dataset.p);
  });

  const list = () => {
    const box = $('#plist', node);
    const projects = S.config.projects.filter((p) => (p.machine || null) === where);
    box.innerHTML = projects.length
      ? projects
          .map((p) => {
            const n = [...S.sessions.values()].filter((s) => s.projectId === p.id).length;
            return `<div class="prow c-${p.color}" data-id="${p.id}">
              <button class="swatch" title="Change colour"><i class="p-dot"></i></button>
              <div class="prow-main"><input class="pname" value="${esc(p.name)}"><span class="ppath">${esc(tilde(p.path))}</span></div>
              <span class="pcount">${n} session${n === 1 ? '' : 's'}</span>
              <button class="icon-btn premove" title="Remove from wisp (files untouched)">${icon('trash')}</button>
            </div>`;
          })
          .join('')
      : `<p class="muted">No projects ${where ? `on ${esc(here()?.name || '')} ` : ''}yet. Add a folder above, or pick one below.</p>`;
    $$('.prow', box).forEach((row) => {
      const id = row.dataset.id;
      const p = projectById(id);
      $('.pname', row).onchange = (e) => api(`/projects/${id}`, { method: 'PATCH', body: { name: e.target.value } }).then(loadConfig);
      $('.swatch', row).onclick = () => {
        const color = COLORS[(COLORS.indexOf(p.color) + 1) % COLORS.length];
        api(`/projects/${id}`, { method: 'PATCH', body: { color } }).then(async () => (await loadConfig(), list()));
      };
      $('.premove', row).onclick = async () => {
        if (!confirm(`Remove “${p.name}” from wisp? Sessions and files are kept.`)) return;
        await api(`/projects/${id}`, { method: 'DELETE' });
        await loadConfig();
        list();
      };
    });
  };

  const discover = async () => {
    const box = $('#discover', node);
    const m = here();
    const at = where;
    box.onclick = (e) => {
      const b = e.target.closest('.found-item');
      if (b) add(b.dataset.p);
      if (e.target.closest('[data-a="connect"]')) connectMachine(at);
    };
    if (m && m.state !== 'online') {
      box.innerHTML = `<p class="muted">${esc(m.name)} is ${m.state === 'connecting' || m.state === 'reconnecting' ? 'connecting…' : `offline. <button class="link" data-a="connect">Connect</button>`}</p>`;
      return;
    }
    box.innerHTML = `<h4>Found on ${m ? esc(m.name) : 'this machine'}</h4><p class="muted">Looking for git repos…</p>`;
    const found = await api(m ? `/machines/${m.id}/discover` : '/projects/discover').catch(() => []);
    if (where !== at) return; // switched tabs meanwhile
    box.innerHTML = found.length
      ? `<h4>Found on ${m ? esc(m.name) : 'this machine'} <span class="muted">· git repos</span></h4><div class="found">${found
          .map((f) => `<button class="found-item" data-p="${esc(f.path)}">${icon('plus')}<b>${esc(f.name)}</b><span>${esc(tilde(f.path).replace(/\/[^/]+$/, ''))}</span></button>`)
          .join('')}</div>`
      : '';
  };
  let wasOnline = here()?.state === 'online';
  node.refresh = () => {
    paintWhere();
    const on = here()?.state === 'online';
    if (on !== wasOnline) discover();
    wasOnline = on;
  };

  paintWhere();
  list();
  discover();
  if (focusAdd) setTimeout(() => input.focus(), 60);
}

// --- ship it: worktree → commit → PR → checks → merge ---------------------------------------

const prTone = (pr) =>
  pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.checks?.fail ? 'fail' : pr.checks?.pending ? 'pending' : pr.review === 'CHANGES_REQUESTED' ? 'fail' : 'pass';
const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
function prLine(pr) {
  const c = pr.checks || {};
  const checks = c.fail ? `${c.fail} check${c.fail > 1 ? 's' : ''} failing` : c.pending ? `${c.pending} check${c.pending > 1 ? 's' : ''} running` : c.pass ? `${c.pass} check${c.pass > 1 ? 's' : ''} passed` : 'No checks';
  const state = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.draft ? 'Draft' : 'Open';
  return [state, pr.state === 'OPEN' ? checks : '', pr.state === 'OPEN' ? REVIEW[pr.review] : ''].filter(Boolean).join(' · ');
}
const prPill = (pr) => `<span class="pill pr pr-${prTone(pr)}" title="PR #${pr.number}: ${esc(prLine(pr))}"><i></i>#${pr.number}</span>`;

// The PR row under a card's bar; reads the live summary, so polled check results show up.
function renderPrStrip(id) {
  const n = S.nodes.get(id);
  const node = n?.body && $('.pr-strip', n.body);
  const s = S.sessions.get(id);
  if (!node || !s) return;
  const pr = s.pr;
  $$('[data-a="ship"] span', n.body).forEach((b) => (b.textContent = pr?.state === 'OPEN' ? `Push to #${pr.number}` : pr ? 'Ship again' : 'Ship it'));
  node.hidden = !pr;
  if (!pr) return;
  const tone = prTone(pr);
  node.className = `pr-strip pr-${tone}`;
  node.innerHTML = `
    <span class="pr-dot"></span>
    <a href="${esc(pr.url)}" target="_blank" class="pr-num">PR #${pr.number}</a>
    <span class="pr-line">${esc(prLine(pr))}</span>
    <span class="grow"></span>
    ${pr.state === 'OPEN' ? `<button class="ghost xs" data-pr="refresh" title="Check now (wisp also checks every minute)">${icon('replay')}</button>` : ''}
    <a class="ghost xs" href="${esc(pr.url)}" target="_blank">${icon('external')}<span>GitHub</span></a>
    ${pr.state === 'OPEN' ? `<button class="ghost xs pr-merge" data-pr="merge" title="Squash-merge, then fast-forward your local ${esc(s.branch ? 'base branch' : 'checkout')}">${icon('check')}<span>Merge</span></button>` : ''}`;
  node.onclick = (e) => {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (a === 'refresh') api(`/sessions/${id}/pr`, { method: 'POST', body: {} }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
    if (a === 'merge') mergePr(id);
  };
}

async function shipDialog(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.state === 'running' || s.state === 'waiting') return toast('Still working: let it finish first.');
  let info;
  try {
    info = await api(`/sessions/${id}/ship`);
  } catch (err) {
    return toast(esc(err.message), { tone: 'bad' });
  }
  const open = info.pr?.state === 'OPEN';
  const nothing = !info.dirty && !info.ahead;
  const node = el(`
    <div class="modal ship-modal">
      <header><h2>${open ? `Push to PR #${info.pr.number}` : 'Ship it'}</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="ship-route">${icon('branch')}<code>${esc(info.branch)}</code>${icon('arrow')}<code>${esc(info.remote || 'no remote')}/${esc(info.base)}</code>
        <span class="muted">${info.dirty ? `${info.dirty} uncommitted change${info.dirty > 1 ? 's' : ''}` : 'Nothing uncommitted'} · ${info.ahead} commit${info.ahead === 1 ? '' : 's'} on the branch</span></p>
      ${info.dirty ? `<label class="ship-field"><span>Commit message${open ? '' : ' · PR title'}</span><input class="input" name="title" spellcheck="false" maxlength="100"></label>` : ''}
      ${open ? '' : `<label class="ship-field"><span>Pull request description</span><textarea class="textarea mono" name="body" rows="9" spellcheck="false"></textarea></label>
      <label class="check ship-check"><input type="checkbox" name="draft"> Open as a draft</label>`}
      ${!info.remote ? '<p class="hint bad">This repo has no <code>origin</code> remote, so there is nowhere to push.</p>' : nothing ? '<p class="hint">Nothing to ship yet: the branch has no changes.</p>' : ''}
      <div class="ship-foot"><span class="muted xs">Runs <code>git commit</code>, <code>git push</code>${open ? '' : ' and <code>gh pr create</code>'} in the worktree.</span><button class="primary sm" data-a="go" ${nothing || !info.remote ? 'disabled' : ''}>${icon('send')}${open ? 'Commit & push' : 'Commit, push & open PR'}</button></div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const title = $('[name="title"]', node);
  const body = $('[name="body"]', node);
  if (title) title.value = info.title;
  if (body) body.value = info.body;
  const go = async () => {
    const btn = $('[data-a="go"]', node);
    btn.disabled = true;
    btn.lastChild.textContent = 'Shipping…';
    try {
      const pr = await api(`/sessions/${id}/ship`, { method: 'POST', body: { title: title?.value || info.title, body: body?.value ?? info.body, draft: !!$('[name="draft"]', node)?.checked } });
      close();
      toast(`${icon('branch')} ${open ? 'Pushed to' : 'Opened'} <b>PR #${pr.number}</b>`, { action: { label: 'Open', run: () => window.open(pr.url, '_blank') }, timeout: 8000 });
    } catch (err) {
      btn.disabled = false;
      btn.lastChild.textContent = open ? 'Commit & push' : 'Commit, push & open PR';
      toast(esc(err.message), { tone: 'bad', timeout: 10_000 });
    }
  };
  $('[data-a="go"]', node).onclick = go;
  requestAnimationFrame(() => (title || $('[data-a="go"]', node)).focus());
}

async function mergePr(id) {
  const s = S.sessions.get(id);
  const pr = s?.pr;
  if (!pr || pr.state !== 'OPEN') return;
  const c = pr.checks || {};
  const warn = c.fail ? `\n\n⚠ ${c.fail} check${c.fail > 1 ? 's are' : ' is'} failing.` : c.pending ? `\n\n⚠ ${c.pending} check${c.pending > 1 ? 's are' : ' is'} still running.` : '';
  if (!confirm(`Squash-merge PR #${pr.number}${pr.draft ? ' (marks it ready first)' : ''}, then fast-forward your local base branch and remove the worktree?${warn}`)) return;
  toast(`Merging PR #${pr.number}…`);
  try {
    const r = await api(`/sessions/${id}/merge`, { method: 'POST', body: {} });
    toast(`${icon('check')} Merged <b>PR #${r.pr.number}</b>. ${esc(r.sync.text)}`, { tone: r.sync.ok ? '' : 'bad', timeout: 10_000 });
  } catch (err) {
    toast(esc(err.message), { tone: 'bad', timeout: 12_000 });
  }
}

// --- compare: one task, several harnesses, side by side -------------------------------------------

function turnMetrics(t) {
  const lines = (t?.changes || []).reduce((acc, c) => {
    const n = countChanges(c.edits);
    return { add: acc.add + n.add, del: acc.del + n.del };
  }, { add: 0, del: 0 });
  const tests = (t?.presentation?.blocks || []).filter((b) => b?.type === 'tests');
  return {
    time: t?.endedAt ? t.endedAt - t.startedAt : null,
    cost: t?.stats?.costUsd,
    files: t?.changes?.length || 0,
    ...lines,
    tests: tests.length ? { passed: tests.reduce((a, b) => a + (Number(b.passed) || 0), 0), failed: tests.reduce((a, b) => a + (Number(b.failed) || 0), 0) } : null,
    asks: (t?.activity || []).filter((a) => a.kind === 'ask').length,
  };
}

async function compareView(id) {
  const s0 = S.sessions.get(id);
  if (!s0?.groupId) return;
  const group = [...S.sessions.values()].filter((x) => x.groupId === s0.groupId).sort((a, b) => a.createdAt - b.createdAt);
  const fulls = (await Promise.all(group.map((g) => api(`/sessions/${g.id}`).catch(() => null)))).filter(Boolean);
  const node = el(`
    <div class="modal compare-modal">
      <header><h2>Compare</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="cmp-prompt">${esc(fulls[0]?.turns[0]?.prompt || '')}</p>
      <div class="cmp-grid" style="--n:${fulls.length}"></div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const grid = $('.cmp-grid', node);
  for (const f of fulls) {
    const sum = S.sessions.get(f.id) || {};
    const t = f.turns.at(-1);
    const mx = turnMetrics(t);
    const live = f.state === 'running' || f.state === 'waiting';
    const col = el(`
      <section class="cmp-col" data-id="${f.id}">
        <div class="cmp-head">
          <span class="rb-logo">${harnessLogo(f.agent)}</span>
          <span class="cmp-who"><b>${esc(agentName(f.agent))}</b><small>${esc(f.model || 'Default model')}${f.effort ? ` · ${esc(effortLabel(f.effort))}` : ''}</small></span>
          ${live ? `<span class="pill st-waiting"><i></i>${f.state === 'waiting' ? 'Asking' : 'Working'}</span>` : `<span class="pill st-${sum.status || 'info'}"><i></i>${STATUS_LABEL[sum.status] || 'Done'}</span>`}
        </div>
        <dl class="cmp-stats">
          <div><dt>Time</dt><dd>${mx.time !== null ? fmtDuration(mx.time) : '—'}</dd></div>
          <div><dt>Cost</dt><dd>${typeof mx.cost === 'number' ? `$${mx.cost.toFixed(2)}` : '—'}</dd></div>
          <div><dt>Files</dt><dd>${mx.files} <span class="plus">+${mx.add}</span> <span class="minus">−${mx.del}</span></dd></div>
          <div><dt>Tests</dt><dd>${mx.tests ? `<span class="${mx.tests.failed ? 'minus' : 'plus'}">${mx.tests.passed} ✓ ${mx.tests.failed ? `${mx.tests.failed} ✗` : ''}</span>` : '—'}</dd></div>
          <div><dt>Asked</dt><dd>${mx.asks}</dd></div>
        </dl>
        <div class="cmp-body"></div>
        <div class="cmp-foot">
          <button class="ghost xs" data-a="open">${icon('chevron')}Open card</button>
          <span class="grow"></span>
          <button class="primary sm" data-a="keep" ${live ? 'disabled title="Still working"' : ''}>${icon('check')}Keep this</button>
        </div>
      </section>`);
    $('.cmp-body', col).append(live ? el(`<p class="muted xs">${esc(sum.live || 'Working…')}</p>`) : renderPresentation(t?.presentation, ctxFor(f, t, false)));
    grid.append(col);
  }
  grid.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const keep = e.target.closest('.cmp-col')?.dataset.id;
    if (!a || !keep) return;
    if (a === 'open') return close(), reveal(keep);
    const others = group.filter((g) => g.id !== keep);
    if (!confirm(`Keep ${agentName(S.sessions.get(keep)?.agent)}'s result?\n\nThe other ${others.length === 1 ? 'run is' : `${others.length} runs are`} archived, and ${others.length === 1 ? 'its worktree is' : 'their worktrees are'} deleted with their changes.`)) return;
    for (const o of others) {
      if (o.state === 'running' || o.state === 'waiting') {
        await api(`/sessions/${o.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
        await until(() => S.sessions.get(o.id)?.state !== 'running', 5000);
      }
      await api(`/sessions/${o.id}`, { method: 'PATCH', body: { archived: true, discardWorktree: true } }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
    }
    close();
    reveal(keep);
    toast(`Kept ${esc(agentName(S.sessions.get(keep)?.agent))}'s run. Ship it when you're ready.`);
  };
}

// Poll a condition for up to `ms` (used after asking the server to stop something).
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 150));
}

// --- automations: recipes (saved prompts) and triggers (schedules, GitHub watchers) -----------

const TRIGGER_KINDS = [
  { kind: 'schedule', label: 'Schedule', icon: 'clock', hint: 'On a cron schedule, local time' },
  { kind: 'ci', label: 'CI failed', icon: 'warn', hint: 'A GitHub Actions run fails (polled with gh)' },
  { kind: 'issues', label: 'Issue labelled', icon: 'ask', hint: 'An open issue gets a label (polled with gh)' },
];
const CRON_PRESETS = [
  ['Weekdays 9:00', '0 9 * * 1-5'],
  ['Every hour', '0 * * * *'],
  ['Daily 18:00', '0 18 * * *'],
  ['Mondays 8:00', '0 8 * * 1'],
];
const recipeParams = (prompt) => [...new Set([...String(prompt || '').matchAll(/\{([a-zA-Z][\w-]{0,30})\}/g)].map((m) => m[1]))];
const whenLabel = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const projectOptions = (selected, { any } = {}) =>
  (any ? `<option value="">${esc(any)}</option>` : '') +
  S.config.projects.map((p) => `<option value="${esc(p.path)}" ${p.path === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
const modeOptions = (selected, { inherit } = {}) =>
  (inherit ? `<option value="">${esc(inherit)}</option>` : '') + MODES.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${m.label}</option>`).join('');

function openAutomations({ tab = 'recipes', edit = null, host } = {}) {
  const node = el(`<div class="modal auto-modal">
      <header><h2>Automations</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="mem-lede">Recipes are prompts you send again and again; <code>{name}</code> in one becomes a field to fill in. Triggers start sessions on their own.</p>
      <div class="mem-tabs" role="tablist"></div>
      <div class="auto-body"></div>
    </div>`);
  const close = present(node, host);
  let recipes = [];
  let triggers = [];
  let editing = edit; // { type: 'recipe' | 'trigger', draft }

  const render = async () => {
    [recipes, triggers] = await Promise.all([api('/recipes').catch(() => recipes), api('/triggers').catch(() => triggers)]);
    if (!node.isConnected) return;
    $('.mem-tabs', node).innerHTML = [
      ['recipes', 'Recipes', recipes.length],
      ['triggers', 'Triggers', triggers.length],
    ].map(([k, l, n]) => `<button role="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}<span>${n}</span></button>`).join('');
    const body = $('.auto-body', node);
    body.innerHTML = '';
    if (editing?.type === 'recipe') body.append(recipeForm(editing.draft));
    else if (editing?.type === 'trigger') body.append(triggerForm(editing.draft));
    else body.innerHTML = tab === 'recipes' ? recipesView() : triggersView();
  };

  const recipesView = () =>
    `<div class="au-list">${
      recipes
        .map((r) => {
          const proj = S.config.projects.find((p) => p.path === r.cwd);
          const tags = [r.params.length ? r.params.map((p) => `{${p}}`).join(' ') : '', proj ? proj.name : 'Any project', r.agent ? agentName(r.agent) : '', r.runs ? `${r.runs} run${r.runs > 1 ? 's' : ''}` : ''].filter(Boolean);
          return `<div class="au-item" data-id="${r.id}">
            <span class="mem-ico">${icon('spark')}</span>
            <div class="au-main"><b>${esc(r.name)}</b><p>${esc(r.prompt.replace(/\s+/g, ' ').slice(0, 140))}</p><span class="au-tags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}</span></div>
            <span class="au-acts"><button class="primary sm" data-act="run">Run</button><button class="icon-btn" data-act="schedule" title="Run it on a schedule">${icon('clock')}</button><button class="icon-btn" data-act="edit" title="Edit">${icon('pen')}</button><button class="icon-btn" data-act="delete" title="Delete">${icon('trash')}</button></span>
          </div>`;
        })
        .join('') || '<p class="mem-empty">No recipes yet. Save a task you repeat, like a release checklist, a PR from a commit, or a dependency bump.</p>'
    }</div><button class="mem-add" data-act="new">${icon('plus')}New recipe</button>
    <p class="hint">Also from the terminal: <code>wisp recipes</code>, <code>wisp run &lt;name&gt; [values…]</code>.</p>`;

  const describe = (t) => {
    const proj = S.config.projects.find((p) => p.path === t.cwd)?.name || t.cwd.split(/[\\/]/).pop();
    if (t.kind === 'schedule') return `<code>${esc(t.cron)}</code> in ${esc(proj)}${t.nextAt ? ` · next ${esc(whenLabel(t.nextAt))}` : ''}`;
    const what = t.kind === 'ci' ? `failed CI${t.branch ? ` on <code>${esc(t.branch)}</code>` : ''}` : `issues labelled <code>${esc(t.label)}</code>`;
    return `Watches ${what} in ${esc(proj)} every ${t.every} min${t.seeded ? '' : ' · first check records what is already there'}`;
  };
  const triggersView = () =>
    `<div class="au-list">${
      triggers
        .map((t) => {
          const k = TRIGGER_KINDS.find((x) => x.kind === t.kind);
          const last = t.lastSessionId && S.sessions.has(t.lastSessionId) ? `<a href="#" data-session="${esc(t.lastSessionId)}">last run ${ago(t.lastRunAt)} ago</a>` : t.lastRunAt ? `last run ${ago(t.lastRunAt)} ago` : 'not run yet';
          return `<div class="au-item ${t.enabled ? '' : 'off'}" data-id="${t.id}">
            <span class="mem-ico">${icon(k.icon)}</span>
            <div class="au-main"><b>${esc(t.name)}</b><p>${describe(t)}</p><span class="au-tags"><i>${esc(MODES.find((m) => m.id === t.mode)?.label || t.mode)}</i>${t.agent ? `<i>${esc(agentName(t.agent))}</i>` : ''}<i>${last}</i></span>${t.lastError ? `<p class="au-err">${icon('warn')}${esc(t.lastError)}</p>` : ''}</div>
            <span class="au-acts"><button class="ghost xs" data-act="fire" title="${t.kind === 'schedule' ? 'Run it now' : 'Check GitHub now'}">${icon('replay')}${t.kind === 'schedule' ? 'Run now' : 'Check now'}</button><button class="switch" data-act="toggle" role="switch" aria-checked="${t.enabled}" title="On / off"></button><button class="icon-btn" data-act="edit" title="Edit">${icon('pen')}</button><button class="icon-btn" data-act="delete" title="Delete">${icon('trash')}</button></span>
          </div>`;
        })
        .join('') || '<p class="mem-empty">No triggers yet. Run a recipe every weekday morning, or send an agent after every red CI run.</p>'
    }</div><button class="mem-add" data-act="new">${icon('plus')}New trigger</button>
    <p class="hint">Triggers run while wisp is open. GitHub watchers use your <code>gh</code> login and poll, so nothing has to reach this machine.</p>`;

  // Harness · model button for a form, with "Launcher default" when no agent is set.
  const runnerField = (draft) => {
    const wrap = el(`<div class="au-runner"><button type="button" class="runner-btn" aria-haspopup="dialog"></button><button type="button" class="link xs" ${draft.agent ? '' : 'hidden'}>Use launcher default</button></div>`);
    const [btn, reset] = wrap.children;
    const paint = () => (paintRunnerBtn(btn, draft.agent, draft.model, draft.effort), (reset.hidden = !draft.agent));
    btn.onclick = () =>
      runnerPicker(btn, { agent: draft.agent || S.config.defaults.agent, model: draft.model, effort: draft.effort, savedModel, savedEffort }, (a, m, e) => {
        Object.assign(draft, { agent: a, model: m, effort: e });
        paint();
      });
    reset.onclick = () => (Object.assign(draft, { agent: '', model: '', effort: '' }), paint());
    paint();
    return wrap;
  };

  const recipeForm = (d) => {
    const f = el(`<form class="au-form">
        <label><span>Name</span><input class="input" name="name" maxlength="60" placeholder="Release" spellcheck="false"></label>
        <label class="stack"><span>Prompt <small class="muted">· <code>{version}</code> becomes a field</small></span><textarea class="textarea mono" name="prompt" rows="7" spellcheck="false" placeholder="Prepare release {version}: update CHANGELOG, README and docs/, bump package.json, tag v{version}…"></textarea></label>
        <p class="au-params muted xs"></p>
        <label><span>Project</span><select name="cwd">${projectOptions(d.cwd, { any: 'Any project (picked when run)' })}</select></label>
        <label><span>Mode</span><select name="mode">${modeOptions(d.mode, { inherit: 'Launcher default' })}</select></label>
        <div class="au-row"><span>Harness</span></div>
        <div class="au-foot"><button type="button" class="ghost sm" data-act="cancel">Cancel</button><button class="primary sm">${d.id ? 'Save' : 'Create recipe'}</button></div>
      </form>`);
    $('[name="name"]', f).value = d.name || '';
    $('[name="prompt"]', f).value = d.prompt || '';
    $('.au-row', f).append(runnerField(d));
    const params = () => {
      const p = recipeParams($('[name="prompt"]', f).value);
      $('.au-params', f).innerHTML = p.length ? `Fields when run: ${p.map((x) => `<code>{${esc(x)}}</code>`).join(' ')}` : 'No fields: it runs as written.';
    };
    $('[name="prompt"]', f).oninput = params;
    params();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: $('[name="name"]', f).value, prompt: $('[name="prompt"]', f).value, cwd: $('[name="cwd"]', f).value, mode: $('[name="mode"]', f).value, agent: d.agent || '', model: d.model || '', effort: d.effort || '' };
      try {
        await api(d.id ? `/recipes/${d.id}` : '/recipes', { method: d.id ? 'PATCH' : 'POST', body });
        editing = null;
        tab = 'recipes';
        render();
      } catch (err) {
        toast(esc(err.message), { tone: 'bad' });
      }
    };
    requestAnimationFrame(() => $(d.name ? '[name="prompt"]' : '[name="name"]', f)?.focus());
    return f;
  };

  const triggerForm = (d) => {
    d.kind ||= 'schedule';
    const f = el(`<form class="au-form">
        <div class="au-kinds">${TRIGGER_KINDS.map((k) => `<button type="button" data-kind="${k.kind}" class="${k.kind === d.kind ? 'on' : ''}">${icon(k.icon)}<b>${k.label}</b><small>${k.hint}</small></button>`).join('')}</div>
        <label><span>Name</span><input class="input" name="name" maxlength="60" spellcheck="false"></label>
        <label><span>Project</span><select name="cwd">${projectOptions(d.cwd || projectById(launchProject)?.path)}</select></label>
        <div class="k-schedule"><label><span>When</span><input class="input mono" name="cron" spellcheck="false" placeholder="0 9 * * 1-5"></label>
          <p class="au-presets">${CRON_PRESETS.map(([l, c]) => `<button type="button" class="lp-chip" data-cron="${c}">${l}</button>`).join('')}<span class="muted xs">minute hour day month weekday</span></p></div>
        <div class="k-ci"><label><span>Branch</span><input class="input mono" name="branch" spellcheck="false" placeholder="Any branch (e.g. main)"></label></div>
        <div class="k-issues"><label><span>Label</span><input class="input" name="label" spellcheck="false" placeholder="wisp"></label></div>
        <div class="k-gh"><label><span>Check every</span><select name="every">${[2, 5, 15, 60].map((m) => `<option value="${m}" ${Number(d.every || 5) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label></div>
        <label><span>Run</span><select name="recipeId"><option value="">This prompt</option>${recipes.map((r) => `<option value="${r.id}" ${r.id === d.recipeId ? 'selected' : ''}>Recipe: ${esc(r.name)}</option>`).join('')}</select></label>
        <label class="stack k-prompt"><span>Prompt <small class="muted k-vars"></small></span><textarea class="textarea mono" name="prompt" rows="6" spellcheck="false"></textarea></label>
        <label><span>Mode</span><select name="mode">${modeOptions(d.mode || (d.kind === 'issues' ? 'plan' : 'edits'))}</select></label>
        <div class="au-row"><span>Harness</span></div>
        <p class="au-warn" hidden>${icon('warn')}<span>Issue text comes from GitHub: anyone who can open and label issues can steer this agent. Plan mode only reads; Full auto runs shell commands without asking.</span></p>
        <div class="au-foot"><button type="button" class="ghost sm" data-act="cancel">Cancel</button><button class="primary sm">${d.id ? 'Save' : 'Create trigger'}</button></div>
      </form>`);
    for (const k of ['name', 'cron', 'branch', 'label']) $(`[name="${k}"]`, f).value = d[k] || '';
    $('[name="prompt"]', f).value = d.prompt || '';
    $('.au-row', f).append(runnerField(d));
    const sync = () => {
      for (const k of ['schedule', 'ci', 'issues']) $(`.k-${k}`, f).hidden = d.kind !== k;
      $('.k-gh', f).hidden = d.kind === 'schedule';
      $('.k-prompt', f).hidden = !!$('[name="recipeId"]', f).value;
      $('.k-vars', f).innerHTML = d.kind === 'ci' ? '· <code>{name} {branch} {url} {id} {sha}</code> · empty = built-in CI prompt' : d.kind === 'issues' ? '· <code>{number} {title} {body} {url} {author}</code> · empty = built-in issue prompt' : '';
      $('.au-warn', f).hidden = !(d.kind === 'issues' && $('[name="mode"]', f).value !== 'plan');
      $$('.au-kinds button', f).forEach((b) => b.classList.toggle('on', b.dataset.kind === d.kind));
    };
    f.addEventListener('click', (e) => {
      const k = e.target.closest('[data-kind]')?.dataset.kind;
      if (k) {
        if (k === 'issues' && !d.id) $('[name="mode"]', f).value = 'plan';
        d.kind = k;
        sync();
      }
      const c = e.target.closest('[data-cron]')?.dataset.cron;
      if (c) $('[name="cron"]', f).value = c;
    });
    f.addEventListener('change', sync);
    sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = (k) => $(`[name="${k}"]`, f).value;
      const body = { kind: d.kind, name: v('name'), cwd: v('cwd'), cron: v('cron'), branch: v('branch'), label: v('label') || 'wisp', every: Number(v('every')), recipeId: v('recipeId'), prompt: v('recipeId') ? '' : v('prompt'), mode: v('mode'), agent: d.agent || '', model: d.model || '', effort: d.effort || '' };
      try {
        await api(d.id ? `/triggers/${d.id}` : '/triggers', { method: d.id ? 'PATCH' : 'POST', body });
        editing = null;
        tab = 'triggers';
        render();
      } catch (err) {
        toast(esc(err.message), { tone: 'bad' });
      }
    };
    return f;
  };

  node.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-act],[data-session]');
    if (!t || t.closest('.au-form') && !t.dataset.act) return;
    if (t.dataset.tab) return e.preventDefault(), (tab = t.dataset.tab), (editing = null), render();
    if (t.dataset.session) return e.preventDefault(), close(), reveal(t.dataset.session);
    const act = t.dataset.act;
    if (act === 'cancel') return (editing = null), render();
    const itemId = t.closest('.au-item')?.dataset.id;
    if (tab === 'recipes') {
      const r = recipes.find((x) => x.id === itemId);
      if (act === 'new') return (editing = { type: 'recipe', draft: { cwd: projectById(launchProject)?.path || '' } }), render();
      if (act === 'edit') return (editing = { type: 'recipe', draft: { ...r } }), render();
      if (act === 'run') return close(), runRecipe(r);
      if (act === 'schedule') return (tab = 'triggers'), (editing = { type: 'trigger', draft: { kind: 'schedule', name: r.name, recipeId: r.id, cwd: r.cwd || projectById(launchProject)?.path, mode: r.mode || undefined } }), render();
      if (act === 'delete' && confirm(`Delete the recipe “${r.name}”?`)) return api(`/recipes/${r.id}`, { method: 'DELETE' }).then(render);
    } else {
      const tr = triggers.find((x) => x.id === itemId);
      if (act === 'new') return (editing = { type: 'trigger', draft: {} }), render();
      if (act === 'edit') return (editing = { type: 'trigger', draft: { ...tr } }), render();
      if (act === 'toggle') return api(`/triggers/${tr.id}`, { method: 'PATCH', body: { enabled: !tr.enabled } }).then(render).catch((err) => toast(esc(err.message), { tone: 'bad' }));
      if (act === 'delete' && confirm(`Delete the trigger “${tr.name}”?`)) return api(`/triggers/${tr.id}`, { method: 'DELETE' }).then(render);
      if (act === 'fire') {
        t.disabled = true;
        try {
          const r = await api(`/triggers/${tr.id}/run`, { method: 'POST', body: {} });
          for (const x of r.started) S.sessions.set(x.id, x);
          renderFeed();
          toast(r.started.length ? `Started ${r.started.length} session${r.started.length > 1 ? 's' : ''}` : 'Nothing new to act on.');
        } catch (err) {
          toast(esc(err.message), { tone: 'bad' });
        }
        render();
      }
    }
  });
  node.refresh = () => !editing && render();
  render();
}

// Run a recipe: show it, ask for its fields (and a project, if it isn't tied to one), launch on Run.
function runRecipe(r) {
  if (!r) return;
  const needsProject = !r.cwd;
  const node = el(`
    <form class="modal run-modal">
      <header><h2>${esc(r.name)}</h2><button type="button" class="icon-btn close">${icon('x')}</button></header>
      <p class="cmp-prompt">${esc(r.prompt)}</p>
      ${r.params.map((p) => `<label class="ship-field"><span>${esc(p)}</span><input class="input" name="p:${esc(p)}" spellcheck="false" required></label>`).join('')}
      ${needsProject ? `<label class="ship-field"><span>Project</span><select name="cwd">${projectOptions(projectById(launchProject)?.path)}</select></label>` : ''}
      <div class="ship-foot"><span class="muted xs">${r.agent ? `${esc(agentName(r.agent))}${r.model ? ` · ${esc(r.model)}` : ''}` : 'Launcher harness'} · ${esc(MODES.find((m) => m.id === r.mode)?.label || 'launcher mode')}</span><button class="primary sm">${icon('enter')}Run</button></div>
    </form>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  node.onsubmit = async (e) => {
    e.preventDefault();
    const params = Object.fromEntries($$('input[name^="p:"]', node).map((i) => [i.name.slice(2), i.value]));
    const d = S.config.defaults;
    const agent = r.agent || d.agent;
    try {
      const s = await api(`/recipes/${r.id}/run`, {
        method: 'POST',
        body: { params, cwd: needsProject ? $('[name="cwd"]', node).value : undefined, agent, model: r.agent ? undefined : savedModel(agent), effort: r.agent ? undefined : savedEffort(agent, savedModel(agent)), mode: r.mode || d.mode },
      });
      S.sessions.set(s.id, s);
      close();
      renderFeed();
      setFocus(s.id);
      toast(`Running “${esc(r.name)}”`);
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    }
  };
  // Always wait for Run, even with nothing to fill in, so a click on a recipe never launches it outright.
  requestAnimationFrame(() => ($('input, select', node) || $('button.primary', node))?.focus());
}

// A task worth repeating becomes a recipe, starting from its first prompt.
async function saveAsRecipe(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  if (!s?.turns?.[0]) return;
  openAutomations({ tab: 'recipes', edit: { type: 'recipe', draft: { name: s.title, prompt: s.turns[0].prompt, cwd: '', mode: s.mode, agent: s.agent, model: s.model, effort: s.effort } } });
}

// --- usage: spend and outcomes --------------------------------------------------------------------

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${(v || 0).toFixed(2)}`);
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

async function openUsage({ days = 30, host } = {}) {
  const node = el(`<div class="modal usage-modal">
      <header><h2>Usage</h2><div class="mem-tabs us-range">${[7, 30, 90].map((d) => `<button data-days="${d}">${d} days</button>`).join('')}</div><button class="icon-btn close">${icon('x')}</button></header>
      <div class="us-body"><div class="it-loading"><span class="orb tiny"></span>Adding it up…</div></div>
    </div>`);
  const close = present(node, host);
  const render = async () => {
    $$('.us-range button', node).forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === days));
    const u = await api(`/usage?days=${days}`).catch((err) => (toast(esc(err.message), { tone: 'bad' }), null));
    if (!u || !node.isConnected) return;
    const t = u.total;
    const unpriced = t.turns - t.priced;
    // Cost when any harness reports it, else turns: one measure per chart, never two axes.
    const byCost = t.priced > 0;
    const val = (d) => (byCost ? d.cost : d.turns);
    const max = Math.max(...u.daily.map(val), 0) || 1;
    const fmtDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const table = (rows, label) =>
      rows.length
        ? `<table class="us-table"><thead><tr><th></th><th>Spend</th><th>Turns</th><th>Worked</th><th>Asked</th><th>Avg time</th></tr></thead><tbody>${rows
            .map((r) => `<tr><td>${label(r)}</td><td>${r.priced ? money(r.cost) : '—'}</td><td>${r.turns}</td><td>${pct(r.successRate)}</td><td>${r.questions}</td><td>${fmtDuration(r.avgMs)}</td></tr>`)
            .join('')}</tbody></table>`
        : '<p class="mem-empty">Nothing in this range.</p>';
    $('.us-body', node).innerHTML = `
      <div class="us-tiles">
        <div><span>Spend</span><b>${byCost ? money(t.cost) : '—'}</b><small>${unpriced ? `${unpriced} turn${unpriced > 1 ? 's' : ''} without a price` : 'all turns priced'}</small></div>
        <div><span>Turns</span><b>${t.turns}</b><small>in ${t.sessions} session${t.sessions === 1 ? '' : 's'}</small></div>
        <div><span>Worked</span><b>${pct(t.successRate)}</b><small>finished, not partial or blocked</small></div>
        <div><span>Questions</span><b>${t.questions}</b><small>times an agent needed you</small></div>
      </div>
      <h4>${byCost ? 'Spend per day' : 'Turns per day'}</h4>
      <div class="us-chart" role="img" aria-label="${byCost ? 'Spend' : 'Turns'} per day">${u.daily
        .map((d) => `<div class="us-bar" data-tip="${esc(fmtDay(d.date))}: ${byCost ? money(d.cost) : ''}${byCost ? ' · ' : ''}${d.turns} turn${d.turns === 1 ? '' : 's'}"><i style="height:${val(d) ? Math.max(2, (val(d) / max) * 100) : 0}%"></i></div>`)
        .join('')}</div>
      <div class="us-axis"><span>${esc(fmtDay(u.daily[0].date))}</span><span>${byCost ? `max ${money(max)}/day` : `max ${max}/day`}</span><span>today</span></div>
      <h4>By project</h4>${table(u.projects, (r) => `<span class="us-proj c-${esc(r.color)}"><i class="p-dot"></i>${esc(r.name)}</span>`)}
      <h4>By harness · model</h4>${table(u.runners, (r) => `<span class="us-runner"><span class="model-logo">${harnessLogo(r.agent)}</span>${esc(agentName(r.agent))} · ${esc(r.model || 'default')}</span>`)}
      ${unpriced ? '<p class="hint">Codex, Cursor and Antigravity report tokens but not cost, so their turns count in turns and outcomes but not in spend.</p>' : ''}`;
  };
  // One floating tooltip for the bars (they are too thin to label).
  const tip = el('<div class="us-tip" hidden></div>');
  node.append(tip);
  node.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.us-bar');
    tip.hidden = !b;
    if (!b) return;
    tip.textContent = b.dataset.tip;
    const r = b.getBoundingClientRect();
    const m = node.getBoundingClientRect();
    tip.style.left = `${Math.min(r.left - m.left + r.width / 2, m.width - 90)}px`;
    tip.style.top = `${r.top - m.top + node.scrollTop - 6}px`;
  });
  node.addEventListener('mouseleave', () => (tip.hidden = true));
  $('.us-range', node).onclick = (e) => {
    const d = Number(e.target.closest('[data-days]')?.dataset.days);
    if (d) (days = d), render();
  };
  render();
}

function usageSummary(u) {
  if (!u) return '';
  return u.total.turns ? `${u.total.priced ? `${money(u.total.cost)} · ` : ''}${u.total.turns} turns · ${pct(u.total.successRate)} worked, last 7 days` : 'Nothing in the last 7 days';
}

// --- phone: ntfy / Telegram -----------------------------------------------------------------------

function phoneSummary(r) {
  if (!r) return '';
  const on = [r.ntfy.enabled && r.ntfy.topic && 'ntfy', r.telegram.enabled && r.telegram.linked && 'Telegram'].filter(Boolean);
  return on.length ? `${on.join(' + ')} · ${r.events.map((e) => (e === 'waiting' ? 'questions' : 'finished')).join(' & ')}` : 'Off';
}

async function openPhone({ host } = {}) {
  const node = el(`<div class="modal phone-modal">
      <header><h2>Phone</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="mem-lede">Get questions and finished tasks on your phone, and answer from there. wisp polls both services, so nothing needs to reach this machine. They receive titles, summaries and questions (with their context), never code or diffs.</p>
      <div class="ph-body"></div>
    </div>`);
  const close = present(node, host);
  let r;
  const put = async (patch) => {
    try {
      r = await api('/remote', { method: 'PUT', body: patch });
      paint();
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    }
  };
  const status = (st) => (!st ? '' : st.ok ? `<span class="ph-ok">${icon('check')}Working</span>` : `<span class="ph-bad">${icon('warn')}${esc(st.error || 'Failed')}</span>`);
  const paint = () => {
    const tg = r.telegram;
    $('.ph-body', node).innerHTML = `
      <div class="settings-modal ph-sec">
        <div class="setting"><span>Send me</span>
          <label class="check"><input type="checkbox" data-ev="waiting" ${r.events.includes('waiting') ? 'checked' : ''}> Questions</label>
          <label class="check"><input type="checkbox" data-ev="finished" ${r.events.includes('finished') ? 'checked' : ''}> Finished tasks</label></div>
      </div>
      <section class="ph-sec">
        <h4>ntfy <span class="muted xs">· tap a button on the notification to answer</span>${status(r.status.ntfy)}<button class="switch" data-sw="ntfy" role="switch" aria-checked="${r.ntfy.enabled}"></button></h4>
        <div class="settings-modal">
          <label><span>Topic</span><input class="input mono" data-ntfy="topic" value="${esc(r.ntfy.topic)}" placeholder="wisp-…" spellcheck="false"></label>
          <label><span>Server</span><input class="input mono" data-ntfy="server" value="${esc(r.ntfy.server)}" spellcheck="false"></label>
          <label><span>Access token</span><input class="input mono" data-ntfy="token" value="${esc(r.ntfy.token)}" placeholder="Only for protected topics" spellcheck="false" type="password"></label>
        </div>
        <p class="hint">Install the ntfy app and subscribe to the topic. Anyone who knows the topic name can read it, so keep it long and random; answers are signed, so nobody else can send them.</p>
      </section>
      <section class="ph-sec">
        <h4>Telegram <span class="muted xs">· buttons, or reply to a message in your own words</span>${status(r.status.telegram)}<button class="switch" data-sw="telegram" role="switch" aria-checked="${tg.enabled}"></button></h4>
        <div class="settings-modal">
          <label><span>Bot token</span><input class="input mono" data-tg="token" value="${esc(tg.token)}" placeholder="123456:ABC… from @BotFather" spellcheck="false" type="password"></label>
        </div>
        <p class="hint">${
          tg.linked
            ? `${icon('check')} Linked to <b>${esc(tg.chatName || 'your chat')}</b>. <button class="link xs" data-act="unlink">Unlink</button>`
            : tg.token && tg.enabled
              ? `Now send <code>/link ${esc(tg.linkCode)}</code> to your bot. Only the chat that sends this code gets linked.`
              : 'Create a bot with @BotFather, paste its token here and switch Telegram on.'
        }</p>
      </section>
      <div class="ship-foot"><span class="grow"></span><button class="ghost sm" data-act="test">${icon('send')}Send a test</button></div>`;
  };
  node.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ev) put({ events: $$('[data-ev]', node).filter((x) => x.checked).map((x) => x.dataset.ev) });
    if (t.dataset.ntfy) put({ ntfy: { ...r.ntfy, [t.dataset.ntfy]: t.value.trim() } });
    if (t.dataset.tg) put({ telegram: { enabled: r.telegram.enabled, token: t.value.trim() } });
  });
  node.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-sw]')?.dataset.sw;
    if (sw === 'ntfy') {
      // A fresh random topic the first time, so it isn't guessable.
      const topic = r.ntfy.topic || `wisp-${crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 14)}`;
      return put({ ntfy: { ...r.ntfy, enabled: !r.ntfy.enabled, topic } });
    }
    if (sw === 'telegram') return put({ telegram: { enabled: !r.telegram.enabled, token: r.telegram.token } });
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'unlink') return put({ telegram: { enabled: r.telegram.enabled, token: r.telegram.token, unlink: true } });
    if (act === 'test') {
      try {
        r = await api('/remote/test', { method: 'POST', body: {} });
        paint();
        toast('Test sent');
      } catch (err) {
        toast(esc(err.message), { tone: 'bad' });
      }
    }
  });
  node.refresh = async () => {
    if (node.contains(document.activeElement) && document.activeElement.matches('input')) return; // don't clobber typing
    r = await api('/remote').catch(() => r);
    if (r && node.isConnected) paint();
  };
  r = await api('/remote').catch((err) => (toast(esc(err.message), { tone: 'bad' }), null));
  if (r) paint();
}

// --- machines: other computers, over SSH ---------------------------------------------------------

// A machine runs its own wisp; this one signs in over SSH, tunnels to it and shows its sessions
// as <id>@<machine>. Projects can live on a machine; launching in one runs the agent there.
const machineById = (id) => S.machines.find((m) => m.id === id);
const machineOnline = (id) => machineById(id)?.state === 'online';
const MACHINE_STATE = { online: 'Online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Couldn’t connect', off: 'Not connected' };
const projectTitle = (p) => {
  if (!p) return '';
  const m = p.machine && machineById(p.machine);
  return m ? `${p.path} on ${m.name}${m.state === 'online' ? '' : ' (not connected)'}` : p.path;
};

function machinePill(mt) {
  const on = machineOnline(mt.id);
  return `<span class="q-machine ${on ? '' : 'off'}" title="Runs on ${esc(mt.name)} (${esc(mt.target)})${on ? '' : ' · not connected'}">${icon('server')}<span>${esc(mt.name)}</span></span>`;
}

function machinesSummary() {
  const n = S.machines.length;
  if (!n) return 'None yet · run agents on another computer over SSH';
  const on = S.machines.filter((m) => m.state === 'online').length;
  return `${n} machine${n === 1 ? '' : 's'} · ${on ? `${on} online` : 'none online'}`;
}

const loadMachines = () => api('/machines').then(setMachines).catch(() => {});
function setMachines(list) {
  const was = new Map(S.machines.map((m) => [m.id, m.state === 'online']));
  S.machines = list;
  paintMachinesBtn();
  renderLaunchChips();
  renderProjects();
  $('.machines-modal')?.refresh();
  $('.projects-modal')?.refresh?.();
  $('.menu.where-menu')?.refresh();
  $('.settings-modal .machines-hint') && ($('.settings-modal .machines-hint').textContent = machinesSummary());
  // Coming online lists its sessions; going offline greys their cards.
  if (list.some((m) => (was.get(m.id) || false) !== (m.state === 'online'))) loadSessions();
}

function paintMachinesBtn() {
  const b = $('#machinesBtn');
  if (!b) return;
  const on = S.machines.filter((m) => m.state === 'online').length;
  const trouble = S.machines.some((m) => m.state === 'error' || m.state === 'reconnecting');
  b.classList.toggle('live', on > 0);
  b.classList.toggle('trouble', trouble);
  const n = $('.ab-n', b);
  n.hidden = !on;
  n.textContent = on;
  b.title = S.machines.length ? `Machines: ${machinesSummary()}` : 'Machines: run agents on another computer over SSH';
}

async function connectMachine(id) {
  try {
    await api(`/machines/${id}/connect`, { method: 'POST', body: {} });
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

function offlineToast(id) {
  const m = machineById(id);
  if (m?.state === 'connecting' || m?.state === 'reconnecting') return toast(`Still connecting to <b>${esc(m.name)}</b>…`);
  toast(`<b>${esc(m?.name || 'That machine')}</b> isn’t connected`, { tone: 'bad', action: { label: 'Connect', run: () => connectMachine(id) } });
}

const STEP_ICON = { done: 'check', fail: 'x', warn: 'warn', run: '', pending: '' };

function openMachines({ host, focusAdd = false } = {}) {
  const node = el(`<div class="modal machines-modal">
      <header><h2>Machines</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="mc-body">
        <p class="mem-lede">Run agents on your other computers: a dev box, a GPU server, a cloud VM. wisp signs in over SSH, starts itself there and tunnels back, so worktrees, diffs and Ship it work as usual, and agents keep going when this computer sleeps.</p>
        <div class="mc-list"></div>
        <section class="mc-add"></section>
      </div>
    </div>`);
  const close = present(node, host);
  const body = $('.mc-body', node);
  let editing = null; // machine id whose form is open, '' = a new one, null = closed
  let hosts = []; // found on this computer: ~/.ssh/config, Tailscale peers, ~/.ssh/known_hosts
  api('/machines/discover')
    .then((h) => {
      hosts = h;
      const slot = $('.mc-found-slot', node);
      if (slot) slot.innerHTML = found();
      const dl = $('#sshHosts', node);
      if (dl) dl.innerHTML = datalist();
    })
    .catch(() => {});
  const datalist = () => hosts.map((x) => `<option value="${esc(x.target)}">${esc(x.detail || '')}</option>`).join('');
  const SOURCE = { 'ssh-config': '~/.ssh/config', tailscale: 'Tailscale', 'known-hosts': 'You’ve SSHed here before' };
  // Hosts not added yet, one click from a filled-in form.
  const found = () => {
    const added = new Set(S.machines.map((m) => m.target));
    const list = hosts.filter((x) => !added.has(x.target));
    if (!list.length) return '';
    return `<div class="mc-found"><h4>Found on this computer</h4><div class="mc-found-list">${list
      .slice(0, 12)
      .map(
        (x) =>
          `<button type="button" class="lp-chip${x.online === false ? ' off' : ''}" data-a="pick" data-target="${esc(x.target)}" data-name="${esc(x.name)}" title="${esc([SOURCE[x.source], x.target, x.detail].filter(Boolean).join(' · '))}">${icon('server')}${esc(x.name)}${x.online !== undefined ? `<i class="mc-fdot"></i>` : ''}</button>`,
      )
      .join('')}</div></div>`;
  };

  // Projects on a machine open here, with a way back.
  const sub = (view) => {
    const head = $(':scope > header', node);
    body.hidden = true;
    head.hidden = true;
    view.classList.add('embedded');
    const back = el(`<button class="ghost sm sx-back">${icon('back')}Back</button>`);
    back.onclick = () => {
      view.remove();
      body.hidden = false;
      head.hidden = false;
      paint();
    };
    $('header', view).prepend(back);
    $('.close', view).onclick = close;
    node.append(view);
    return close;
  };

  const steps = (m) => `<ol class="mc-steps">${m.steps
    .map((st) => `<li class="s-${st.status}"><span class="mc-si">${STEP_ICON[st.status] ? icon(STEP_ICON[st.status]) : ''}</span><b>${esc(st.label)}</b>${st.detail ? `<small>${esc(st.detail)}</small>` : ''}</li>`)
    .join('')}</ol>`;
  const trouble = (m) => `<div class="mc-hint ${m.state === 'reconnecting' ? 'soft' : ''}">
      <p><b>${esc(m.state === 'reconnecting' ? `${m.error || 'Connection lost.'} Trying again${m.attempt > 1 ? ` (attempt ${m.attempt})` : ''}…` : m.error)}</b></p>
      ${m.hint?.text ? `<p>${esc(m.hint.text)}</p>` : ''}
      ${m.hint?.command ? `<div class="mc-cmd"><code>${esc(m.hint.command)}</code><button class="ghost xs" data-a="copy" data-cmd="${esc(m.hint.command)}" title="Copy">${icon('copy')}</button></div>` : ''}
      ${m.stale ? `<button class="ghost sm" data-a="restart">${icon('rerun')}Restart wisp there</button>` : ''}
      ${m.log.length ? `<details class="mc-log"><summary>Log</summary><pre>${esc(m.log.join('\n'))}</pre></details>` : ''}
    </div>`;
  const projects = (m) => {
    const list = S.config.projects.filter((p) => p.machine === m.id);
    return `<div class="mc-projects">${list.map((p) => `<span class="lp-chip c-${p.color}" title="${esc(p.path)}"><i class="p-dot"></i>${esc(p.name)}</span>`).join('')}
      <button class="lp-chip add" data-a="projects">${icon(list.length ? 'plus' : 'folder')}${list.length ? 'Add' : 'Pick projects on it…'}</button></div>`;
  };
  const card = (m) => {
    const st = m.state;
    const busy = st === 'connecting' || st === 'reconnecting';
    const ready = (m.remote?.agents || []).filter((a) => a.available);
    return `<div class="mc st-${st}" data-id="${m.id}">
      <div class="mc-head">
        <span class="mc-icon">${icon('server')}<i class="mc-dot"></i></span>
        <div class="mc-title"><b>${esc(m.name)}</b><span>${esc(m.target)}${m.port !== 4477 ? ` · port ${m.port}` : ''}</span></div>
        <span class="mc-state">${MACHINE_STATE[st] || st}</span>
        ${st === 'online' || busy ? `<button class="ghost sm" data-a="disconnect">${busy ? 'Cancel' : 'Disconnect'}</button>` : `<button class="primary sm" data-a="connect">${st === 'error' ? 'Try again' : 'Connect'}</button>`}
        <button class="icon-btn" data-a="menu" title="More">${icon('dots')}</button>
      </div>
      ${
        st === 'online'
          ? `<div class="mc-meta"><span>wisp ${esc(m.remote?.version || '')}</span>${ready.length ? `<span class="mc-agents">${ready.map((a) => `<span class="model-logo" title="${esc(a.name)} ${esc(a.version || '')}">${harnessLogo(a.id)}</span>`).join('')}</span>` : '<span class="bad">no harnesses found</span>'}${m.working ? `<span>${m.working} working</span>` : ''}</div>`
          : ''
      }
      ${busy || st === 'error' ? steps(m) : ''}
      ${(st === 'error' || st === 'reconnecting') && m.error ? trouble(m) : ''}
      ${st === 'online' || m.projects ? projects(m) : ''}
      ${editing === m.id ? `<div class="mc-edit">${form(m)}</div>` : ''}
    </div>`;
  };
  const form = (m) => `<form class="mc-form" data-id="${m?.id || ''}">
      <div class="mc-row">
        <label class="mc-field grow"><span>SSH host</span><input class="input mono" name="target" list="sshHosts" placeholder="me@devbox, 10.0.0.5, or a Host from ~/.ssh/config" spellcheck="false" autocomplete="off" autocapitalize="off" value="${esc(m?.target || '')}" required></label>
        <label class="mc-field"><span>Name</span><input class="input" name="name" placeholder="${esc(m?.name || 'devbox')}" value="${esc(m?.name || '')}" spellcheck="false"></label>
      </div>
      <details class="mc-adv" ${m && (m.port !== 4477 || m.command) ? 'open' : ''}><summary>Advanced</summary>
        <div class="mc-row">
          <label class="mc-field"><span>wisp’s port there</span><input class="input mono" name="port" type="number" min="1" max="65535" value="${m?.port || 4477}"></label>
          <label class="mc-field grow"><span>Start command</span><input class="input mono" name="command" placeholder="${esc(S.machines[0]?.defaultCommand || 'npx -y wisp-agents@<this version>')}" value="${esc(m?.command || '')}" spellcheck="false"></label>
        </div>
        <label class="check mc-check"><input type="checkbox" name="autoConnect" ${m?.autoConnect === false ? '' : 'checked'}> Connect when wisp starts</label>
      </details>
      <div class="mc-foot">
        <p class="hint">${m ? 'Changing the host, port or command reconnects.' : 'Uses your SSH keys, agent and ~/.ssh/config; wisp never asks for a password. The machine needs Node.js 20+ and the harness CLIs, signed in.'}</p>
        ${editing !== null && (m || S.machines.length) ? '<button type="button" class="ghost sm" data-a="cancel">Cancel</button>' : ''}
        <button class="primary sm" type="submit">${m ? 'Save' : `${icon('server')}Connect`}</button>
      </div>
    </form>`;

  const paint = () => {
    if (!node.isConnected && !host) return;
    $('.mc-list', node).innerHTML = S.machines.map(card).join('');
    const add = $('.mc-add', node);
    // The form for a new machine: open when there are none yet, else behind a button.
    if (!S.machines.length || editing === '') {
      // Keep a half-filled form; only the suggestions above it change.
      if ($('form[data-id=""]', add)) $('.mc-found-slot', add).innerHTML = found();
      else add.innerHTML = `<div class="mc-found-slot">${found()}</div><h4>${S.machines.length ? 'Add another machine' : 'Add your first machine'}</h4>${form(null)}<datalist id="sshHosts">${datalist()}</datalist>`;
    } else add.innerHTML = `<div class="mc-found-slot">${found()}</div><button class="lp-chip add mc-new" data-a="new">${icon('plus')}Add a machine</button><datalist id="sshHosts">${datalist()}</datalist>`;
  };

  const menu = (m, anchor) => {
    $('.menu.machine')?.close();
    const r = anchor.getBoundingClientRect();
    const box = el(`<div class="menu machine" style="top:${r.bottom + 4}px;left:${Math.max(8, r.right - 230)}px">
        <button data-m="edit">${icon('pen')}Edit…</button>
        <button data-m="projects">${icon('folder')}Projects on it…</button>
        ${m.state === 'online' ? `<button data-m="restart">${icon('rerun')}Restart wisp there</button><button data-m="stop" class="danger">${icon('stop')}Stop wisp there</button>` : ''}
        <button data-m="remove" class="danger">${icon('trash')}Remove machine</button>
      </div>`);
    const shut = () => (box.remove(), document.removeEventListener('mousedown', outside));
    const outside = (ev) => {
      if (!box.contains(ev.target)) shut();
    };
    box.close = shut;
    setTimeout(() => document.addEventListener('mousedown', outside));
    box.onclick = (ev) => {
      const a = ev.target.closest('button')?.dataset.m;
      shut();
      if (a) act(a, m);
    };
    document.body.append(box);
  };

  const act = async (a, m) => {
    try {
      if (a === 'connect') await api(`/machines/${m.id}/connect`, { method: 'POST', body: {} });
      if (a === 'disconnect') await api(`/machines/${m.id}/disconnect`, { method: 'POST', body: {} });
      if (a === 'projects') openProjects({ machine: m.id, host: sub, focusAdd: true });
      if (a === 'edit') {
        editing = m.id;
        paint();
        $(`.mc[data-id="${m.id}"] input[name="target"]`, node)?.focus();
      }
      if (a === 'restart') {
        if (m.working && !confirm(`${m.working} agent${m.working === 1 ? ' is' : 's are'} working on ${m.name}. Restarting wisp there stops ${m.working === 1 ? 'it' : 'them'}. Restart?`)) return;
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: { restart: true } });
      }
      if (a === 'stop') {
        if (!confirm(`Stop wisp on ${m.name}? ${m.working ? `${m.working} working agent${m.working === 1 ? '' : 's'} stop too. ` : ''}Its sessions stay there for next time.`)) return;
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: {} });
        toast(`Stopped wisp on <b>${esc(m.name)}</b>`);
      }
      if (a === 'remove') {
        if (!confirm(`Remove ${m.name} from wisp? Its projects leave the launcher. Nothing on the machine is touched, and wisp keeps running there until you stop it.`)) return;
        await api(`/machines/${m.id}`, { method: 'DELETE' });
        await loadConfig();
        await loadMachines();
      }
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    }
  };

  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || !body.contains(b)) return;
    const a = b.dataset.a;
    const m = machineById(b.closest('.mc')?.dataset.id);
    if (a === 'copy') {
      copy(b.dataset.cmd);
      toast('Copied. Run it in a terminal, then connect again.');
      return;
    }
    if (a === 'new') {
      editing = '';
      paint();
      $('.mc-add input[name="target"]', node)?.focus();
      return;
    }
    if (a === 'pick') {
      // Fill in the form; connecting still waits for the button.
      editing = '';
      paint();
      const f = $('.mc-add form[data-id=""]', node);
      f.target.value = b.dataset.target;
      f.name.value = b.dataset.name;
      $('button[type="submit"]', f).focus();
      return;
    }
    if (a === 'cancel') {
      editing = null;
      paint();
      return;
    }
    if (a === 'menu' && m) {
      menu(m, b);
      return;
    }
    if (m) act(a, m);
  });
  // The name follows the host until you type one.
  node.addEventListener('input', (e) => {
    if (e.target.name !== 'target') return;
    const name = $('input[name="name"]', e.target.form);
    const h = hosts.find((x) => x.target === e.target.value.trim());
    name.placeholder = (h?.name || e.target.value.trim().replace(/^.*@/, '')).slice(0, 40) || 'devbox';
  });
  node.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.dataset.id;
    const v = Object.fromEntries(new FormData(f));
    const payload = { target: v.target.trim(), name: v.name.trim(), port: Number(v.port) || 4477, command: v.command.trim(), autoConnect: !!v.autoConnect };
    const btn = $('button[type="submit"]', f);
    btn.disabled = true;
    try {
      if (id) await api(`/machines/${id}`, { method: 'PATCH', body: payload });
      else await api('/machines', { method: 'POST', body: payload });
      editing = null;
      await loadMachines();
      paint();
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    } finally {
      btn.disabled = false;
    }
  });
  node.refresh = () => {
    // Don't clobber a half-typed form: repaint the cards only.
    const typing = node.contains(document.activeElement) && document.activeElement.matches('input, select');
    if (typing && editing !== null && editing !== '') return;
    if (typing) $('.mc-list', node).innerHTML = S.machines.map(card).join('');
    else paint();
  };
  paint();
  if (focusAdd && S.machines.length) {
    editing = '';
    paint();
  }
  if (focusAdd || !S.machines.length) setTimeout(() => $('.mc-add input[name="target"]', node)?.focus(), 60);
}

// --- settings -----------------------------------------------------------------------------

// A sidebar of sections and one pane at a time, like every other app's settings. Big lists
// (memory, automations, usage history) keep their own views; a pane only summarises and links.
const SETTINGS_PANES = [
  { id: 'general', label: 'General', icon: 'settings', lede: 'Where files open, where you take over, and how tasks start.' },
  { id: 'notifications', label: 'Notifications', icon: 'bolt', lede: 'Hear about questions and finished tasks, here or on your phone.' },
  { id: 'agents', label: 'Agents', icon: 'agent', lede: 'The harnesses wisp found on this machine. Pick one next to the model in the launcher.' },
  { id: 'machines', label: 'Machines', icon: 'server', lede: 'Other computers that run agents for you, over SSH.' },
  { id: 'memory', label: 'Memory', icon: 'spark', lede: "Learned from your sessions and added to every agent's prompt. What you ask always wins." },
  { id: 'automations', label: 'Automations', icon: 'play', lede: 'Saved prompts, and the triggers that launch them for you.' },
  { id: 'usage', label: 'Usage', icon: 'stats', lede: 'Spend and outcomes over the last 7 days.' },
  { id: 'privacy', label: 'Privacy', icon: 'info', lede: 'What wisp sends about itself. Never prompts, paths or code.' },
];
let settingsPane = 'general';

function openSettings(opts) {
  if (SETTINGS_PANES.some((p) => p.id === opts?.pane)) settingsPane = opts.pane;
  const d = S.config.defaults;
  // A row: name and a line of explanation on the left, the control on the right.
  const row = (name, desc, control, cls = '') => `<div class="sx-row ${cls}"><div class="sx-text"><b>${name}</b>${desc ? `<small>${desc}</small>` : ''}</div><div class="sx-ctl">${control}</div></div>`;
  const missing = S.agents.filter((a) => !a.available).length;
  const node = el(`
    <div class="modal settings-modal sx">
      <nav class="sx-nav" role="tablist" aria-orientation="vertical">
        <h2>Settings</h2>
        ${SETTINGS_PANES.map((p) => `<button role="tab" data-pane="${p.id}">${icon(p.icon)}<span>${p.label}</span>${p.id === 'agents' && missing ? `<i class="dot bad" title="${missing} not found"></i>` : ''}</button>`).join('')}
      </nav>
      <div class="sx-main">
        <header><div><h3 class="sx-title"></h3><p class="sx-lede"></p></div><button class="icon-btn close">${icon('x')}</button></header>
        <section class="sx-pane" data-pane="general">
          <div class="sx-group">
            ${row('Open files in', 'File links in cards and diffs', `<select name="editor">${[['vscode', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'], ['idea', 'JetBrains'], ['none', 'Copy path']]
              .map(([v, l]) => `<option value="${v}" ${d.editor === v || (!d.editor && v === 'vscode') ? 'selected' : ''}>${l}</option>`)
              .join('')}</select>`)}
            ${row('Take over in', 'The terminal a session opens in when you take it over', `<select name="terminal">${(S.config.terminals || []).map((t) => `<option value="${t.id}" ${(d.terminal || 'auto') === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`)}
            <div class="sx-row custom-term" ${d.terminal === 'custom' ? '' : 'hidden'}><div class="sx-text"><b>Terminal command</b><small><code>{cwd}</code> and <code>{cmd}</code> are filled in</small></div>
              <div class="sx-ctl"><input class="input mono" name="terminalCommand" value="${esc(d.terminalCommand || '')}" placeholder="alacritty --working-directory {cwd} -e {cmd}" spellcheck="false"></div></div>
          </div>
          <div class="sx-group">
            ${row('Worktree per task', 'Each task gets its own branch from origin/main, in git repos', '<button class="switch" id="wtDefault" role="switch"></button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="notifications">
          <div class="sx-group">
            ${row('Desktop notifications', '<span class="notif-hint"></span>', '<button class="switch" id="notif" role="switch"></button>')}
          </div>
          <div class="sx-group">
            ${row('Phone', '<span class="phone-hint">ntfy or Telegram: answer questions from your phone</span>', '<button class="ghost sm" id="openPhone">Set up</button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="agents">
          <div class="sx-group">${S.agents
            .map((a) => row(`<span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}`, esc(a.available ? a.version : a.error || 'not found'), `<span class="sx-state ${a.available ? 'ok' : 'bad'}"><i class="dot ${a.available ? 'ok' : 'bad'}"></i>${a.available ? 'Ready' : 'Not found'}</span>`))
            .join('')}</div>
        </section>
        <section class="sx-pane" data-pane="machines">
          <div class="sx-group">
            ${row('Machines', '<span class="machines-hint"></span>', '<button class="ghost sm" id="openMachines">Manage</button>')}
          </div>
          <p class="hint">Also in the top bar, and in Projects: add folders on a machine, then launch there like anywhere else.</p>
        </section>
        <section class="sx-pane" data-pane="memory">
          <div class="sx-group">
            ${row('Learn from sessions', 'A short retro after each session keeps preferences and lessons', '<button class="switch" id="learn" role="switch"></button>')}
            ${row('Remembered', '<span class="learn-hint"></span>', '<button class="ghost sm" id="openMemory">Open memory</button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="automations">
          <div class="sx-group">
            ${row('Recipes', '<span class="recipe-hint"></span>', '<button class="ghost sm" data-auto="recipes">Manage</button>')}
            ${row('Triggers', '<span class="trigger-hint"></span>', '<button class="ghost sm" data-auto="triggers">Manage</button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="usage">
          <div class="us-tiles sx-usage"><div class="it-loading"><span class="orb tiny"></span>Adding it up…</div></div>
          <div class="sx-group">${row('Charts and breakdowns', 'Per day, per project and per harness · model', '<button class="ghost sm" id="openUsage">Open usage</button>')}</div>
        </section>
        <section class="sx-pane" data-pane="privacy">
          <div class="sx-group">
            ${row('Anonymous usage stats', '<span class="tele-hint"></span>', '<button class="switch" id="tele" role="switch"></button>')}
          </div>
          <p class="hint">Agent, model, status, timings and scrubbed errors only.</p>
        </section>
      </div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const pick = (id, focus = false) => {
    settingsPane = id;
    const p = SETTINGS_PANES.find((x) => x.id === id);
    $$('.sx-nav [data-pane]', node).forEach((b) => {
      const on = b.dataset.pane === id;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    $$('.sx-pane', node).forEach((s) => (s.hidden = s.dataset.pane !== id));
    $('.sx-title', node).textContent = p.label;
    $('.sx-lede', node).textContent = p.lede;
    $('.sx-main', node).scrollTop = 0;
  };
  // Memory, Automations, Usage and Phone open in the main area, next to the sidebar, with a
  // way back to the section they came from. Leaving one goes back; only the X closes Settings.
  const main = $('.sx-main', node);
  const leave = () => {
    const v = $('.sx-main > .embedded', node);
    if (!v) return;
    v.remove();
    $('.sx-main > header', node).hidden = false;
    paintHints();
  };
  const show = (id, focus) => (leave(), pick(id, focus));
  const host = (pane) => (view) => {
    show(pane);
    view.classList.add('embedded');
    const back = el(`<button class="ghost sm sx-back">${icon('back')}Back</button>`);
    back.onclick = () => show(pane);
    $('header', view).prepend(back);
    $('.close', view).onclick = close;
    $('.sx-main > header', node).hidden = true;
    $$('.sx-pane', node).forEach((s) => (s.hidden = true));
    main.append(view);
    main.scrollTop = 0;
    return close;
  };
  $('.sx-nav', node).onclick = (e) => {
    const b = e.target.closest('[data-pane]');
    if (b) show(b.dataset.pane);
  };
  $('.sx-nav', node).onkeydown = (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = SETTINGS_PANES.findIndex((p) => p.id === settingsPane);
    show(SETTINGS_PANES[(i + step + SETTINGS_PANES.length) % SETTINGS_PANES.length].id, true);
  };
  show(settingsPane);
  node.addEventListener('change', async (e) => {
    const { name, value } = e.target;
    if (!name || e.target.closest('.embedded')) return; // a nested view's own form
    if (name === 'terminal') $('.custom-term', node).hidden = value !== 'custom';
    await api('/config', { method: 'PATCH', body: { defaults: { [name]: value } } });
    await loadConfig();
  });
  // The switch shows wisp's own on/off preference; the browser permission can only be
  // granted from here, never revoked, so it surfaces as a hint when it blocks the switch.
  const sw = $('#notif', node);
  const paint = () => {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const on = notifyOn();
    sw.setAttribute('aria-checked', on);
    sw.disabled = perm === 'denied' || perm === 'unsupported';
    $('.notif-hint', node).textContent =
      perm === 'denied' ? 'Blocked — allow notifications for this site in your browser' : perm === 'unsupported' ? 'Not supported here' : on ? 'On' : 'Off';
  };
  sw.onclick = async () => {
    let want = !notifyOn();
    if (want && Notification.permission !== 'granted') want = (await Notification.requestPermission()) === 'granted';
    await api('/config', { method: 'PATCH', body: { defaults: { notify: want ? 'on' : 'off' } } });
    await loadConfig();
    paint();
  };
  paint();
  // Agent, model, status, timings and scrubbed errors only; never prompts, paths or code.
  const tele = $('#tele', node);
  const paintTele = () => {
    const t = S.config.telemetry || {};
    tele.setAttribute('aria-checked', !!t.enabled);
    tele.disabled = !t.available;
    $('.tele-hint', node).textContent = !t.available ? 'Off (DO_NOT_TRACK, WISP_TELEMETRY=0 or CI)' : 'No prompts, paths or code';
  };
  tele.onclick = async () => {
    await api('/config', { method: 'PATCH', body: { defaults: { telemetry: S.config.telemetry?.enabled ? 'off' : 'on' } } });
    await loadConfig();
    paintTele();
  };
  paintTele();
  // Memory: one line here (on/off and a summary); the lists and retros live in their own view.
  const learn = $('#learn', node);
  const paintLearn = async () => {
    learn.setAttribute('aria-checked', S.config.defaults.learn !== 'off');
    $('.learn-hint', node).textContent = memorySummary(await api('/preferences').catch(() => null));
  };
  learn.onclick = async () => {
    await setLearning(S.config.defaults.learn === 'off');
    paintLearn();
  };
  node.paintLearn = paintLearn;
  // One line each; their lists and charts live in their own views.
  const wt = $('#wtDefault', node);
  const paintWt = () => wt.setAttribute('aria-checked', S.config.defaults.worktree !== 'off');
  wt.onclick = async () => {
    await api('/config', { method: 'PATCH', body: { defaults: { worktree: S.config.defaults.worktree === 'off' ? 'on' : 'off' } } });
    await loadConfig();
    paintWt();
    renderLauncher();
  };
  paintWt();
  // The one-line summaries; painted again on the way back from a view that may have changed them.
  const paintHints = () => {
    const r = S.config.recipes?.length || 0;
    const all = S.config.triggers || [];
    const t = all.filter((x) => x.enabled).length;
    $('.recipe-hint', node).textContent = r ? `${r} saved prompt${r === 1 ? '' : 's'}` : 'None yet · save a prompt you run often';
    $('.trigger-hint', node).textContent = all.length ? `${t} of ${all.length} on` : 'None yet · run a recipe on a schedule, CI failure or new issue';
    api('/usage?days=7')
      .then((u) => {
        const x = u.total;
        $('.sx-usage', node).innerHTML = `
          <div><span>Spend</span><b>${x.priced ? money(x.cost) : '—'}</b></div>
          <div><span>Turns</span><b>${x.turns}</b></div>
          <div><span>Worked</span><b>${pct(x.successRate)}</b></div>
          <div><span>Questions</span><b>${x.questions}</b></div>`;
      })
      .catch(() => ($('.sx-usage', node).innerHTML = ''));
    $('.machines-hint', node).textContent = machinesSummary();
    api('/remote').then((x) => ($('.phone-hint', node).textContent = phoneSummary(x) === 'Off' ? 'ntfy or Telegram: answer questions from your phone' : phoneSummary(x))).catch(() => {});
    paintLearn();
  };
  paintHints();
  $('#openMemory', node).onclick = () => openMemory({ host: host('memory') });
  $$('[data-auto]', node).forEach((b) => (b.onclick = () => openAutomations({ tab: b.dataset.auto, host: host('automations') })));
  $('#openUsage', node).onclick = () => openUsage({ days: 7, host: host('usage') });
  $('#openPhone', node).onclick = () => openPhone({ host: host('notifications') });
  $('#openMachines', node).onclick = () => openMachines({ host: host('machines') });
}

// --- memory: what the background retros learned ---------------------------------------------

const MEM_KINDS = [
  { kind: 'preferences', label: 'Preferences', one: 'preference', icon: 'spark', hint: 'How you like agents to work', empty: 'Corrections and “always / never” asks from your sessions land here.' },
  { kind: 'lessons', label: 'Lessons', one: 'lesson', icon: 'check', hint: 'A mistake an agent made, and the way that worked', empty: 'When an agent hits a wall and finds the fix, the fix lands here.' },
];
const MEM_CAP = 10;
const memCount = (x) => x.preferences.length + x.lessons.length;
const projectName = (p) => S.config.projects.find((x) => x.path === p)?.name || String(p || '').split(/[\\/]/).pop();

async function setLearning(on) {
  await api('/config', { method: 'PATCH', body: { defaults: { learn: on ? 'on' : 'off' } } });
  await loadConfig();
}

function memorySummary(data) {
  if (!data) return '';
  if (!data.enabled) return 'Off · nothing learned or applied';
  const n = memCount(data.global) + data.projects.reduce((a, p) => a + memCount(p), 0);
  const last = data.history[0];
  if (data.running) return `Retro running · ${n} remembered`;
  return `${n ? `${n} remembered` : 'Nothing yet'}${last ? ` · last retro ${ago(last.at)}` : ''}`;
}

function openMemory({ tab = 'global', host } = {}) {
  const node = el(`<div class="modal memory-modal">
      <header><h2>Memory</h2><span class="mem-live"></span><button class="switch" id="memOn" role="switch" title="Learn from sessions"></button><button class="icon-btn close">${icon('x')}</button></header>
      <p class="mem-lede">Learned from your sessions and added to every agent's prompt. What you ask always wins.</p>
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
    const current = projectById(launchProject);
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
        return `<div class="mem-item" data-i="${i}"><span class="mem-ico">${icon(k.icon)}</span><div class="mem-main"><p>${esc(t)}</p>${o ? `<span class="mem-src">${o.sessionId && S.sessions.has(o.sessionId) ? `<a href="#" data-session="${esc(o.sessionId)}">${esc(o.title || 'session')}</a>` : esc(o.title || 'a session')} · ${ago(o.at)}</span>` : ''}</div>
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
    const live = data.running ? `<div class="tl running"><span class="tl-dot"><span class="orb live"></span></span><div class="tl-main"><div class="tl-head"><b>${esc(data.running.title || 'session')}</b><span class="muted xs">now</span></div><p class="muted xs">Reading ${data.running.turns} turn${data.running.turns === 1 ? '' : 's'} with ${esc(agentName(data.running.agent))}…</p></div></div>` : '';
    const where = (a) => `<span class="tl-tag">${a.scope === 'global' ? 'everywhere' : 'project'} · ${a.kind === 'lessons' ? 'lesson' : 'preference'}</span>`;
    const entries = data.history.map((h) => {
      const status = h.status || 'learned';
      const lines =
        status === 'failed' ? `<p class="tl-err">${esc(h.error || 'The retro run failed.')}</p>`
        : status === 'nothing' ? '<p class="muted xs">Nothing new worth remembering.</p>'
        : [...h.added.map((a) => `<p class="tl-add">${esc(a.text ?? a)} ${a.kind ? where(a) : ''}</p>`), ...h.removed.map((a) => `<p class="tl-del"><s>${esc(a.text ?? a)}</s> ${a.kind ? where(a) : ''}</p>`)].join('');
      const title = S.sessions.has(h.sessionId) ? `<a href="#" data-session="${esc(h.sessionId)}">${esc(h.title || 'session')}</a>` : esc(h.title || 'session');
      return `<div class="tl ${status}"><span class="tl-dot"></span><div class="tl-main"><div class="tl-head"><b>${title}</b>${h.project ? `<span class="muted xs">${esc(projectName(h.project))}</span>` : ''}<span class="muted xs">${ago(h.at)}</span></div>${lines}</div></div>`;
    });
    return live + entries.join('') || `<p class="mem-empty">No retros yet. One runs 90 s after a session finishes, or as soon as you mark it done or archive it.</p>`;
  };

  const save = async (scope, kind, items) => {
    await api('/preferences', { method: 'PUT', body: { scope, kind, items } }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
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
    if (act === 'on') return setLearning(true).then(render);
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
  $('#memOn', node).onclick = async () => (await setLearning(!data?.enabled), render());
  node.refresh = () => !editing && render();
  render();
}

// Say once that anonymous stats are on, with a way out.
function telemetryNotice() {
  if (!S.config.telemetry?.enabled || S.config.defaults.telemetryNotice === 'seen') return;
  S.config.defaults.telemetryNotice = 'seen';
  api('/config', { method: 'PATCH', body: { defaults: { telemetryNotice: 'seen' } } }).catch(() => {});
  toast('wisp sends anonymous usage stats and error reports. No prompts, paths or code.', { timeout: 10_000, action: { label: 'Settings', run: () => openSettings({ pane: 'privacy' }) } });
}

function shortcuts() {
  const rows = [
    [combo('K'), 'Search & commands'],
    [`N · ${combo('L')}`, 'New wisp (focus the launcher)'],
    ['J / K', 'Next / previous item'],
    ['O / ↵', 'Expand / collapse item'],
    ['/', 'Follow up on item'],
    ['E', 'Mark done & go to next'],
    ['A', 'Archive / unarchive'],
    ['M', 'Rename item'],
    ['⌫', 'Delete item'],
    ['T', 'Take over in terminal'],
    ['R', 'Replay presentation'],
    ['⇧R', 'Rerun with another harness, model or thinking level'],
    ['S', 'Ship it: commit, push and open a PR (worktree tasks)'],
    ['1–9', 'Pick an answer when asked'],
    ['↵', 'Launch / send'],
    ['⇧↵', 'New line'],
    ['C', 'Collapse all'],
    ['U', 'Back to top'],
    ['Esc', 'Close / collapse'],
  ];
  const node = el(`<div class="modal keys-modal"><header><h2>Shortcuts</h2></header>${rows.map(([k, l]) => `<div class="krow"><kbd>${k}</kbd><span>${l}</span></div>`).join('')}</div>`);
  overlay(node);
}

// --- command palette ------------------------------------------------------------------

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
// How a modifier shortcut reads on this OS: "⌘L" on macOS, "Ctrl+L" on Windows/Linux.
const combo = (k) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
// ⌘ on macOS, Ctrl elsewhere (AltGr on Windows reports Ctrl+Alt, so Alt is excluded). Falls back to
// the physical key on non-Latin layouts, where e.key is e.g. "д" for the L key.
const modKey = (e, k) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
  (e.key.toLowerCase() === k || (!/^[a-z]$/i.test(e.key) && e.code === `Key${k.toUpperCase()}`));
const STATE_LABEL = { running: 'Working', waiting: 'Asking', review: 'Review', done: 'Done' };

function focusLauncher() {
  // Docked under the top bar it opens where it is, so you keep your place in the feed.
  if (!$('#launcher').classList.contains('docked')) stage.scrollTo({ top: 0, behavior: 'smooth' });
  $('#prompt')?.focus({ preventScroll: true });
}

// Run something on a session's card, expanding it first if the action needs the body.
function withCard(id, fn, { open = false } = {}) {
  reveal(id);
  if (!open || S.open.has(id)) return setTimeout(fn, 50);
  expand(id).then(fn);
}

function paletteItems() {
  const items = [];
  const cur = S.focus && S.sessions.get(S.focus);
  if (cur) {
    const id = cur.id;
    const full = S.full.get(id);
    const lastTurn = full?.turns?.at(-1);
    const live = cur.state === 'running' || cur.state === 'waiting';
    const canRollback = cur.agent !== 'wisp' && !live && (lastTurn?.changes?.length || lastTurn?.checkpoint?.commit || cur.filesChanged);
    const rolledBack = !!lastTurn?.rolledBackAt;
    const g = 'This wisp';
    const sub = cur.title;
    items.push({ group: g, label: 'Follow up', sub, icon: 'send', kbd: '/', run: () => withCard(id, () => $('.reply', S.nodes.get(id)?.card)?.focus(), { open: true }) });
    if (!live) items.push({ group: g, label: cur.state === 'done' ? 'Move back to review' : 'Mark done', sub, icon: 'done', kbd: 'E', run: () => toggleDone(id) });
    if (canRollback) items.push({ group: g, label: rolledBack ? 'Re-apply latest turn' : 'Restore to before latest turn', sub, icon: rolledBack ? 'rerun' : 'replay', keywords: 'rollback revert undo checkpoint restore', run: () => rollbackTurn(id, lastTurn?.id, rolledBack) });
    if (cur.archived || !live) items.push({ group: g, label: cur.archived ? 'Unarchive' : 'Archive', sub, icon: 'archive', kbd: 'A', run: () => setArchived(id, !cur.archived) });
    items.push({ group: g, label: 'Take over in terminal', sub, icon: 'terminal', kbd: 'T', run: () => takeOver(id) });
    items.push({ group: g, label: 'Rerun…', sub, icon: 'rerun', kbd: '⇧R', keywords: 'retry again restart model harness', run: () => rerun(id) });
    if (cur.branch && !live && cur.pr?.state !== 'MERGED') items.push({ group: g, label: cur.pr?.state === 'OPEN' ? `Push to PR #${cur.pr.number}` : 'Ship it…', sub, icon: 'send', kbd: 'S', keywords: 'commit push pull request pr github', run: () => shipDialog(id) });
    if (cur.pr?.state === 'OPEN') items.push({ group: g, label: `Merge PR #${cur.pr.number}…`, sub, icon: 'check', keywords: 'squash github', run: () => mergePr(id) });
    if (cur.groupId) items.push({ group: g, label: 'Compare runs', sub, icon: 'agent', keywords: 'vs side by side harness', run: () => compareView(id) });
    items.push({ group: g, label: 'Save as recipe…', sub, icon: 'spark', keywords: 'template reuse automation', run: () => saveAsRecipe(id) });
    items.push({ group: g, label: 'Replay presentation', sub, icon: 'replay', kbd: 'R', run: () => withCard(id, () => replay(id), { open: true }) });
    items.push({ group: g, label: 'Rename', sub, icon: 'pen', kbd: 'M', run: () => withCard(id, () => rename(id)) });
    items.push({ group: g, label: 'Delete session', sub, icon: 'trash', kbd: '⌫', keywords: 'remove', run: () => deleteSession(id) });
  }

  const sessions = [...S.sessions.values()].sort((a, b) => a.archived - b.archived || b.updatedAt - a.updatedAt);
  for (const s of sessions) {
    const state = s.archived ? 'Archived' : s.state === 'review' ? STATUS_LABEL[s.status] || 'Review' : STATE_LABEL[s.state] || s.state;
    items.push({
      group: 'Wisps',
      label: s.title,
      sub: `${s.project} · ${state} · ${ago(s.updatedAt)}`,
      dot: s.color,
      keywords: [s.preview, s.live, s.question, agentName(s.agent)].filter(Boolean).join(' '),
      // Live and unread work floats up; archived sinks.
      rank: (s.state === 'waiting' ? 3 : 0) + (s.unread ? 2 : 0) + (s.state === 'running' ? 1 : 0) - (s.archived ? 4 : 0),
      run: () => reveal(s.id),
    });
  }

  const a = 'Actions';
  items.push(
    { group: a, label: 'New wisp', icon: 'plus', kbd: 'N', keywords: 'launch create prompt task', run: focusLauncher },
    { group: a, label: S.showDone ? 'Hide done' : 'Show done', icon: 'done', keywords: 'toggle finished', run: () => $('#secDone .toggle-done').click() },
    { group: a, label: S.showArchived ? 'Hide archived' : 'Show archived', icon: 'archive', keywords: 'toggle', run: () => $('#secArchived .toggle-done').click() },
  );
  if (S.open.size) items.push({ group: a, label: 'Collapse all', icon: 'minus', kbd: 'C', run: collapseAll });
  items.push(
    { group: a, label: 'Add project…', icon: 'folder', keywords: 'folder repo directory', run: () => openProjects({ focusAdd: true }) },
    { group: a, label: 'Manage projects', icon: 'folder', keywords: 'rename color remove', run: () => openProjects() },
    { group: a, label: 'Memory', icon: 'spark', keywords: 'learned preferences lessons retro', run: () => openMemory() },
    { group: a, label: 'Recipes', icon: 'spark', keywords: 'automations saved prompts templates', run: () => openAutomations({ tab: 'recipes' }) },
    { group: a, label: 'Triggers', icon: 'replay', keywords: 'automations schedule cron ci issues github', run: () => openAutomations({ tab: 'triggers' }) },
    { group: a, label: 'Usage', icon: 'stats', keywords: 'spend cost tokens outcomes success', run: () => openUsage() },
    { group: a, label: 'Phone', icon: 'send', keywords: 'ntfy telegram notifications mobile remote', run: () => openPhone() },
    { group: a, label: 'Machines', icon: 'server', keywords: 'remote ssh server computer devbox cloud vm', run: () => openMachines() },
    { group: a, label: 'Add a machine…', icon: 'server', keywords: 'remote ssh server computer connect', run: () => openMachines({ focusAdd: true }) },
    { group: a, label: 'Settings', icon: 'settings', keywords: 'preferences lessons learn retro editor terminal notifications', run: openSettings },
    { group: a, label: 'Keyboard shortcuts', icon: 'info', kbd: '?', keywords: 'keys help hotkeys', run: shortcuts },
  );

  for (const r of S.config.recipes || []) items.push({ group: 'Recipes', label: `Run: ${r.name}`, sub: r.prompt.replace(/\s+/g, ' ').slice(0, 80), icon: 'spark', keywords: `recipe ${r.prompt}`, run: () => runRecipe({ ...r, params: recipeParams(r.prompt) }) });

  const filter = (id) => () => {
    S.filter = id;
    save('wisp.filter', id);
    renderProjects();
    renderFeed();
    feedToTop();
    renderLaunchChips();
  };
  items.push({ group: 'Projects', label: 'All projects', sub: S.filter === 'all' ? 'Current filter' : '', dot: 'slate', keywords: 'filter clear', run: filter('all') });
  for (const p of S.config.projects.slice().sort((x, y) => (y.lastUsedAt || y.addedAt) - (x.lastUsedAt || x.addedAt))) {
    items.push({ group: 'Projects', label: p.name, sub: S.filter === p.id ? 'Current filter' : p.path, dot: p.color, keywords: `filter ${p.path}`, run: filter(p.id) });
  }
  return items;
}

let paletteOpen = false;
function openPalette() {
  if (paletteOpen) return closeOverlay();
  // Don't stack over another modal (settings, projects…); the palette replaces nothing.
  if (!$('#overlay').hidden) return;
  paletteOpen = true;
  palette({ items: paletteItems(), overlay: (node) => overlay(node, { onClose: () => (paletteOpen = false) }) });
}

// --- notifications -----------------------------------------------------------------------

// On unless turned off in settings, and only if the browser lets us.
function notifyOn() {
  return S.config.defaults.notify !== 'off' && 'Notification' in window && Notification.permission === 'granted';
}

function askNotify() {
  if (S.config.defaults.notify !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function notifyFinished(s) {
  const viewing = S.open.has(s.id) && watching(s.id) && document.hasFocus();
  if (viewing) return;
  let verb = s.state === 'waiting' ? 'has a question' : 'is ready';
  // A task run in several places (or compared) says so once, when its last run finishes.
  const runs = s.groupId ? [...S.sessions.values()].filter((x) => x.groupId === s.groupId && !x.archived) : [];
  if (runs.length > 1 && s.state !== 'waiting') {
    if (runs.some((x) => x.id !== s.id && x.state === 'running')) return;
    const places = new Set(runs.map((x) => x.machine?.id || '')).size;
    verb = places > 1 ? `is ready on ${places} machines` : `is ready (${runs.length} runs)`;
  }
  toast(`${icon(s.state === 'waiting' ? 'ask' : 'spark')} <b>${esc(s.title)}</b> ${verb}`, { action: { label: 'Open', run: () => reveal(s.id) }, timeout: 7000 });
  if (notifyOn() && !document.hasFocus()) {
    const note = new Notification(`${s.project}: ${s.title}`, { body: s.state === 'waiting' ? s.question : s.preview || 'Ready for review', icon: '/favicon.svg', tag: s.id });
    note.onclick = () => (window.focus(), reveal(s.id));
  }
}

// --- live events --------------------------------------------------------------------------

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('summary', (e) => {
    const s = JSON.parse(e.data);
    if (s.parentId) return onChildSummary(s); // a subagent: lives inside its lead's card
    const prev = S.sessions.get(s.id);
    const was = prev && sectionOf(prev); // before the update: a compare task's section depends on all its runs
    S.sessions.set(s.id, s);
    // A section change moves the card (a follow-up sends it from "Needs you" to "Working").
    // If the user is watching it, the view follows it there; otherwise whatever they're
    // reading stays put. Marking done or archiving is the exception: the card leaves the
    // list and focus goes to the next one instead.
    const moved = prev && was !== sectionOf(s);
    const follow = moved && s.state !== 'done' && !s.archived && watching(s.id);
    keepInPlace(follow ? S.nodes.get(s.id).card : feedAnchor(s.id), () => {
      // A card left open while it worked shouldn't land in "Needs you" expanded —
      // fold it unless the user is actually watching it.
      if (prev?.state === 'running' && s.state !== 'running' && S.open.has(s.id) && !(watching(s.id) && document.hasFocus())) collapse(s.id);
      renderFeed();
    });
    if (prev?.state !== s.state || prev?.queued !== s.queued) scheduleRefetch(s.id);
    if (JSON.stringify(prev?.pr) !== JSON.stringify(s.pr)) renderPrStrip(s.id);
  });
  es.addEventListener('activity', (e) => onActivity(JSON.parse(e.data)));
  es.addEventListener('turn', (e) => scheduleRefetch(JSON.parse(e.data).sessionId));
  es.addEventListener('finished', (e) => notifyFinished(JSON.parse(e.data).session));
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    S.sessions.delete(id);
    S.full.delete(id);
    S.open.delete(id);
    saveOpen();
    keepInPlace(feedAnchor(id), renderFeed);
  });
  es.addEventListener('config', () => (loadConfig(), $('.auto-modal')?.refresh()));
  es.addEventListener('remote', () => $('.phone-modal')?.refresh());
  es.addEventListener('machines', (e) => setMachines(JSON.parse(e.data)));
  es.addEventListener('update', (e) => renderUpdate(JSON.parse(e.data)));
  es.addEventListener('preferences', () => {
    $('.memory-modal')?.refresh();
    $('.settings-modal')?.paintLearn?.();
  });
  es.addEventListener('hello', () => (loadSessions(), loadUpdate(), loadMachines())); // also after sleep/reconnect
}

async function loadSessions() {
  const list = await api('/sessions');
  S.sessions = new Map(list.map((s) => [s.id, s]));
  for (const id of S.open) if (!S.sessions.has(id)) S.open.delete(id);
  saveOpen();
  keepInPlace(feedAnchor(), renderFeed);
  for (const id of S.open) scheduleRefetch(id);
}

async function loadConfig() {
  S.config = await api('/config');
  renderProjects();
  renderLaunchChips();
  paintAutoBtn();
}

// --- updates ----------------------------------------------------------------------------

// The server polls npm; when a newer wisp-agents is out, a pill appears next to Search.
let update = null;
const loadUpdate = () => api('/update').then(renderUpdate).catch(() => {});
function renderUpdate(u) {
  update = u;
  const b = $('#updateBtn');
  const busy = u.status === 'installing' || u.status === 'restarting';
  b.hidden = !u.available && !busy;
  b.disabled = busy;
  b.classList.toggle('busy', busy);
  b.querySelector('span').textContent = u.status === 'installing' ? 'Updating…' : u.status === 'restarting' ? 'Restarting…' : `Update to ${u.latest}`;
  b.title = u.auto ? `wisp ${u.current} → ${u.latest}: install and restart` : `wisp ${u.latest} is out. Run \`${u.command}\` to update`;
}

async function installUpdate() {
  if (!update?.available) return;
  if (!update.auto) return toast(`wisp <b>${esc(update.latest)}</b> is out. Run <code>${esc(update.command)}</code>`, { action: { label: 'Copy', run: () => copy(update.command) }, timeout: 8000 });
  const post = (force) => api('/update', { method: 'POST', body: { force } });
  try {
    await post(false).catch(async (err) => {
      const running = [...S.sessions.values()].filter((s) => s.state === 'running' || s.state === 'waiting').length;
      if (err.message !== 'agents are running') throw err;
      if (!confirm(`Update to wisp ${update.latest} and restart? ${running || 'Some'} running agent${running === 1 ? '' : 's'} will be stopped.`)) throw null;
      return post(true);
    });
  } catch (err) {
    if (err) toast(esc(err.message), { tone: 'bad', timeout: 10_000, action: { label: 'Copy command', run: () => copy(update.command) } });
    return;
  }
  renderUpdate({ ...update, status: 'restarting' });
  // The server exits and a new one takes the port: reload once it answers with the new version.
  const from = update.current;
  const t0 = Date.now();
  const poll = setInterval(async () => {
    const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
    if (h?.version && h.version !== from) return clearInterval(poll), location.reload();
    if (Date.now() - t0 > 120_000) clearInterval(poll), toast('wisp did not come back. Start it again from your terminal.', { tone: 'bad', timeout: 15_000 });
  }, 1000);
}

// --- keyboard ---------------------------------------------------------------------------

const feedIds = () => $$('#feed .item').map((x) => x.dataset.id);
// The user takes a card out of its list (done, archive, delete). The next card — the one below,
// or the one above at the end of the list — gets focus and lands where the old one sat, so
// triage continues on the same spot. Call before the request, while the card is still laid
// out; the returned function applies the change locally and places the next card.
function handOff(id) {
  const card = S.nodes.get(id)?.card;
  if (!card?.isConnected) return (apply) => (apply(), renderFeed());
  const nextUp = (card.nextElementSibling || card.previousElementSibling)?.dataset.id || feedIds().find((x) => x !== id);
  const r = card.getBoundingClientRect();
  const inset = topInset();
  const slot = r.bottom > inset && r.top < innerHeight ? Math.max(inset, r.top) : null;
  return (apply) => {
    if (S.open.has(id)) collapse(id);
    apply(); // don't wait for the live update to drop the card
    renderFeed();
    if (!nextUp || !S.nodes.has(nextUp)) return;
    setFocus(nextUp, { scroll: slot === null });
    const next = S.nodes.get(nextUp).card;
    if (slot !== null && next.isConnected) scrollByPx(next.getBoundingClientRect().top - slot);
  };
}

document.addEventListener('keydown', (e) => {
  // ⌘K / Ctrl+K works from anywhere, even mid-sentence in the launcher.
  if (modKey(e, 'k')) {
    e.preventDefault();
    return openPalette();
  }
  // ⌘L / Ctrl+L jumps to the launcher from anywhere, including another composer.
  if (modKey(e, 'l')) {
    e.preventDefault();
    if (!$('#overlay').hidden) closeOverlay();
    return focusLauncher();
  }
  const typing = e.target.closest('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape') {
    if (!$('#overlay').hidden) return $('#overlay .sx-back') ? $('#overlay .sx-back').click() : closeOverlay();
    if (typing) return e.target.blur();
    if (S.focus && S.open.has(S.focus)) {
      collapse(S.focus);
      S.nodes.get(S.focus)?.card.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('#overlay').hidden) return;
  const k = e.key.toLowerCase();
  const id = S.focus && S.nodes.has(S.focus) ? S.focus : null;
  if (k === 'n') {
    e.preventDefault();
    focusLauncher();
  } else if (k === 'j' || k === 'k') {
    const ids = feedIds();
    if (!ids.length) return;
    const i = ids.indexOf(id);
    const next = i < 0 ? ids[0] : ids[k === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)];
    setFocus(next);
  } else if ((k === 'o' || (k === 'enter' && !e.target.closest('button, a'))) && id) {
    e.preventDefault();
    toggle(id);
  } else if (k === 'e' && id) toggleDone(id);
  else if (k === 'a' && id) {
    const s = S.sessions.get(id);
    if (s && (s.archived || (s.state !== 'running' && s.state !== 'waiting'))) setArchived(id, !s.archived);
  }
  else if (k === 'c' && S.open.size) collapseAll();
  else if (k === 'u' || k === 'home') {
    e.preventDefault();
    backToTop();
  }
  else if (k === 'm' && id) {
    e.preventDefault();
    rename(id);
  } else if ((k === 'delete' || k === 'backspace') && id) {
    e.preventDefault();
    deleteSession(id);
  } else if (k === 't' && id) takeOver(id);
  else if (k === 'r' && e.shiftKey && id) rerun(id);
  else if (k === 's' && id && S.sessions.get(id)?.branch) shipDialog(id);
  else if (k === 'r' && id) replay(id);
  else if (k === '/' && id) {
    e.preventDefault();
    const focusReply = () => $('.reply', S.nodes.get(id)?.card)?.focus();
    if (S.open.has(id)) focusReply();
    else expand(id).then(focusReply);
  } else if (k === '?') shortcuts();
  else if (/^[1-9]$/.test(k) && id && S.open.has(id)) {
    const card = S.nodes.get(id).card;
    const opts = $$('.ask-card .opt', card).length ? $$('.ask-card .opt', card) : $$('.turn:last-child .b-question:not(.answered) .opt:not(.own)', card);
    opts[Number(k) - 1]?.click();
  }
});

$('#settingsBtn').onclick = openSettings;
$('#searchBtn').onclick = openPalette;
$('#machinesBtn').onclick = () => openMachines();
$('#autoBtn').onclick = () => openAutomations({ tab: (S.config.triggers || []).length && !(S.config.recipes || []).length ? 'triggers' : 'recipes' });
$('#updateBtn').onclick = installUpdate;
$('#searchBtn').title = `Search (${combo('K')})`;
$('#searchBtn .mod-k').textContent = combo('K');
$('#secDone .toggle-done').onclick = () => {
  S.showDone = !S.showDone;
  save('wisp.showDone', S.showDone);
  renderFeed();
};
$('#secArchived .toggle-done').onclick = () => {
  S.showArchived = !S.showArchived;
  renderFeed();
};

// elapsed timers + "ago" stamps
setInterval(() => {
  $$('.elapsed[data-start]').forEach((n) => (n.textContent = fmtDuration(Date.now() - Number(n.dataset.start))));
}, 1000);
setInterval(() => {
  for (const [id, n] of S.nodes) {
    const s = S.sessions.get(id);
    const t = s && $('.q-time', n.head);
    if (t) t.textContent = ago(s.updatedAt);
  }
}, 30000);

// Sticky top bar gets a hairline once the page scrolls; "back to top" shows after a screen's worth.
const toTop = $('#toTop');
// Once the launcher scrolls under the top bar it docks there, folded to one line. The slot keeps
// its full height in the feed so docking never shifts what you're reading.
const launchSlot = $('#launchSlot');
const dockLauncher = () => {
  const box = $('#launcher');
  const gone = launchSlot.getBoundingClientRect().bottom < $('#topbar').offsetHeight;
  if (gone === box.classList.contains('docked')) return;
  launchSlot.style.height = gone ? `${box.offsetHeight}px` : '';
  box.classList.toggle('docked', gone);
};
stage.addEventListener('scroll', () => {
  $('#topbar').classList.toggle('scrolled', stage.scrollTop > 4);
  dockLauncher();
  toTop.hidden = stage.scrollTop < stage.clientHeight * 0.75;
}, { passive: true });
const backToTop = () => stage.scrollTo({ top: 0, behavior: 'smooth' });
toTop.onclick = backToTop;

if (/Electron/.test(navigator.userAgent)) document.body.classList.add('electron', /Mac/.test(navigator.platform) ? 'mac' : 'other');

// --- links -------------------------------------------------------------------------------

// #/s/<id> still works (notifications, CLI): it reveals that item in the feed.
function route() {
  const m = location.hash.match(/^#\/s\/(\w+)/);
  if (!m) return;
  history.replaceState(null, '', '#/');
  reveal(m[1]);
}

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  loadUpdate();
  for (const id of S.open) if (S.sessions.get(id)?.unread) scheduleRefetch(id);
});

(async () => {
  [S.agents] = await Promise.all([api('/agents').catch(() => []), loadConfig(), loadSessions(), loadMachines()]);
  renderLauncher();
  connect();
  route();
  $('#prompt')?.focus();
  telemetryNotice();
})();
