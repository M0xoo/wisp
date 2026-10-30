// The feed: every session as a card, grouped into Needs you, Working, Done and Archived. Cards
// expand in place; nothing navigates away.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { ago, agoLong, STATUS_LABEL, timeAttrs } from '../core/format.js';
import { HERE, isForLater, MOBILE, needsYou, S, save, saveOpen } from '../core/state.js';
import { setForLater, taskDone, taskMenu, toggleDone } from './actions.js';
import { compareView } from './compare.js';
import { carryDock } from './composer.js';
import { renderLaunchChips } from './launcher.js';
import { inProject, machinePill, projectLabel } from './places.js';
import { renderProjects } from './projects.js';
import { agentById, agentName, effortLabel, harnessLogo, modelBadge } from './runners.js';
import { scrollByPx, stage, topInset } from './scroll.js';
import { prOf, prPill, shipPill } from './ship.js';
import { overlapPill } from './overlaps.js';
import { teamStack } from './team.js';
import { renderBody } from './turns.js';
import { slotHtml } from './spells.js';
import { swipesDone } from './swipe.js';
import { toastError } from '../ui/toast.js';
import { termPill } from './term.js';
import { goalPill } from './goal.js';
import { aheadLabel, isScheduled, laterLine, laterPill, laterTip, nextAt, planRows } from './later.js';
import { crewDot, crewFace, memberById, paintCrew, pinJob, underMember } from './crew.js';
import { openUnlisted, pruneSubs, subsUnder } from './lineage.js';
import { backToPlace, goBack, goHome, isSplit, isStacked, keepPlace, paintHead, paintSplit, sidebar, splitOpen } from './split.js';

// A run held near the limit (features/hold.js), on its row: the window, and when it goes by itself.
const heldSub = (s) => (s.held.waiting ? `Waiting for the ${s.held.label.toLowerCase()} reset` : `${s.held.label} window at ${Math.floor(s.held.used * 100)}%`);
const heldTip = (s) => `${s.held.label} window at ${Math.floor(s.held.used * 100)}% · goes by itself ${aheadLabel(s.held.until)}`;

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
export function taskOf(s) {
  const runs = runsOf(s);
  if (runs.length < 2) return s;
  const state = runs.some((r) => r.state === 'waiting') ? 'waiting' : runs.some((r) => r.state === 'running') ? 'running' : runs.every((r) => r.state === 'done') ? 'done' : 'review';
  return {
    ...runs[0],
    key: `g:${s.groupId}${s.archived ? ':a' : ''}`,
    runs,
    state,
    unread: runs.some((r) => r.unread),
    forLater: runs.every((r) => isForLater(r)) ? runs[0].forLater : undefined,
    createdAt: Math.min(...runs.map((r) => r.createdAt)),
    updatedAt: Math.max(...runs.map((r) => r.updatedAt)),
  };
}

// Every task in the feed (or the sidebar), by section and in its order.
export function groups() {
  const every = [];
  const seen = new Set();
  for (const s of visible([...S.sessions.values()])) {
    if (underMember(s)) continue; // a crew job for another task: under its member (crew.js)
    if (s.parentId) continue; // a subagent opened by itself: under its lead (lineage.js)
    const t = taskOf(s);
    if (t.runs && seen.has(t.key)) continue;
    if (t.runs) seen.add(t.key);
    every.push(t);
  }
  // Saved for later: newest saved first. Out of Needs you, Scheduled and Done meanwhile.
  const forLater = every.filter((s) => isForLater(s)).sort((a, b) => b.forLater.at - a.forLater.at);
  const all = every.filter((s) => !s.archived && !isForLater(s));
  // A terminal session with its terminal running is being worked on, by you and its agent.
  const inTerm = (s) => s.tui && s.term && s.state === 'review';
  const needs = all
    .filter((s) => (s.state === 'review' || s.state === 'waiting') && !inTerm(s))
    .sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.updatedAt - a.updatedAt);
  // Working items keep launch order so the feed doesn't reshuffle on every tool call.
  const working = all.filter((s) => s.state === 'running' || inTerm(s)).sort((a, b) => b.createdAt - a.createdAt);
  // Done, with follow-ups still to come: Scheduled, soonest first (later.js).
  const scheduled = all.filter((s) => isScheduled(s)).sort((a, b) => nextAt(a) - nextAt(b));
  const done = all.filter((s) => s.state === 'done' && !isScheduled(s)).sort((a, b) => b.updatedAt - a.updatedAt);
  const archived = every.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  return { needs, working, scheduled, forLater, done, archived };
}

