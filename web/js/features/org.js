// Org: the whole crew on one page, as a chart of who hands work to whom (each member's delegates,
// server/crew.js `team`), and the place to change it. It opens in the main pane like a member's
// thread (stacked: a page over the list, with Back), from the Org button on the Crew section's
// heading or ⌘K.
//
// Members sit in tiers: those nobody delegates to on top, each one's delegates below it (the
// longest path down, a loop drawn back up). Arrows go from a member to its delegates; delegates on
// other harnesses show as logos on the member's card. Select a member and the rest of the chart
// becomes its picker: + on a card makes that one its delegate, ✓ takes it off. With a mouse, drag
// from a card's handle onto another. The column beside the chart (under it on a narrow pane) says
// who it hands work to and gets work from, each with a ×, and adds agents on any harness.
// Every change is one optimistic PATCH of the member's team (patchMember rolls back with a toast).
//
// Spells reach it through spell-schema.js: the org.head slot, the crew.org, org.* parts.

import { esc } from '../md.js';
import { $, $$, beforePaint, el, icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast } from '../ui/toast.js';
import { collapse, renderFeed } from './feed.js';
import { goBack, isSplit, isStacked, splitOpen } from './split.js';
import { avatarHtml, crewEditor, crewHooks, crewList, leaveCrew, memberById, memberMenu, memberState, openMember, patchMember, rankCrew, statusLine } from './crew.js';
import { agentName, harnessLogo } from './runners.js';
import { memberLabel, teamEditor } from './team.js';
import { placeName } from './places.js';
import { slotHtml } from './spells.js';

const MAX_TEAM = 6; // a member's delegates (rows), as the server allows
const MAX_INSTANCES = 12; // parallel copies across them
const WIDE = 860; // the details beside the chart from this pane width

S.orgOpen = load('wisp.orgOpen', false);
let sel = load('wisp.orgSel', null); // the member whose delegates the chart is picking
let drag = null; // { from, x, y, over }: a link being drawn from a card's handle
let view = null;

const setSel = (id) => {
  sel = id;
  save('wisp.orgSel', id);
};

// --- opening and closing --------------------------------------------------------------------------

// id: a member to select (its delegates line, Delegates… in its menu).
export function openOrg(id = null) {
  crewHooks.leave = leaveOrg;
  if (id && memberById(id)) setSel(id);
  leaveCrew();
  for (const id of [...S.open]) collapse(id);
  S.orgOpen = true;
  save('wisp.orgOpen', true);
  renderFeed(); // the list's selection, then the pane (paintSplit → paintOrg)
  requestAnimationFrame(() => $('.org-view .org-chart')?.focus({ preventScroll: true }));
}

export function leaveOrg() {
  if (!S.orgOpen) return;
  S.orgOpen = false;
  save('wisp.orgOpen', false);
}

// Shown while nothing else has the pane: opening a task or a member closes it.
export const orgShown = () => isSplit() && S.orgOpen && !splitOpen() && !S.crewOpen;

// A member opened from here: Back (Esc, ×) comes back to the chart, that member still selected.
function openFrom(id) {
  openMember(id);
  crewHooks.back = () => openOrg();
}

// --- the chart's shape -----------------------------------------------------------------------------

// Who hands work to whom, among members that exist: a delegate that left the crew is no arrow.
function graph(list) {
  const ids = new Set(list.map((m) => m.id));
  const out = new Map(list.map((m) => [m.id, (m.team || []).filter((t) => t.crew && t.crew !== m.id && ids.has(t.crew)).map((t) => t.crew)]));
  const inc = new Map(list.map((m) => [m.id, []]));
  for (const [a, bs] of out) for (const b of bs) inc.get(b).push(a);
  return { out, inc };
}

