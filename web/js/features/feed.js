// The feed: every session as a card, grouped into Needs you, Working, Done and Archived. Cards
// expand in place; nothing navigates away.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { ago, STATUS_LABEL } from '../core/format.js';
import { HERE, MOBILE, S, save, saveOpen } from '../core/state.js';
import { taskDone, taskMenu, toggleDone } from './actions.js';
import { compareView } from './compare.js';
import { renderLaunchChips } from './launcher.js';
import { inProject, machinePill, projectLabel } from './places.js';
import { renderProjects } from './projects.js';
import { agentName, effortLabel, harnessLogo, modelBadge } from './runners.js';
import { scrollByPx, stage, topInset } from './scroll.js';
import { prOf, prPill, shipPill } from './ship.js';
import { teamStack } from './team.js';
import { renderBody } from './turns.js';
import { slotHtml } from './spells.js';
import { termPill } from './term.js';
import { backToPlace, isSplit, keepPlace, paintHead, paintSplit, sidebar, splitOpen } from './split.js';

function visible(list) {
  return S.filter === 'all' ? list : list.filter((s) => inProject(s, S.filter));
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

// Every task in the feed (or the sidebar), by section and in its order.
export function groups() {
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

// Done and Archived can hold hundreds of tasks: they show a page of cards and add the next
// page as the user scrolls to the end of the list. The headings count every one.
const PAGE = 60;
const page = { secDone: PAGE, secArchived: PAGE };
const moreObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || e.target.hidden) continue;
      page[e.target.closest('.f-group').id] += PAGE;
      renderFeed();
      // Still in view after a short page: observing again reports it again, so the next page comes.
      moreObserver.unobserve(e.target);
      moreObserver.observe(e.target);
    }
  },
  { root: stage, rootMargin: '0px 0px 800px 0px' },
);
for (const id of Object.keys(page)) {
  const more = el(`<button class="f-more link xs" hidden></button>`);
  more.addEventListener('click', () => {
    page[id] += PAGE;
    renderFeed();
  });
  $(`#${id}`).append(more);
  moreObserver.observe(more);
}