// Done and Archived can hold hundreds of tasks: they show a page of cards and add the next
// page as the user scrolls to the end of the list. The headings count every one.
const PAGE = 60;
const page = { secForLater: PAGE, secDone: PAGE, secArchived: PAGE };
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

// Every section folds from its heading. Done and Archived start folded (and Done remembers),
// the rest start open and remember being folded.
const FOLDS = { secDone: 'showDone', secArchived: 'showArchived' };
export const sectionOpen = (id) => (FOLDS[id] ? !!S[FOLDS[id]] : !S.folded.has(id));
export function toggleSection(id, open = !sectionOpen(id)) {
  if (FOLDS[id]) S[FOLDS[id]] = open;
  else if (open) S.folded.delete(id);
  else S.folded.add(id);
  if (id === 'secDone') save('wisp.showDone', open);
  if (!FOLDS[id]) save('wisp.folded', [...S.folded]);
  renderFeed();
}
function paintFold(sec) {
  const open = sectionOpen(sec.id);
  sec.classList.toggle('collapsed', !open);
  const h = $('h4.sec-toggle', sec);
  if (h.getAttribute('aria-expanded') !== String(open)) h.setAttribute('aria-expanded', String(open));
}

// The cards of `list` in `box`, in order. Only what changed moves: moving a node would blur a
// composer the user is typing in (and replay entrances).
export function placeCards(box, list) {
  const cards = list.flatMap(withSubs);
  cards.forEach((card, i) => {
    if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
  });
  while (box.children.length > cards.length) box.lastElementChild.remove();
}

// A task's card, then the rows of its subagents opened by themselves (lineage.js), nested under it.
const runIds = (t) => (t.runs || [t]).map((r) => r.id);
function withSubs(t) {
  const subs = runIds(t).flatMap(subsUnder);
  return [(t.runs ? taskItem(t) : item(t)).card, ...subs.map((c) => item(c).card)];
}
const subOpen = (t) => runIds(t).some((id) => subsUnder(id).some((c) => S.open.has(c.id)));

// The rows' third line names harnesses and models from the harness list, which can land after
// the first paint (a cold start, the phone's cached page): repaint then, so no row keeps a raw id.
bus.on('agents', () => renderFeed());