// Tiers, top down: a member sits one below the deepest member that delegates to it (a loop's way
// back up is ignored). Within a tier, under the members that delegate to it, so arrows cross less.
// Members with no arrows at all are left out, for their own row.
function tiers(list, { out, inc }) {
  const linked = list.filter((m) => out.get(m.id).length || inc.get(m.id).length);
  const depth = new Map();
  const path = new Set();
  const visit = (id, d) => {
    if (path.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    path.add(id);
    for (const b of out.get(id)) visit(b, d + 1);
    path.delete(id);
  };
  for (const m of linked) if (!inc.get(m.id).length) visit(m.id, 0);
  // A loop with nobody above it: its first member leads.
  for (const m of linked) if (!depth.has(m.id)) visit(m.id, 0);
  const rows = [];
  for (const m of linked) (rows[depth.get(m.id)] ||= []).push(m);
  const at = new Map();
  return rows.filter(Boolean).map((row, t) => {
    const mean = (m) => {
      const up = inc.get(m.id).filter((x) => at.has(x));
      return up.length ? up.reduce((n, x) => n + at.get(x), 0) / up.length : Infinity;
    };
    const keyed = row.map((m, i) => ({ m, i, k: t ? mean(m) : i }));
    keyed.sort((a, b) => a.k - b.k || a.i - b.i);
    keyed.forEach((x, i) => at.set(x.m.id, i));
    return keyed.map((x) => x.m);
  });
}

// --- painting ---------------------------------------------------------------------------------------

function build() {
  const node = el(`<section class="org-view" id="orgView" hidden>
      <header class="cv-top org-top"></header>
      <div class="org-body">
        <div class="org-chart" tabindex="-1">
          <p class="org-hint"></p>
          <div class="org-graph">
            <svg class="org-edges" aria-hidden="true"></svg>
            <div class="org-tiers"></div>
          </div>
        </div>
        <aside class="org-side"></aside>
      </div>
    </section>`);
  const graphBox = $('.org-graph', node);
  new ResizeObserver(() => beforePaint(drawEdges)).observe(graphBox);
  node.addEventListener('click', onClick);
  node.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.org-card');
    if (card && !e.target.closest('button')) openFrom(card.dataset.m);
  });
  node.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.org-card');
    if (!card) return;
    e.preventDefault();
    memberMenu(card.dataset.m, { x: e.clientX, y: e.clientY });
  });
  node.addEventListener('keydown', onKey);
  node.addEventListener('pointerdown', onPointerDown);
  return { node };
}

export function paintOrg() {
  // Something else took the pane (a task, a member): the chart goes.
  if (S.orgOpen && isSplit() && (splitOpen() || S.crewOpen)) leaveOrg();
  const on = orgShown();
  paintButton();
  if (!on) {
    if (view) view.node.hidden = true;
    return;
  }
  view ||= build();
  const { node } = view;
  if (node.parentNode !== $('#splitMain')) $('#splitMain').append(node);
  node.hidden = false;
  const list = crewList();
  if (sel && !memberById(sel)) setSel(null);
  const g = graph(list);
  paintWide();
  node.classList.toggle('picking', !!sel);
  paintTop(list, g);
  paintHint();
  paintTiers(list, g);
  paintSide(list, g);
  beforePaint(drawEdges);
}

// The Org button on the Crew heading: there once someone's on the crew, pressed while it's open.
function paintButton() {
  const b = $('#secCrew .cr-org');
  if (!b) return;
  b.hidden = !crewList().length;
  b.classList.toggle('on', orgShown());
  b.setAttribute('aria-pressed', orgShown());
}

