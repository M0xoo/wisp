// The feed: every session as a card, grouped into Needs you, Working, Done and Archived. Cards
// expand in place; nothing navigates away.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { ago, STATUS_LABEL } from '../core/format.js';
import { S, save, saveOpen } from '../core/state.js';
import { taskDone, taskMenu, toggleDone } from './actions.js';
import { compareView } from './compare.js';
import { renderLaunchChips } from './launcher.js';
import { machinePill } from './places.js';
import { renderProjects } from './projects.js';
import { agentName, effortLabel, harnessLogo, modelBadge } from './runners.js';
import { scrollByPx, stage, topInset } from './scroll.js';
import { prPill, shipPill } from './ship.js';
import { teamStack } from './team.js';
import { renderBody } from './turns.js';

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

export function renderFeed() {
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
export function feedToTop() {
  const top = $('#feed').getBoundingClientRect().top;
  if (top < topInset()) scrollByPx(top - topInset());
}

function renderFeedHead(needs, working) {
  const parts = [];
  if (working.length) parts.push(`<span class="hs working"><i></i>${working.length} working</span>`);
  if (needs.length) parts.push(`<span class="hs needs"><i></i>${needs.length} need${needs.length === 1 ? 's' : ''} you</span>`);
  // Group headings already carry the counts; only say something when the feed is calm.
  $('#feedHead').innerHTML = parts.length ? '' : '<span class="hs calm"><i></i>Nothing needs you</span>';
  $('#feedHead').hidden = !!parts.length;
  placeCollapseAll();
}

// "Collapse all" floats over the page instead of living in the flow: showing it
// never shifts the feed, and it stays reachable deep inside a long open card.
const collapseAllBtn = el(`<button class="collapse-all" title="Collapse all (C) · Esc collapses the focused one"><span></span><kbd>C</kbd></button>`);
document.body.append(collapseAllBtn);

// Collapsing shrinks everything above the reader, which would leave them staring
// at unrelated cards far down the feed. Keep the card they were reading in view.
export const collapseAll = () => {
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
      if (s.pending || n.head.querySelector('[contenteditable="true"]')) return;
      if (e.target.closest('[data-a="quick-done"]')) return toggleDone(s.id);
      setFocus(s.id);
      toggle(s.id);
    });
    card.addEventListener('mousedown', () => {
      if (!s.pending) setFocus(s.id, { scroll: false });
    });
    n.head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (s.pending) return;
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
  n.card.className = `item ${s.pending ? 'pending' : ''} c-${s.color} st-${s.state} ${s.unread ? 'unread' : ''} ${open ? 'open' : ''} ${S.focus === s.id ? 'focused' : ''}`;
  n.head.innerHTML = `
    <span class="q-dot ${s.state === 'running' ? 'live' : ''} ${s.state === 'waiting' ? 'waiting' : ''}"></span>
    <span class="it-main">
      <span class="it-title">${esc(s.title)}</span>
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open ? '' : `<span class="it-sub">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${s.shipping ? shipPill(s) : s.pr ? prPill(s.pr, s.conflictFix) : ''}
      ${s.team?.length ? teamStack(s.agent, s.team) : modelBadge(s.agent, s.model, s.effort, s.route?.switched ? null : s.route)}
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
      ${s.shipping ? shipPill(s) : s.pr ? prPill(s.pr, s.conflictFix) : ''}
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

export function setFocus(id, { scroll = true } = {}) {
  if (S.focus === id) return;
  S.nodes.get(S.focus)?.card.classList.remove('focused');
  S.focus = id;
  const n = S.nodes.get(id);
  n?.card.classList.add('focused');
  // A card taller than the screen would land with its header out of view ('nearest' aligns
  // its far edge when moving up), so bring its top in instead.
  if (scroll && n) n.card.scrollIntoView({ block: n.card.offsetHeight > stage.clientHeight - topInset() ? 'start' : 'nearest', behavior: 'smooth' });
}

export function toggle(id) {
  S.open.has(id) ? collapse(id) : expand(id);
}

export async function expand(id, { scroll = true } = {}) {
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

export function collapse(id) {
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
export function scheduleRefetch(id) {
  if (!S.open.has(id)) return;
  clearTimeout(refetchTimers.get(id));
  refetchTimers.set(id, setTimeout(() => (refetchTimers.delete(id), fetchFull(id)), 120));
}

export const sectionOf = (s) => {
  const t = taskOf(s);
  return t.archived ? 'archived' : t.state === 'running' ? 'working' : t.state === 'done' ? 'done' : 'needs';
};

// Bring an item into view, expanded — used by notifications and links.
export function reveal(id) {
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

export const feedIds = () => $$('#feed .item:not(.pending)').map((x) => x.dataset.id);

// The user takes a card out of its list (done, archive, delete). The next card — the one below,
// or the one above at the end of the list — gets focus and lands where the old one sat, so
// triage continues on the same spot. Call before the request, while the card is still laid
// out; the returned function applies the change locally and places the next card.
export function handOff(id) {
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