export function renderFeed() {
  pruneSubs();
  const { needs, working, scheduled, forLater, done, archived } = groups();
  // extra: rows that aren't tasks (Scheduled's plans), placed among them by their time.
  const place = (sec, list, extra = []) => {
    const box = $('.f-list', sec);
    const show = sectionOpen(sec.id);
    sec.hidden = !list.length && !extra.length;
    paintFold(sec);
    $('h4 .n', sec).textContent = list.length + extra.length || '';
    const cap = page[sec.id] ?? list.length;
    // A folded section in split view keeps the task open beside it: its body hangs off that row.
    const want = show ? list.slice(0, cap) : isSplit() ? list.filter((t) => (t.runs || [t]).some((r) => S.open.has(r.id)) || subOpen(t)) : [];
    const more = $('.f-more', sec);
    if (more) {
      const left = show ? list.length - want.length : 0;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(left, PAGE)} more · ${left} left`;
    }
    const nodes = want.flatMap(withSubs);
    if (show && extra.length) {
      const at = (n) => Number(n.dataset.at) || S.sessions.get(n.dataset.id)?.later?.[0]?.at || 0;
      nodes.push(...extra);
      nodes.sort((a, b) => at(a) - at(b));
    }
    nodes.forEach((card, i) => {
      // Only touch the DOM when the order actually changed: moving a node blurs what's focused in
      // it, so that gets the focus back (the open task's terminal: Working to Needs you as its CLI
      // ends, and the next key would be wisp's shortcut instead of the terminal's).
      if (box.children[i] === card) return;
      const had = card.contains(document.activeElement) ? document.activeElement : null;
      box.insertBefore(card, box.children[i] || null);
      had?.focus({ preventScroll: true });
    });
    while (box.children.length > nodes.length) box.lastElementChild.remove();
  };
  place($('#secNeeds'), needs);
  place($('#secWorking'), working);
  // Scheduled: tasks and reminders that haven't started (rows of their own) and done tasks with
  // follow-ups to come, soonest first.
  const plansShown = planRows();
  place($('#secScheduled'), scheduled, plansShown);
  place($('#secForLater'), forLater);
  // What a crew member filed there unread could go unseen (nothing pings for it): the heading says so.
  const fresh = forLater.filter((s) => s.unread && s.forLater.by === 'crew').length;
  const nw = $('#secForLater .fl-new');
  nw.hidden = !fresh;
  nw.textContent = fresh ? `${fresh} new` : '';
  place($('#secDone'), done);
  place($('#secArchived'), archived);
  paintFold($('#secCrew'));

  // The crew's live jobs, nested under their members.
  const crewShown = paintCrew();
  // Drop nodes for sessions that are gone or filtered out of the feed entirely.
  const tasks = [...needs, ...working, ...scheduled, ...forLater, ...done, ...archived, ...crewShown];
  const shown = new Set(tasks.flatMap((s) => (s.runs || [s]).flatMap((r) => [r.id, ...subsUnder(r.id).map((c) => c.id)])));
  for (const [id, n] of S.nodes) if (!shown.has(id)) (n.card.remove(), S.nodes.delete(id), S.full.delete(id), kept.delete(id));
  const keys = new Set(tasks.map((t) => t.key));
  for (const [key, g] of S.tasks) if (!keys.has(key)) (g.card.remove(), S.tasks.delete(key));

  const empty = !needs.length && !working.length && !scheduled.length && !plansShown.length && !forLater.length && !done.length && !archived.length;
  $('#feedEmpty').hidden = !empty;
  if (empty)
    $('#feedEmpty').innerHTML = `<div class="orb big"><i></i><i></i><i></i></div><p>${S.filter === 'all' ? 'Nothing yet. Describe a task above and send it off.' : 'Nothing in this project yet.'}</p>`;
  placeCollapseAll();

  const n = [...S.sessions.values()].filter(needsYou).length;
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
      if (e.target.closest('[data-a="quick-later"]')) return setForLater(s.id, !isForLater(S.sessions.get(s.id)));
      const choice = e.target.closest('[data-choice]');
      if (choice) return answerInRow(s.id, choice);
      // Split view: a click opens the task beside the list (clicking it again leaves it open) and
      // the list stays where it is: the task shows in the main pane, there's nothing to scroll to.
      setFocus(s.id, { scroll: !isSplit() });
      if (isSplit()) {
        carryDock(s.id);
        if (S.open.has(s.id)) paintSplit();
        // Ready to type the follow-up once it's shown (j / k keep the keys in the list). Not on a
        // page of its own: a phone's keyboard would cover the task it just opened.
        Promise.resolve(S.open.has(s.id) || expand(s.id)).then(() => isStacked() || focusReply(s.id));
        return;
      }
      toggle(s.id);
    });
    card.addEventListener('mousedown', () => {
      if (!s.pending) setFocus(s.id, { scroll: false });
    });
    let hover = 0;
    n.head.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') hover = setTimeout(() => prefetch(s.id), 80);
    });
    n.head.addEventListener('pointerleave', () => {
      clearTimeout(hover);
    });
    // A press comes a tenth of a second or so before its click (on a phone, the only hint there is).
    n.head.addEventListener('pointerdown', () => {
      if (!S.open.has(s.id)) prefetch(s.id);
    });
    n.head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (s.pending || S.sessions.get(s.id)?.parentId) return; // a subagent's row: its lead's menu acts for it
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
      : s.held && s.state === 'review'
        ? `<span class="pill st-held" title="${esc(heldTip(s))}"><i></i>Held</span>`
        : s.reminder && s.state === 'review'
        ? `<span class="pill st-reminder" title="${esc(s.reminder.text)}">${icon('bell')}Reminder</span>`
        : s.state === 'review'
          ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || STATUS_LABEL.done}</span>`
          : '';
  if (runsOf(s).length > 1) return renderRunHead(n, s, { open, live, pill });
  // In Scheduled, the time column is when its follow-up goes (and there's no pill for it).
  const sched = isScheduled(s);
  const swipe = [...n.card.classList].filter((c) => c === 'swiping' || c === 'sw-gone').join(' '); // a refresh mid-swipe (swipe.js) keeps it
  n.card.className = `item ${s.pending ? 'pending' : ''} ${s.parentId ? 'is-sub' : ''} c-${s.color} st-${s.state} ${s.unread ? 'unread' : ''} ${open ? 'open' : ''} ${S.focus === s.id ? 'focused' : ''} ${swipe}`;
  paintHtml(n.head, `
    ${(s.crew && crewDot(s)) || (s.kind === 'reminder' ? `<span class="q-dot auto">${icon('bell')}</span>` : qDot(s))}
    <span class="it-main">
      <span class="it-title" title="${esc(s.title)}">${esc(s.title)}</span>
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open && !isSplit() ? '' : s.held ? `<span class="it-sub" title="${esc(heldTip(s))}">${icon('pause')}${esc(heldSub(s))}</span>` : sched ? `<span class="it-sub${s.later[0].held ? ' held' : ''}" title="${esc(laterTip(s))}">${icon(laterLine(s.later[0])[0])}${esc(laterLine(s.later[0])[1])}</span>` : `<span class="it-sub" title="${esc(s.preview || '')}">${esc(s.preview || '')}</span>`}
      ${runLine(s)}
      ${rowChoices(s, open)}
    </span>
    <span class="it-side">
      ${headPills(s, pill)}
      ${sched ? `<span class="q-time" title="${esc(s.later?.length ? laterTip(s) : heldTip(s))}">${esc(aheadLabel(nextAt(s)))}</span>` : isForLater(s) ? `<span class="q-time" title="${esc(savedTip(s))}">${ago(s.forLater.at)}</span>` : `<span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>`}
      ${s.pending ? '' : slotHtml('card.hover', s)}
      ${quickLater(s, open)}${quickDone(s, open)}
      ${icon('chevron', 'chev')}
    </span>`);
}

// The row's third line: what ran the task and where (harness, model, machine). The machine is
// always named, this computer too, so a list across places reads the same on every row.
function runLine(s) {
  if (!s.agent || s.agent === 'wisp' || s.kind === 'reminder') return '';
  const model = (s.model && agentById(s.agent)?.models?.find((m) => m.id === s.model)?.label) || s.model || 'Default model';
  const where = s.machine?.name || HERE;
  const tip = [agentName(s.agent), model, s.effort && `${effortLabel(s.effort)} thinking`, `on ${where}`].filter(Boolean).join(' · ');
  return `<span class="it-run" title="${esc(tip)}"><i class="ir-logo">${harnessLogo(s.agent)}</i><span class="ir-h">${esc(agentName(s.agent))}</span><span class="ir-m">${esc(model)}</span><span class="ir-w">${icon(s.machine ? 'server' : 'laptop')}<span>${esc(where)}</span></span></span>`;
}

// Every feed render repaints every head: rewrite one only when it would change, so an unchanged
// row keeps its nodes (and the hover under the pointer) and costs no restyle.
function paintHtml(node, html) {
  if (node.dataset.h === html) return;
  node.dataset.h = html;
  node.innerHTML = html;
}

// The phone answers a question from the row: its choices as buttons under the question, so a Yes
// is one tap from the feed (or from the notification that opened it). The open card has the full form.
function rowChoices(s, open) {
  if (!MOBILE || open || s.state !== 'waiting' || !s.options?.length) return '';
  return `<span class="it-choices">${s.options.map((o, i) => `<button class="ghost sm" data-choice="${i}" type="button">${esc(o)}</button>`).join('')}</span>`;
}

// At once: the choices go quiet and the row says it's answered; back as they were if the server refuses.
async function answerInRow(id, b) {
  const s = S.sessions.get(id);
  const text = s?.options?.[b.dataset.choice];
  const box = b.closest('.it-choices');
  if (!text || box.classList.contains('sent')) return;
  box.classList.add('sent');
  b.classList.add('on');
  try {
    await api(`/sessions/${id}/answer`, { method: 'POST', body: { text } });
  } catch (err) {
    box.classList.remove('sent');
    b.classList.remove('on');
    toastError(err);
  }
}

// A task's status mark. One a recipe or trigger started shows its glyph instead of the plain dot
// (the same ones its details show), so automations stand out in the list.
const ORIGIN_ICON = { recipe: 'bolt', trigger: 'replay' };
export function qDot(s, { ring = true } = {}) {
  const ic = ORIGIN_ICON[s.origin?.kind];
  const cls = `q-dot ${ring && s.state === 'running' ? 'live' : ''} ${s.state === 'waiting' ? 'waiting' : ''} ${ic ? 'auto' : ''}`;
  return ic ? `<span class="${cls}" title="${esc(`Started by the ${s.origin.kind} ${s.origin.name || ''}`.trim())}">${icon(ic)}</span>` : `<span class="${cls}"></span>`;
}

// One-click done on review rows. A sidebar row keeps it while open, and rows without one keep its
// space, so every row's pills and time line up and opening a row doesn't move anything. In the app
// a swipe marks done, so rows there keep neither the check nor its space.
function quickDone(s, open) {
  if (swipesDone()) return '';
  if (s.state === 'review' && !s.parentId && !s.archived && (!open || isSplit())) return `<span class="it-quick" data-a="quick-done" title="Mark done (E)" aria-hidden="true">${icon('done')}</span>`; // a pointer shortcut inside the row's button: keys have E, the task's bar has Mark done
  return '<span class="it-quick-gap" aria-hidden="true"></span>';
}

// Save for later beside Mark done: triage is one click either way. Every row keeps its place so
// the columns line up; touch has no hover, so there it isn't drawn at all (feed.css).
function quickLater(s, open) {
  if (s.pending || s.archived || s.parentId || (open && !isSplit())) return '<span class="it-later-gap" aria-hidden="true"></span>'; // a subagent's row: its lead is the task
  if (isForLater(s)) return `<button class="it-later on" data-a="quick-later" title="Unsave (L)" aria-label="Unsave">${icon('bookmark')}</button>`;
  if (s.state === 'review') return `<button class="it-later" data-a="quick-later" title="Save for later (L)" aria-label="Save for later">${icon('bookmark')}</button>`;
  return '<span class="it-later-gap" aria-hidden="true"></span>';
}

// "Saved for later 2h ago" (or who filed it there), for the time column's tooltip.
function savedTip(s) {
  const m = s.forLater.by === 'crew' && memberById(s.crew?.id);
  return `${m ? `Filed for later by ${m.name}` : 'Saved for later'} ${agoLong(s.forLater.at)} · last activity ${agoLong(s.updatedAt)}`;
}

// What a card head says about its task, between the title and the time (the split view's header
// shows the same).
export function headPills(s, pill) {
  return `
      ${termPill(s)}${pill}
      ${laterPill(s)}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${goalPill(s)}${autoPill(s)}${overlapPill(s)}
      ${s.shipping ? shipPill(s) : prOf(s) ? prPill(prOf(s), s.conflictFix) : ''}
      ${s.kind === 'reminder' ? '' : s.team?.length ? teamStack(s.agent, s.team) : modelBadge(s.agent, s.model, s.effort, s.route?.switched ? null : s.route, s.account, crewFace(s))}
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
  return out.join('');
}

// One run inside a compare task: the harness and model stand in for the title the task shows.
function renderRunHead(n, s, { open, live, pill }) {
  const a = S.agents.find((x) => x.id === s.agent);
  const model = (s.model && a?.models?.find((m) => m.id === s.model)?.label) || s.model || 'Default model';
  n.card.className = `item run c-${s.color} st-${s.state} ${s.unread ? 'unread' : ''} ${open ? 'open' : ''} ${S.focus === s.id ? 'focused' : ''}`;
  paintHtml(n.head, `
    <span class="run-logo">${harnessLogo(s.agent)}</span>
    <span class="it-main">
      <span class="it-title"><b>${esc(a?.name || agentName(s.agent))}</b><span class="run-model">${esc(model)}${s.effort ? ` · ${esc(effortLabel(s.effort))}` : ''}</span></span>
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open && !isSplit() ? '' : `<span class="it-sub" title="${esc(s.preview || '')}">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${runsOf(s).some((r) => (r.machine?.id || '') !== (s.machine?.id || '')) ? `${s.machine ? machinePill(s.machine) : `<span class="q-machine" title="Runs on ${esc(HERE)}">${icon('laptop')}<span>${esc(HERE)}</span></span>`}${projectLabel(s)}` : ''}
      ${live && s.state === 'running' ? `<span class="pill st-running"><i></i>Working</span>` : pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${autoPill(s)}
      ${s.shipping ? shipPill(s) : prOf(s) ? prPill(prOf(s), s.conflictFix) : ''}
      <span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>
      ${icon('chevron', 'chev')}
    </span>`);
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
  const autoLine = picked ? `wisp's pick: ${picked.auto.pick.why}` : handed ? `${how} ${runName(handed)}` : '';
  const status = t.state === 'waiting' ? 'A run is asking you' : t.state === 'running' ? `${finished} of ${t.runs.length} finished${places > 1 ? ` · on ${places} machines` : ''}` : t.state === 'done' ? 'Done' : autoLine || (places > 1 ? `All finished on ${places} machines` : 'All finished · pick one to keep');
  g.card.className = `task-item c-${t.color} st-${t.state} ${t.unread ? 'unread' : ''}`;
  paintHtml(g.head, `
    ${qDot(t)}
    <span class="it-main">
      <span class="it-title">${esc(t.title)}</span>
      <span class="it-sub">${esc(status)}</span>
    </span>
    <span class="it-side">
      <button class="ghost xs" data-a="compare" title="Side by side: time, cost, changes, tests and each presentation"><b class="vs-mark">vs</b><span>Compare</span></button>
      ${places > 1 ? '' : projectLabel(t)}
      <span class="q-time">${ago(t.updatedAt)}</span>
      ${t.state === 'review' && !t.archived ? `<button class="it-quick" data-a="quick-done" title="Mark every run done">${icon('done')}</button>` : ''}
    </span>`);
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

// Unless something else took the keys meanwhile (another task opened, the search typed into).
function focusReply(id) {
  if (splitOpen() !== id) return;
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest('.it-head')) return;
  $('.reply', S.nodes.get(id)?.card)?.focus({ preventScroll: true });
}