function paintTop(list, g) {
  const links = [...g.out.values()].reduce((n, x) => n + x.length, 0);
  const tools = list.reduce((n, m) => n + (m.team || []).filter((t) => !t.crew).length, 0);
  const stacked = isStacked();
  const sub = list.length ? [`${list.length} member${list.length > 1 ? 's' : ''}`, links ? `${links} link${links > 1 ? 's' : ''}` : 'no links yet', tools ? `${tools} agent${tools > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') : '';
  const html = `${stacked ? `<button class="icon-btn sh-back" data-a="close" title="Back to tasks" aria-label="Back to tasks">${icon('back')}</button>` : ''}
    <span class="org-ic">${icon('org')}</span>
    <div class="cv-who"><h2 class="sh-title">Org</h2><span class="cv-role">Who hands work to whom</span></div>
    <span class="cv-state">${esc(sub)}</span>
    <span class="sh-acts">
      ${slotHtml('org.head', null)}
      <button class="ghost sm" data-a="add" title="Add a crew member">${icon('plus')}<span>Add member</span></button>
      ${stacked ? '' : `<button class="icon-btn" data-a="close" title="Close: back to New task (Esc)" aria-label="Close">${icon('x')}</button>`}
    </span>`;
  const top = $('.org-top', view.node);
  if (top.dataset.h !== html) (top.innerHTML = html), (top.dataset.h = html);
}

function paintHint() {
  const m = sel && memberById(sel);
  const touch = matchMedia('(pointer: coarse)').matches;
  const text = drag
    ? `Drop on a member to make them <b>${esc(memberById(drag.from)?.name || '')}</b>’s delegate.`
    : m
      ? m.spell
        ? `The “${esc(m.spell.name)}” spell sets who <b>${esc(m.name)}</b> hands work to.`
        : `Choosing <b>${esc(m.name)}</b>’s delegates: ${icon('plus')} adds a member, ${icon('check')} takes them off${(m.team || []).length < MAX_TEAM ? ` · <button class="link xs" data-a="add-to">Add a delegate…</button>` : ''}${touch ? '' : ' · Esc when done'}`
      : crewList().length
        ? `Arrows go from a member to their delegates. Select one to change who they hand work to${touch ? '' : ', or drag from one’s handle onto another'}.`
        : '';
  const hint = $('.org-hint', view.node);
  if (hint.dataset.h !== text) (hint.innerHTML = `<span>${text}</span>`), (hint.dataset.h = text);
  hint.hidden = !text;
  hint.classList.toggle('on', !!m || !!drag);
}

// Other harnesses a member delegates to, as logos on its card.
function toolsHtml(m) {
  const tools = (m.team || []).filter((t) => !t.crew);
  if (!tools.length) return '';
  const shown = tools.slice(0, 3);
  const tip = tools.map((t) => memberLabel(t)).join('\n');
  return `<span class="org-tools" title="${esc(`Also hands work to:\n${tip}`)}">${shown.map((t) => `<span class="org-tool">${harnessLogo(t.agent)}${(t.count || 1) > 1 ? `<small>×${t.count}</small>` : ''}</span>`).join('')}${tools.length > shown.length ? `<small>+${tools.length - shown.length}</small>` : ''}</span>`;
}

function cardHtml(m, st) {
  const line = statusLine(m, st);
  return `${avatarHtml(m, { size: 36 })}
    <span class="org-who"><b>${esc(m.name)}</b><small>${esc(m.role || 'Crew member')}</small></span>
    <span class="org-st ${line.cls}" title="${esc(line.text)}">${esc(line.text)}</span>
    ${toolsHtml(m)}`;
}

function paintTiers(list, g) {
  const box = $('.org-tiers', view.node);
  const ranked = rankCrew(list);
  const rows = tiers(ranked, g);
  const alone = ranked.filter((m) => !g.out.get(m.id).length && !g.inc.get(m.id).length);
  const want = rows.map((row, i) => ({ key: `t${i}`, list: row }));
  if (alone.length) want.push({ key: 'alone', list: alone });
  if (!list.length) want.push({ key: 'empty', list: [] });
  const picks = new Set(sel ? g.out.get(sel) || [] : []);
  const near = new Set(sel ? [sel, ...picks, ...(g.inc.get(sel) || [])] : []);
  const lead = sel && memberById(sel);
  const cards = new Map($$('.org-card', box).map((c) => [c.dataset.m, c]));
  want.forEach((w, i) => {
    let tier = box.children[i];
    if (tier?.dataset.key !== w.key) {
      tier = $$(':scope > .org-tier', box).find((x) => x.dataset.key === w.key) || tierNode(w.key);
      box.insertBefore(tier, box.children[i] || null);
    }
    const row = $('.org-row-cards', tier) || tier;
    w.list.forEach((m, j) => {
      let card = cards.get(m.id);
      if (!card) {
        card = el(`<div class="org-card" data-m="${esc(m.id)}" role="button" tabindex="0"><div class="org-face"></div><button class="org-pick" type="button"></button><span class="org-port" aria-hidden="true"></span></div>`);
        cards.set(m.id, card);
      }
      const st = memberState(m);
      const html = cardHtml(m, st);
      // The spirit stays (its animation keeps going); only the words around it change.
      const h = html.replace(/<svg[\s\S]*?<\/svg>/, `[${st.mood}:${m.avatar}:${m.color}:${st.asks}:${st.unread}]`);
      const face = $('.org-face', card);
      if (face.dataset.h !== h) (face.innerHTML = html), (face.dataset.h = h);
      const picked = picks.has(m.id);
      const canPick = !!lead && m.id !== sel && !lead.spell;
      card.classList.toggle('sel', m.id === sel);
      card.classList.toggle('picked', picked);
      card.classList.toggle('can-pick', canPick);
      card.classList.toggle('dim', !!sel && !near.has(m.id));
      card.classList.toggle('paused', !!m.paused);
      card.classList.toggle('locked', !!m.spell);
      card.setAttribute('aria-pressed', m.id === sel);
      card.title = m.id === sel ? `${m.name}: double-click to open their thread` : `${m.name}${m.role ? ` · ${m.role}` : ''}: select to choose their delegates`;
      const pick = $('.org-pick', card);
      pick.hidden = !canPick;
      if (canPick) {
        const label = picked ? `Remove ${m.name} from ${lead.name}’s delegates` : `Make ${m.name} ${lead.name}’s delegate`;
        const glyph = picked ? 'check' : 'plus';
        if (pick.dataset.g !== glyph) (pick.innerHTML = icon(glyph)), (pick.dataset.g = glyph);
        pick.title = label;
        pick.setAttribute('aria-label', label);
        pick.setAttribute('aria-pressed', picked);
      }
      $('.org-port', card).title = `Drag onto another member: they become ${m.name}’s delegate`;
      // Moved only when its place changed: re-inserting restarts the spirit.
      if (row.children[j] !== card) row.insertBefore(card, row.children[j] || null);
      cards.delete(m.id);
    });
    while (row.children.length > w.list.length) row.lastElementChild.remove();
  });
  while (box.children.length > want.length) box.lastElementChild.remove();
}

function tierNode(key) {
  if (key === 'empty')
    return el(`<div class="org-tier org-empty" data-key="empty">
        <p><b>No crew yet.</b> Add someone, then give them delegates: other crew members, or agents on any harness, that their jobs can hand work to.</p>
        <button class="primary sm" data-a="add">${icon('plus')}Add a crew member</button>
      </div>`);
  if (key === 'alone')
    return el(`<div class="org-tier org-alone" data-key="alone"><h5>Not connected</h5><div class="org-row-cards"></div></div>`);
  return el(`<div class="org-tier" data-key="${key}"></div>`);
}

// Arrows from each member to its crew delegates, measured from the cards where they landed. They
// never pass behind a card: down from the member, along the gap above the next row of cards, down
// that row's nearest opening between cards, and so on to the gap above the delegate, then into its
// top. A loop (a delegate in the same row or above) leaves downwards and comes back up into the
// delegate's bottom, round the side when rows are in the way. Corners are rounded. The selected
// member's in and out arrows light up.
const MARGIN = 8; // clearance kept around a card
function rows(rects) {
  const out = [];
  for (const r of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const row = out.find((x) => Math.abs(x.top - r.top) < 4);
    if (row) row.cards.push(r), (row.bottom = Math.max(row.bottom, r.bottom));
    else out.push({ top: r.top, bottom: r.bottom, cards: [r] });
  }
  for (const row of out) row.cards.sort((a, b) => a.left - b.left);
  return out;
}
// Where a vertical line at x may cross a row: x itself when it's clear of every card, else the
// opening (between two cards, or past either end) that keeps the way to `to` shortest.
function channel(row, x, to) {
  if (!row.cards.some((c) => x > c.left - MARGIN && x < c.right + MARGIN)) return x;
  const c = row.cards;
  const gaps = [c[0].left - 14, c.at(-1).right + 14];
  for (let i = 1; i < c.length; i++) gaps.push((c[i - 1].right + c[i].left) / 2);
  return gaps.reduce((best, g) => (Math.abs(x - g) + Math.abs(g - to) < Math.abs(x - best) + Math.abs(best - to) ? g : best));
}
function route(a, b, all) {
  const pts = [[a.x, a.bottom]];
  // Members side by side get their own lane in a gap, so two leads' arrows never share a line.
  const mine = all.find((r) => Math.abs(r.top - a.top) < 4);
  const lane = mine ? ((mine.cards.findIndex((c) => Math.abs((c.left + c.right) / 2 - a.x) < 1) % 3) - 1) * 7 : 0;
  if (b.top > a.bottom + 4) {
    // Down: through each row between them, then the gap above the delegate's row.
    const between = all.filter((r) => r.top >= a.bottom - 1 && r.bottom <= b.top + 1);
    let x = a.x;
    let y = a.bottom;
    for (const r of between) {
      const gy = (y + r.top) / 2 + lane;
      const nx = channel(r, x, b.x);
      if (nx !== x) pts.push([x, gy], [nx, gy]);
      x = nx;
      y = r.bottom;
    }
    const gy = (y + b.top) / 2 + lane;
    pts.push([x, gy], [b.x, gy], [b.x, b.top - 2]);
  } else {
    // A loop: out of the bottom, under the member's row, up into the delegate's bottom.
    const under = all.find((r) => r.top <= a.bottom && r.bottom >= a.bottom - 1);
    const y1 = (under?.bottom ?? a.bottom) + 18;
    // A delegate in a row above: the member's own row is in the way back up, so round the side.
    if (b.bottom <= a.top + 1) {
      const side = Math.min(...all.flatMap((r) => r.cards.map((c) => c.left))) - 20;
      pts.push([a.x, y1], [side, y1], [side, b.bottom + 18]);
    } else pts.push([a.x, y1]);
    pts.push([b.x, pts.at(-1)[1] === y1 ? y1 : b.bottom + 18], [b.x, b.bottom + 2]);
  }
  return rounded(pts);
}
function rounded(raw, r = 8) {
  const pts = raw.filter((p, i) => !i || Math.abs(p[0] - raw[i - 1][0]) + Math.abs(p[1] - raw[i - 1][1]) > 0.5);
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    const k1 = Math.min(r, Math.hypot(x - px, y - py) / 2);
    const k2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
    const u = (dx, dy) => Math.hypot(dx, dy) || 1;
    const ax = x - ((x - px) / u(x - px, y - py)) * k1;
    const ay = y - ((y - py) / u(x - px, y - py)) * k1;
    const bx = x + ((nx - x) / u(nx - x, ny - y)) * k2;
    const by = y + ((ny - y) / u(nx - x, ny - y)) * k2;
    d += `L${ax} ${ay}Q${x} ${y},${bx} ${by}`;
  }
  const last = pts.at(-1);
  return `${d}L${last[0]} ${last[1]}`;
}

function drawEdges() {
  if (!view || view.node.hidden) return;
  const g = $('.org-graph', view.node);
  const svg = $('.org-edges', view.node);
  const box = g.getBoundingClientRect();
  const rel = (r) => ({ left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top });
  const at = new Map($$('.org-card', g).map((c) => [c.dataset.m, rel(c.getBoundingClientRect())]));
  const all = rows([...at.values()]);
  const pos = (r) => ({ x: (r.left + r.right) / 2, top: r.top, bottom: r.bottom });
  const paths = [];
  for (const m of crewList())
    for (const t of m.team || []) {
      if (!t.crew || !at.has(m.id) || !at.has(t.crew) || t.crew === m.id) continue;
      const d = route(pos(at.get(m.id)), pos(at.get(t.crew)), all);
      const on = sel && (m.id === sel || t.crew === sel);
      // A member on another machine: its jobs there can't reach the crew here (server/crew.js #teamFor).
      const off = !!m.machine;
      const tip = `${m.name} → ${memberById(t.crew)?.name || t.name}${off ? ` (runs on ${placeName(m.machine)}: its jobs there can’t reach the crew here)` : ''}`;
      paths.push(`<g class="org-edge${on ? ' on' : ''}${off ? ' off' : ''}${sel && !on ? ' dim' : ''}" data-from="${esc(m.id)}" data-to="${esc(t.crew)}"><title>${esc(tip)}</title><path class="org-hit" d="${d}"/><path class="org-line" d="${d}" marker-end="url(#orgArr${on ? 'On' : ''})"/></g>`);
    }
  if (drag) paths.push(`<path class="org-temp" d="M${drag.x0 - box.left} ${drag.y0 - box.top}L${drag.x - box.left} ${drag.y - box.top}"/>`);
  const html = `<defs>
      <marker id="orgArr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="org-arr" d="M0 0L8 4L0 8z"/></marker>
      <marker id="orgArrOn" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="org-arr on" d="M0 0L8 4L0 8z"/></marker>
    </defs>${paths.join('')}`;
  svg.setAttribute('width', g.scrollWidth);
  svg.setAttribute('height', g.scrollHeight);
  if (svg.dataset.h !== html) (svg.innerHTML = html), (svg.dataset.h = html);
}

// --- the details column -------------------------------------------------------------------------------

function paintSide(list, g) {
  const side = $('.org-side', view.node);
  const m = sel && memberById(sel);
  const html = m ? memberSide(m, g) : overview(list, g);
  // Faces compared by who and mood, so a spirit isn't restarted by a repaint that changed nothing.
  const key = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
  if (side.dataset.h !== key) (side.innerHTML = html), (side.dataset.h = key);
}

function overview(list, g) {
  const leads = list.filter((m) => g.out.get(m.id).length);
  return `<div class="cv-sec org-sec">
      <h5>How it works</h5>
      <p>A member’s <b>delegates</b> are who their jobs can hand work to: other crew members, or agents on any harness and model. Each arrow is one.</p>
    </div>
    ${leads.length ? `<div class="cv-sec org-sec"><h5>Hand out work</h5><div class="org-rows">${leads.map((x) => personRow(x, { sub: `${g.out.get(x.id).length} delegate${g.out.get(x.id).length > 1 ? 's' : ''}` })).join('')}</div></div>` : ''}
    <div class="cv-sec org-sec org-note"><p>${icon('info')}<span>A job that was itself delegated works alone: it can’t pass the work on to another crew member, so members never hand work round in circles.</span></p></div>`;
}

// One person in a list: their face and name (selects them), and maybe a × that unlinks.
function personRow(m, { sub = m.role || '', unlink = '' } = {}) {
  return `<div class="org-row">
      <button class="org-person" data-pick="${esc(m.id)}" title="Select ${esc(m.name)}">${avatarHtml(m, { size: 22, dot: false })}<span><b>${esc(m.name)}</b><small>${esc(sub)}</small></span></button>
      ${unlink ? `<button class="icon-btn org-x" ${unlink} >${icon('x')}</button>` : ''}
    </div>`;
}

function memberSide(m, g) {
  const st = memberState(m);
  const line = statusLine(m, st);
  const locked = !!m.spell;
  const team = m.team || [];
  const crew = team.filter((t) => t.crew && memberById(t.crew));
  const tools = team.map((t, i) => ({ t, i })).filter(({ t }) => !t.crew);
  const from = (g.inc.get(m.id) || []).map(memberById).filter(Boolean);
  const full = team.length >= MAX_TEAM || team.reduce((n, t) => n + (t.count || 1), 0) >= MAX_INSTANCES;
  const out = [
    ...crew.map((t) => personRow(memberById(t.crew), { unlink: locked ? '' : `data-unlink="${esc(m.id)}:${esc(t.crew)}" title="Remove ${esc(memberById(t.crew).name)} from ${esc(m.name)}’s delegates" aria-label="Remove ${esc(memberById(t.crew).name)}"` })),
    ...tools.map(
      ({ t, i }) => `<div class="org-row">
        <span class="org-person tool"><span class="org-logo">${harnessLogo(t.agent)}</span><span><b>${esc(agentName(t.agent))}${(t.count || 1) > 1 ? ` ×${t.count}` : ''}</b><small>${esc(t.use || memberLabel(t))}</small></span></span>
        ${locked ? '' : `<button class="icon-btn org-x" data-tool="${i}" title="Remove ${esc(agentName(t.agent))}" aria-label="Remove ${esc(agentName(t.agent))}">${icon('x')}</button>`}
      </div>`,
    ),
  ].join('');
  const notes = [
    locked ? `${icon('wizard')}<span>The “${esc(m.spell.name)}” spell sets who ${esc(m.name)} hands work to.</span>` : '',
    m.machine && crew.length ? `${icon('server')}<span>${esc(m.name)} runs on ${esc(placeName(m.machine))}: jobs there can’t reach the crew here, only other agents.</span>` : '',
    crew.length && from.length ? `${icon('info')}<span>When someone delegates to ${esc(m.name)}, that job works alone: delegated jobs don’t pass work on to the crew.</span>` : '',
  ].filter(Boolean);
  return `<div class="org-me">
      ${avatarHtml(m, { size: 40 })}
      <div class="org-who"><b>${esc(m.name)}</b><small>${esc(m.role || 'Crew member')}</small></div>
      <button class="icon-btn" data-a="more" title="More" aria-label="More">${icon('dots')}</button>
    </div>
    <p class="org-st ${line.cls}">${esc(line.text)}</p>
    <div class="org-acts">
      <button class="ghost sm" data-a="open">${icon('crew')}<span>Open thread</span></button>
      <button class="ghost sm" data-a="edit">${icon('pen')}<span>Edit…</span></button>
    </div>
    <div class="cv-sec org-sec">
      <h5>Hands work to <small>${team.length} of ${MAX_TEAM}</small></h5>
      ${out ? `<div class="org-rows">${out}</div>` : `<p class="org-none">Nobody yet${locked ? '' : ': pick members in the chart, or add an agent'}.</p>`}
      ${locked ? '' : `<button class="ghost xs org-addto" data-a="add-to" ${full ? `disabled title="${esc(m.name)} has as many delegates as a job can take"` : ''}>${icon('plus')}<span>Add a delegate…</span></button>`}
    </div>
    <div class="cv-sec org-sec">
      <h5>Gets work from</h5>
      ${from.length ? `<div class="org-rows">${from.map((x) => personRow(x, { unlink: x.spell ? '' : `data-unlink="${esc(x.id)}:${esc(m.id)}" title="Stop ${esc(x.name)} handing work to ${esc(m.name)}" aria-label="Unlink ${esc(x.name)}"` })).join('')}</div>` : `<p class="org-none">Nobody on the crew. Any task can still hand them work with @${esc(m.name)}.</p>`}
    </div>
    ${notes.length ? `<div class="cv-sec org-sec org-note">${notes.map((n) => `<p>${n}</p>`).join('')}</div>` : ''}`;
}

// --- changing it ---------------------------------------------------------------------------------------

function link(fromId, toId) {
  const m = memberById(fromId);
  const c = memberById(toId);
  if (!m || !c || fromId === toId) return;
  if (m.spell) return toast(`The “${esc(m.spell.name)}” spell sets who ${esc(m.name)} hands work to.`, { tone: 'bad' });
  const team = m.team || [];
  if (team.some((t) => t.crew === toId)) return;
  if (team.length >= MAX_TEAM || team.reduce((n, t) => n + (t.count || 1), 0) >= MAX_INSTANCES)
    return toast(`${esc(m.name)} has as many delegates as a job can take: remove one first.`, { tone: 'bad' });
  patchMember(m, { team: [...team, { crew: c.id, name: c.name, label: c.name, role: c.role, agent: c.agent, use: c.role || '', count: 1 }] });
}

function unlink(fromId, toId) {
  const m = memberById(fromId);
  if (!m || m.spell) return;
  patchMember(m, { team: (m.team || []).filter((t) => t.crew !== toId) });
}

function dropTool(m, i) {
  patchMember(m, { team: (m.team || []).filter((_, k) => k !== i) });
}

// Add a delegate: another crew member, or an agent on any harness (the Delegate editor).
function addMenu(m, anchor) {
  const free = rankCrew(crewList().filter((c) => c.id !== m.id && !(m.team || []).some((t) => t.crew === c.id)));
  $('.menu.org-menu')?.close();
  const menu = el(`<div class="menu org-menu">
      ${free.map((c) => `<button data-c="${esc(c.id)}">${avatarHtml(c, { size: 18, dot: false })}<span>${esc(c.name)}${c.role ? ` <small>${esc(c.role)}</small>` : ''}</span></button>`).join('')}
      ${free.length ? '<hr>' : ''}
      <button data-a="agent">${icon('agent')}<span>An agent on any harness…</span></button>
    </div>`);
  const close = popover(menu, { anchor });
  menu.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    close();
    if (b.dataset.c) return link(m.id, b.dataset.c);
    teamEditor(anchor, { lead: m.agent || 'auto', leadModel: m.model, leadEffort: m.effort, team: m.team || [], places: [m.machine || ''], exclude: m.id }, (team) => {
      patchMember(m, { team });
    });
  };
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6 + menu.offsetHeight > innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6}px`;
}

function select(id) {
  setSel(id === sel ? null : id);
  paintOrg();
}

function onClick(e) {
  const a = e.target.closest('[data-a]')?.dataset.a;
  const m = sel && memberById(sel);
  if (a === 'close') return goBack({ focus: true });
  if (a === 'add') return crewEditor();
  if (m && a === 'open') return openFrom(m.id);
  if (m && a === 'edit') return crewEditor({ member: m });
  if (m && a === 'more') return memberMenu(m.id, { anchor: e.target.closest('[data-a]') });
  if (m && a === 'add-to') return addMenu(m, e.target.closest('[data-a]'));

  const un = e.target.closest('[data-unlink]')?.dataset.unlink;
  if (un) {
    const [from, to] = un.split(':');
    return unlink(from, to);
  }
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (m && tool !== undefined) return dropTool(m, Number(tool));
  const who = e.target.closest('[data-pick]')?.dataset.pick;
  if (who) {
    setSel(who);
    return paintOrg();
  }
  const card = e.target.closest('.org-card');
  if (card && e.target.closest('.org-pick')) {
    const to = card.dataset.m;
    return (m?.team || []).some((t) => t.crew === to) ? unlink(sel, to) : link(sel, to);
  }
  if (card) return select(card.dataset.m);
  const edge = e.target.closest('.org-edge');
  if (edge) return select(edge.dataset.from === sel ? edge.dataset.to : edge.dataset.from);
  // The chart's empty space: back to the whole org.
  if (sel && e.target.closest('.org-chart')) select(null);
}

// Esc (keys.js): a link being drawn goes, then picking ends, before the page closes. True when it did.
export function orgEscape() {
  if (!orgShown()) return false;
  if (drag) return endDrag(), true;
  if (!sel) return false;
  const was = sel;
  select(null);
  $(`.org-card[data-m="${was}"]`, view.node)?.focus({ preventScroll: true });
  return true;
}

function onKey(e) {
  const card = e.target.closest('.org-card');
  if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    if (sel && sel !== card.dataset.m && card.classList.contains('can-pick')) return $('.org-pick', card).click();
    select(card.dataset.m);
  }
}