export function renderFeed() {
  const { needs, working, done, archived } = groups();
  const place = (sec, list, show = true) => {
    const box = $('.f-list', sec);
    sec.hidden = !list.length;
    $('h4 .n', sec).textContent = list.length || '';
    const cap = page[sec.id] ?? list.length;
    const want = show ? list.slice(0, cap) : [];
    const more = $('.f-more', sec);
    if (more) {
      const left = show ? list.length - want.length : 0;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(left, PAGE)} more · ${left} left`;
    }
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
  place($('#secDone'), done, S.showDone);
  $('#secDone').classList.toggle('collapsed', !S.showDone);
  place($('#secArchived'), archived, S.showArchived);
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
  placeCollapseAll();

  const n = [...S.sessions.values()].filter((s) => (s.state === 'review' && s.unread) || s.state === 'waiting').length;
  document.title = n ? `(${n}) wisp` : 'wisp';
  renderProjects();
  paintSplit();
}

// A new project filter swaps the whole list; staying at the old offset would drop the user
// somewhere arbitrary in it, so bring the top of the feed back into view.
export function feedToTop() {
  if (isSplit()) return (sidebar.scrollTop = 0);
  const top = $('#feed').getBoundingClientRect().top;
  if (top < topInset()) scrollByPx(top - topInset());
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
      // Split view: a click opens the task beside the list (clicking it again leaves it open) and
      // the list stays where it is: the task shows in the main pane, there's nothing to scroll to.
      setFocus(s.id, { scroll: !isSplit() });
      if (isSplit()) return S.open.has(s.id) ? paintSplit() : expand(s.id);
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
  if (S.open.has(s.id)) paintHead(s);
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
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open && !isSplit() ? '' : `<span class="it-sub">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${headPills(s, pill)}
      <span class="q-time">${ago(s.updatedAt)}</span>
      ${s.pending ? '' : slotHtml('card.hover', s)}
      ${quickDone(s, open)}
      ${icon('chevron', 'chev')}
    </span>`;
}

// One-click done on review rows. A sidebar row keeps it while open, and rows without one keep its
// space, so every row's pills and time line up and opening a row doesn't move anything.
function quickDone(s, open) {
  if (s.state === 'review' && !s.archived && (!open || isSplit())) return `<button class="it-quick" data-a="quick-done" title="Mark done (E)">${icon('done')}</button>`;
  return '<span class="it-quick-gap" aria-hidden="true"></span>';
}

// What a card head says about its task, between the title and the time (the split view's header
// shows the same).
export function headPills(s, pill) {
  return `
      ${termPill(s)}${pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${autoPill(s)}
      ${s.shipping ? shipPill(s) : prOf(s) ? prPill(prOf(s), s.conflictFix) : ''}
      ${s.team?.length ? teamStack(s.agent, s.team) : modelBadge(s.agent, s.model, s.effort, s.route?.switched ? null : s.route)}
      ${s.machine ? machinePill(s.machine) : ''}
      ${projectLabel(s)}
      ${s.pending ? '' : slotHtml('card.head', s)}`;
}

// What Auto found after the run: its own test check, the best-of-2 pick, a hand-over.
function autoPill(s) {
  const a = s.auto;
  if (!a || s.pending) return '';
  const out = [];
  if (a.pick?.winner) out.push(`<span class="pill auto-pick" title="${esc(`wisp's pick of the two runs: ${a.pick.why}`)}">${icon('spark')}Pick</span>`);
  if (a.escalatedTo) {
    const to = S.sessions.get(a.escalatedTo);
    const toName = to ? `${agentName(to.agent)}${to.model ? ` · ${to.model}` : ''}` : 'another pick';
    const why = a.reason === 'limit' ? `${agentName(s.agent)} was at its usage limit, so wisp moved the task to ${toName}` : a.reason === 'error' ? `The run failed, so wisp handed the task to ${toName}` : `Tests still failed, so wisp handed the task to ${toName}`;
    out.push(`<span class="pill auto-handed" title="${esc(why)}">${a.reason === 'limit' ? 'Moved on' : 'Handed on'}</span>`);
  }
  const c = a.check;
  if (c && !a.busy && c.verdict !== 'skip') {
    const n = c.newFailures || c.failed;
    const tip = c.verdict === 'pass' ? `wisp ran ${c.command}: no new failures${c.note ? ` (${c.note})` : ''}` : c.verdict === 'fail' ? `wisp ran ${c.command}: ${n} test${n === 1 ? '' : 's'} that passed before now fail${a.repairs ? `, after ${a.repairs} repair round${a.repairs > 1 ? 's' : ''}` : ''}` : `wisp ran ${c.command}: ${c.note || "couldn't tell"}`;
    const label = c.verdict === 'pass' ? 'Tests' : c.verdict === 'fail' ? `${n} failing` : 'Tests ?';
    out.push(`<span class="pill auto-ck ck-${c.verdict}" title="${esc(tip)}">${icon(c.verdict === 'pass' ? 'check' : c.verdict === 'fail' ? 'x' : 'info')}${label}</span>`);
  }
  return out.join('');
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
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open && !isSplit() ? '' : `<span class="it-sub">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${runsOf(s).some((r) => (r.machine?.id || '') !== (s.machine?.id || '')) ? `${s.machine ? machinePill(s.machine) : `<span class="q-machine" title="Runs on ${esc(HERE)}">${icon('laptop')}<span>${esc(HERE)}</span></span>`}${projectLabel(s)}` : ''}
      ${live && s.state === 'running' ? `<span class="pill st-running"><i></i>Working</span>` : pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${autoPill(s)}
      ${s.shipping ? shipPill(s) : prOf(s) ? prPill(prOf(s), s.conflictFix) : ''}
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
  // Auto's groups say what Auto did: which run it picked, or who it handed the task to.
  const picked = t.runs.find((r) => r.auto?.pick?.winner);
  const handed = t.runs.find((r) => r.auto?.escalatedFrom);
  const runName = (r) => `${agentName(r.agent)}${r.model ? ` · ${r.model}` : ''}`;
  const how = handed?.auto?.reason === 'limit' ? 'The first harness was at its usage limit, so wisp moved it to' : handed?.auto?.reason === 'error' ? 'The first run failed, so wisp handed it to' : 'Tests failed, so wisp handed it to';
  const autoLine = picked ? `wisp's pick: ${picked.auto.pick.why}` : handed ? `${how} ${runName(handed)}${handed.auto?.check?.verdict === 'pass' ? ' · tests pass now' : handed.auto?.check?.verdict === 'fail' ? ' · still failing' : ''}` : '';
  const status = t.state === 'waiting' ? 'A run is asking you' : t.state === 'running' ? `${finished} of ${t.runs.length} finished${places > 1 ? ` · on ${places} machines` : ''}` : t.state === 'done' ? 'Done' : autoLine || (places > 1 ? `All finished on ${places} machines` : 'All finished · pick one to keep');
  g.card.className = `task-item c-${t.color} st-${t.state} ${t.unread ? 'unread' : ''}`;
  g.head.innerHTML = `
    <span class="q-dot ${t.state === 'running' ? 'live' : ''} ${t.state === 'waiting' ? 'waiting' : ''}"></span>
    <span class="it-main">
      <span class="it-title">${esc(t.title)}</span>
      <span class="it-sub">${esc(status)}</span>
    </span>
    <span class="it-side">
      <button class="ghost xs" data-a="compare" title="Side by side: time, cost, changes, tests and each presentation"><b class="vs-mark">vs</b><span>Compare</span></button>
      ${places > 1 ? '' : projectLabel(t)}
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
  if (scroll && n) n.card.scrollIntoView({ block: !isSplit() && n.card.offsetHeight > stage.clientHeight - topInset() ? 'start' : 'nearest', behavior: 'smooth' });
}

export function toggle(id) {
  S.open.has(id) ? collapse(id) : expand(id);
}

export async function expand(id, { scroll = true } = {}) {
  const n = S.nodes.get(id);
  if (!n) return;
  // Split view shows one task at a time.
  if (isSplit()) for (const o of [...S.open]) if (o !== id) collapse(o);
  S.open.add(id);
  saveOpen();
  n.card.classList.add('open');
  renderHead(n, S.sessions.get(id));
  if (!n.body) {
    n.body = el(`<div class="it-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>`);
    n.card.append(n.body);
  }
  placeCollapseAll();
  paintSplit();
  syncUrl();
  // Split view opens the task in the main pane, so the list doesn't move to it.
  if (scroll && !isSplit()) requestAnimationFrame(() => n.card.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  if (!S.full.has(id)) await fetchFull(id);
  else renderBody(id, { fresh: true });
  backToPlace(id);
}

export function collapse(id) {
  const n = S.nodes.get(id);
  S.open.delete(id);
  saveOpen();
  S.full.delete(id);
  retries.delete(id);
  if (n) {
    keepPlace(id); // split view: where it was scrolled to, for when it opens again
    n.body?.remove();
    n.body = null;
    n.turnNodes.clear();
    n.tray = null;
    n.showAll = false;
    n.card.classList.remove('open');
    const s = S.sessions.get(id);
    if (s) renderHead(n, s);
  }
  placeCollapseAll();
  paintSplit();
  syncUrl();
}

// The address names the open task (#/s/<id>; in the feed, the one opened last), so a reload or a
// copied link opens it again. Off until route() has read the address the page was loaded with. The
// phone has no address bar: there it's only cleared, so a tapped notification always routes.
let urlOn = false;
export function syncUrl({ start = false } = {}) {
  urlOn ||= start;
  if (!urlOn) return;
  const id = MOBILE ? null : isSplit() ? splitOpen() : [...S.open].at(-1);
  const h = location.hash;
  if (id) {
    if (h !== `#/s/${id}`) history.replaceState(null, '', `#/s/${id}`);
  } else if (h.startsWith('#/s/')) history.replaceState(null, '', location.pathname + location.search);
}

export async function fetchFull(id) {
  let s;
  try {
    s = await api(`/sessions/${id}`);
  } catch (err) {
    // Gone on the server: close it. Anything else is the connection (a phone back from the
    // background waits for its tunnel): keep it open and try again, or its body says Loading
    // forever. The `hello` after a reconnect refetches it too.
    if (err.status === 404) return collapse(id);
    if (S.open.has(id)) retryLater(id);
    return;
  }
  retries.delete(id);
  if (!S.open.has(id)) return; // collapsed while loading
  const fresh = !S.full.has(id);
  S.full.set(id, s);
  renderBody(id, { fresh });
  if (s.unread && s.state !== 'running' && document.hasFocus()) api(`/sessions/${id}`, { method: 'PATCH', body: { unread: false } }).catch(() => {});
}

const refetchTimers = new Map();
export function scheduleRefetch(id, ms = 120) {
  if (!S.open.has(id)) return;
  clearTimeout(refetchTimers.get(id));
  refetchTimers.set(id, setTimeout(() => (refetchTimers.delete(id), fetchFull(id)), ms));
}

// 1s, 2s, 4s… up to 15s between tries while the server can't be reached.
const retries = new Map();
function retryLater(id) {
  const n = retries.get(id) || 0;
  retries.set(id, n + 1);
  scheduleRefetch(id, Math.min(1000 * 2 ** n, 15000));
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
  if (S.filter !== 'all' && !inProject(s, S.filter)) {
    S.filter = 'all';
    save('wisp.filter', S.filter);
    renderLaunchChips();
  }
  // A card further down than the pages shown so far: show pages up to it.
  const sec = { done: 'secDone', archived: 'secArchived' }[sectionOf(s)];
  if (sec) {
    const { done, archived } = groups();
    const at = (sec === 'secDone' ? done : archived).findIndex((t) => (t.runs || [t]).some((r) => r.id === id));
    if (at >= page[sec]) page[sec] = Math.ceil((at + 1) / PAGE) * PAGE;
  }
  renderFeed();
  setFocus(id, { scroll: false });
  if (!S.open.has(id)) return expand(id);
  // Already open: it's the one the address names now (the last opened).
  S.open.delete(id);
  S.open.add(id);
  saveOpen();
  syncUrl();
  if (!isSplit()) S.nodes.get(id)?.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

export const feedIds = () => $$('#feed .item:not(.pending)').map((x) => x.dataset.id);

// The user takes a card out of its list (done, archive, delete). The next card — the one below,
// or the one above at the end of the list — gets focus and lands where the old one sat, so
// triage continues on the same spot. Call before the request, while the card is still laid
// out; the returned function applies the change locally and places the next card.
export function handOff(id) {
  const card = S.nodes.get(id)?.card;
  // Split view: the next task takes the main pane if this one had it.
  if (isSplit() && card?.isConnected) {
    const nextUp = (card.nextElementSibling || card.previousElementSibling)?.dataset.id || feedIds().find((x) => x !== id);
    const had = S.open.has(id);
    return (apply) => {
      if (had) collapse(id);
      apply();
      renderFeed();
      if (!nextUp || !S.nodes.has(nextUp)) return;
      setFocus(nextUp);
      if (had) expand(nextUp);
    };
  }
  if (!card?.isConnected) return (apply) => (apply(), renderFeed());
  const nextUp = (card.nextElementSibling || card.previousElementSibling)?.dataset.id || feedIds().find((x) => x !== id);
  const r = card.getBoundingClientRect();
  const inset = topInset();
  const slot = r.bottom > inset && r.top < innerHeight ? Math.max(inset, r.top) : null;
  const had = S.open.has(id);
  return (apply) => {
    if (had) collapse(id);
    apply(); // don't wait for the live update to drop the card
    renderFeed();
    if (!nextUp || !S.nodes.has(nextUp)) return;
    setFocus(nextUp, { scroll: slot === null });
    const next = S.nodes.get(nextUp).card;
    if (slot !== null && next.isConnected) scrollByPx(next.getBoundingClientRect().top - slot);
    // Reading one report after another: done with an open one, the next one that needs you opens
    // in its place, as split view does.
    const ns = S.sessions.get(nextUp);
    if (had && ns && !ns.pending && !S.open.has(nextUp) && sectionOf(ns) === 'needs') expand(nextUp, { scroll: false });
  };
}