export function toggle(id) {
  S.open.has(id) ? collapse(id) : expand(id);
}

export async function expand(id, { scroll = true } = {}) {
  const n = S.nodes.get(id);
  if (!n) return;
  // One task at a time, in the main pane (or, stacked, as a page over the list).
  for (const o of [...S.open]) if (o !== id) collapse(o);
  S.open.add(id);
  saveOpen();
  n.card.classList.add('open');
  renderHead(n, S.sessions.get(id));
  // A terminal session the server is still starting: its terminal's waiting screen until the real
  // task takes its place (launcher.js handOver). Nothing to fetch yet.
  const s = S.sessions.get(id);
  if (!n.body && s?.pending) n.body = el(`<div class="it-body"><div class="tui-term"><div class="tm-screen"><div class="tm-wait" aria-live="polite"><span class="tm-wait-l">${esc(s.live || 'Starting up')}…</span><i></i><i></i><i></i><i></i></div></div></div></div>`);
  if (!n.body) n.body = el(`<div class="it-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>`);
  if (!n.body.isConnected) n.card.append(n.body);
  placeCollapseAll();
  paintSplit();
  if (s?.pending) return;
  syncUrl();
  // Closed a moment ago (j/k through the list) or fetched ahead: it shows at once as it was, then
  // the refetch brings what changed meanwhile. A fetch ahead still on its way is waited for.
  if (!S.full.has(id) && fetching.has(id)) {
    await fetching.get(id);
    if (!S.open.has(id)) return; // closed while it came
  }
  const ahead = !S.full.has(id) && kept.get(id);
  if (ahead) (kept.delete(id), S.full.set(id, ahead));
  if (!S.full.has(id)) await fetchFull(id);
  else renderBody(id, { fresh: true });
  backToPlace(id);
  if (ahead) fetchFull(id);
  prefetchAround(id);
}