// Drag from a card's handle onto another card: a link, drawn as it goes.
function onPointerDown(e) {
  const port = e.target.closest('.org-port');
  if (!port || e.button !== 0) return;
  const from = port.closest('.org-card').dataset.m;
  if (memberById(from)?.spell) return;
  e.preventDefault();
  const r = port.getBoundingClientRect();
  drag = { from, x0: r.left + r.width / 2, y0: r.top + r.height / 2, x: e.clientX, y: e.clientY, over: null };
  view.node.classList.add('dragging');
  port.setPointerCapture(e.pointerId);
  const move = (ev) => {
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    const card = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.org-card');
    const to = card && card.dataset.m !== from ? card.dataset.m : null;
    if (to !== drag.over) {
      $$('.org-card.drop', view.node).forEach((c) => c.classList.remove('drop', 'no'));
      drag.over = to;
      if (card && to) card.classList.add('drop', (memberById(from)?.team || []).some((t) => t.crew === to) ? 'no' : 'ok');
    }
    drawEdges();
  };
  const up = () => {
    port.removeEventListener('pointermove', move);
    const to = drag?.over;
    endDrag();
    if (to) link(from, to);
  };
  port.addEventListener('pointermove', move);
  port.addEventListener('pointerup', up, { once: true });
  port.addEventListener('pointercancel', endDrag, { once: true });
  paintHint();
}

function endDrag() {
  if (!drag) return;
  drag = null;
  view.node.classList.remove('dragging');
  $$('.org-card.drop', view.node).forEach((c) => c.classList.remove('drop', 'no', 'ok'));
  paintHint();
  drawEdges();
}

// The Org button on the Crew heading (index.html).
$('#secCrew .cr-org')?.addEventListener('click', () => {
  if (orgShown()) goBack({ focus: true });
  else openOrg();
});
// The details beside the chart on a wide pane, under it otherwise: follows the pane, not the window.
function paintWide() {
  if (view && !view.node.hidden) view.node.classList.toggle('wide', $('#splitMain').clientWidth >= WIDE);
}
new ResizeObserver(paintWide).observe($('#splitMain'));