// Tasks loaded but not open, newest last: the last ones closed, and the ones fetched ahead.
const KEPT_MAX = 12;
const kept = new Map();
function keep(id, s) {
  kept.delete(id);
  kept.set(id, s);
  if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value);
}

// Fetched ahead of the click, so the task opens with nothing to wait for: the row under the pointer
// (after a short hover, not on the way past it), the one pressed, and in split view the rows on
// either side of the open one, where J / K go next. Most tasks are tens of KB.
const fetching = new Map(); // id -> the fetch ahead on its way
function prefetch(id) {
  const s = S.sessions.get(id);
  if (!s || s.pending || S.full.has(id) || kept.has(id) || fetching.has(id)) return;
  const p = api(`/sessions/${id}`)
    .then((full) => S.sessions.has(id) && !S.full.has(id) && keep(id, full))
    .catch(() => {})
    .finally(() => fetching.delete(id));
  fetching.set(id, p);
}
function prefetchAround(id) {
  const card = S.nodes.get(id)?.card;
  if (MOBILE || !isSplit() || !card?.isConnected) return;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  idle(() => {
    for (const x of [card.nextElementSibling, card.previousElementSibling]) if (x?.dataset.id) prefetch(x.dataset.id);
  });
}

export function collapse(id) {
  const n = S.nodes.get(id);
  S.open.delete(id);
  saveOpen();
  if (S.full.has(id)) keep(id, S.full.get(id));
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
  // A folded section only kept its row while it was open.
  if (n?.card.closest('.f-group.collapsed')) renderFeed();
  // Subagent rows leave with their lead: checked once whatever opens next is open.
  else queueMicrotask(() => pruneSubs() && renderFeed());
}

// The address names the open task (#/s/<id>), so a reload or a
// copied link opens it again. Off until route() has read the address the page was loaded with. The
// phone has no address bar: there it's only cleared, so a tapped notification always routes.
let urlOn = false;
export function syncUrl({ start = false } = {}) {
  urlOn ||= start;
  if (!urlOn) return;
  const id = MOBILE ? null : splitOpen();
  const h = location.hash;
  if (id) {
    if (h !== `#/s/${id}`) history.replaceState(history.state, '', `#/s/${id}`);
  } else if (h.startsWith('#/s/')) history.replaceState(history.state, '', location.pathname + location.search); // the phone's Back entries keep their state
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
  bus.emit('task', id);
  if (fresh) backToPlace(id); // it was loading when it opened, or failed and came back
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
  return t.archived ? 'archived' : isForLater(t) ? 'forLater' : t.state === 'running' ? 'working' : isScheduled(t) ? 'scheduled' : t.state === 'done' ? 'done' : 'needs';
};

// Bring an item into view, expanded — used by notifications and links.
export function reveal(id) {
  const sub = S.sessions.get(id);
  if (!sub) return void openUnlisted(id); // a subagent's run, from a link: under its lead
  // A subagent opened by itself sits under its lead: the lead's section and project show it.
  const s = (sub.parentId && S.sessions.get(sub.parentId)) || sub;
  // A crew job for another task opens under the member (Crew unfolded), wherever it is in its life.
  const crew = underMember(s);
  if (crew) pinJob(s.id);
  const sec = crew ? 'secCrew' : { needs: 'secNeeds', working: 'secWorking', scheduled: 'secScheduled', forLater: 'secForLater', done: 'secDone', archived: 'secArchived' }[sectionOf(s)];
  if (!sectionOpen(sec)) toggleSection(sec, true);
  if (S.filter !== 'all' && !inProject(s, S.filter)) {
    S.filter = 'all';
    save('wisp.filter', S.filter);
    renderLaunchChips();
  }
  // A card further down than the pages shown so far: show pages up to it.
  if (sec in page) {
    const { forLater, done, archived } = groups();
    const at = { secForLater: forLater, secDone: done, secArchived: archived }[sec].findIndex((t) => (t.runs || [t]).some((r) => r.id === s.id));
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
}

export const feedIds = () => $$('#feed .item[data-id]:not(.pending)').map((x) => x.dataset.id);

// The user takes a card out of its list (done, archive, delete). Done with the open task is
// done with it: the main pane goes to New task rather than opening whichever row sat next.
// From the list itself, the next card — the one below, or the one above at the end — gets
// focus where the old one sat, so E / A / j triage continues on the same spot. Call before the
// request, while the card is still laid out; the returned function applies the change locally.
export function handOff(id) {
  const card = S.nodes.get(id)?.card;
  if (!card?.isConnected) return (apply) => (apply(), renderFeed());
  const nextUp = (card.nextElementSibling || card.previousElementSibling)?.dataset.id || feedIds().find((x) => x !== id);
  const had = S.open.has(id);
  return (apply) => {
    if (had) collapse(id);
    apply(); // don't wait for the live update to drop the card
    renderFeed();
    // The phone app goes back to the list it came from; elsewhere to New task.
    if (had) return MOBILE ? goBack() : goHome({ focus: !isStacked() }); // no phone keyboard popping up
    if (nextUp && S.nodes.has(nextUp)) setFocus(nextUp);
  };
}
