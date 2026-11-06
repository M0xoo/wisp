// Home's overview (design/today.md): under the prompt box, what's going on. Home and New task are
// two pages of #splitHome (split.js): one prompt box, tips and panes, so a draft is simply still
// there. These sections show on Home only.
//
// A task's row is its own node, kept through every repaint: paintToday runs after every feed
// render, on each tool call of every task, so only the cell that changed is written and a spirit
// never repaints (nor an animation replays) because a clock moved.

import { esc } from '../md.js';
import { $, el } from '../core/dom.js';
import { ago, fmtDate, SHORT_TIME, STATUS_LABEL, statusKey, timeAttrs } from '../core/format.js';
import { load, needsYou, S, save } from '../core/state.js';
import { isAsk, openPr, plansLine, plansOf, quietFor, sentenceOf, stageOf, STAGES } from '../today.js';
import { avatarHtml, crewDot, memberById, underMember } from './crew.js';
import { groups, qDot } from './feed.js';
import { aheadLabel } from './later.js';
import { agentName, harnessLogo } from './runners.js';
import { openSettings } from './settings.js';
import { slotHtml, spellProp } from './spells.js';

const CARDS = 6;
const ROWS = 12;

const put = (node, html) => {
  if (node.dataset.h === html) return;
  node.dataset.h = html;
  node.innerHTML = html;
};
const show = (node, on) => {
  if (node.hidden === on) node.hidden = !on;
};
const flag = (node, on) => {
  if (node.getAttribute('aria-expanded') !== String(on)) node.setAttribute('aria-expanded', on);
};
const say = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};

// rows: [{ key, id, cls, cells: [html, …] }], in order. shell(row) makes a new one. Nodes in place
// stay in place; only a row that came or moved is inserted, only a cell that changed is written.
function syncRows(box, rows, shell) {
  const old = new Map([...box.children].map((n) => [n.dataset.k, n]));
  let at = box.firstElementChild;
  for (const r of rows) {
    let n = old.get(r.key);
    old.delete(r.key);
    if (!n) {
      n = el(shell(r));
      n.dataset.k = r.key;
    }
    if (n === at) at = at.nextElementSibling;
    else box.insertBefore(n, at);
    if (n.dataset.id !== r.id) n.dataset.id = r.id;
    if (n.className !== r.cls) n.className = r.cls;
    r.cells.forEach((html, i) => put(n.children[i], html));
  }
  for (const n of old.values()) n.remove();
}
const cells = (n) => Array.from({ length: n }, () => '<span class="td-c"></span>').join('');

// Who's on it: the crew member's face, or the harness.
function who(s, mood) {
  const m = s.crew && memberById(s.crew.id);
  const name = m ? m.name : agentName(s.agent);
  const face = m ? avatarHtml(m, { size: 22, state: mood, dot: false }) : `<span class="model-logo">${harnessLogo(s.agent)}</span>`;
  return `<span class="td-by"><span class="td-face">${face}</span><span class="td-who" title="${esc(name)}">${esc(name)}</span></span>`;
}

const project = (s) => `<span class="td-proj c-${esc(s.color)}"><i class="p-dot"></i><span>${esc(s.project || '')}</span></span>`;

function cardOf(s) {
  const kind = s.state === 'waiting' ? 'Asking' : s.reminder ? 'Reminder' : 'Held';
  const q = s.question || s.reminder?.text || s.held?.line || (s.approval ? 'Needs your approval to carry on.' : '') || s.preview || s.title;
  const why = q === s.title ? '' : s.title;
  return {
    key: s.key || s.id,
    id: s.id,
    cls: 'td-card',
    cells: [
      `<span class="td-card-head">${who(s, s.state === 'waiting' ? 'asks' : 'idle')}${project(s)}<span class="sh-s${s.state === 'waiting' ? ' asking' : s.reminder ? ' reminder' : ''}">${kind}</span></span>`,
      `<span class="td-q">${esc(q)}</span>`,
      `<span class="td-why" title="${esc(why)}">${esc(why)}</span>`,
      '<button type="button" class="ghost sm">Open task</button>',
    ],
  };
}

// Dots and a word. A run that stopped short says so instead: it isn't on the way to anything.
const STOPPED = new Set(['failed', 'limit', 'refused', 'signedOut', 'blocked', 'partial']);
function stageHtml(s) {
  const key = s.state === 'running' ? '' : statusKey(s);
  if (STOPPED.has(key) && !openPr(s)) return `<span class="td-stage"><span class="td-dots" aria-hidden="true"></span>${esc(STATUS_LABEL[key])}</span>`;
  const at = stageOf(s);
  const dots = STAGES.map((_, i) => `<i class="${i < at ? 'past' : i === at ? 'cur' : ''}"></i>`).join('');
  return `<span class="td-stage"><span class="td-dots" aria-hidden="true">${dots}</span>${STAGES[at]}</span>`;
}

function taskRow(s) {
  const line = quietFor(s) || s.live || s.preview || '';
  return {
    key: s.key || s.id,
    id: s.id,
    cls: 'td-row',
    cells: [who(s, 'idle'), `<span class="td-what"><span class="td-t" title="${esc(s.title)}">${esc(s.title)}</span><span class="td-l">${project(s)}<span class="td-s" title="${esc(line)}">${esc(line)}</span></span></span>`, stageHtml(s), `<span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>`],
  };
}

// Done today: the rows Needs you has on New task, with the project where they say the state.
function plainRow(s) {
  const dot = (s.crew && crewDot(s)) || qDot(s, { ring: false });
  return {
    key: s.key || s.id,
    id: s.id,
    cls: `sh-task c-${s.color}`,
    cells: [dot, `<span class="sh-t" title="${esc(s.title)}">${esc(s.title)}</span>`, `<span class="sh-s">${esc(s.project || '')}</span>`, `<span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>`],
  };
}

const opened = { done: load('wisp.todayDone', false), coming: false };
const all = { ready: false, working: false, done: false }; // Show all, past the first few
export const comingShown = () => opened.coming;

function paintMore(box, key, n, few) {
  const more = $('.td-all', box);
  const on = all[key];
  show(more, n > few);
  say(more, on ? 'Show fewer' : `Show all ${n}`);
  flag(more, on);
}

const taskShell = () => `<button class="td-row">${cells(4)}</button>`;

export function paintToday(home, { ready = true, ahead = [] } = {}) {
  const { needs, working, done, scheduled } = groups();
  const shown = [...S.sessions.values()].filter((s) => underMember(s) && !s.pending);
  // What the crew wants from you on other tasks' jobs comes with yours, as on New task.
  const crew = shown.filter(needsYou);
  const every = [...needs, ...crew].sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.updatedAt - a.updatedAt);
  const asks = every.filter(isAsk);
  // Finished and unread, or a PR waiting on you, wherever the task sits now.
  const seen = new Set(asks);
  const reviewing = [...every.filter((s) => s.unread), ...[...needs, ...done, ...scheduled, ...shown].filter((s) => s.state !== 'running' && openPr(s))].filter((s) => !seen.has(s) && seen.add(s));
  reviewing.sort((a, b) => b.updatedAt - a.updatedAt);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = done.filter((s) => s.updatedAt >= dayStart && !seen.has(s));
  const lastAt = [...today, ...reviewing].reduce((a, s) => (s.updatedAt >= dayStart && s.updatedAt > (a?.updatedAt || 0) ? s : a), null);

  // Until the first list is in there's nothing to say: its shape, not *All quiet*.
  const status = $('.td-status', home);
  status.classList.toggle('loading', !ready);
  const said = ready ? sentenceOf({ asks: asks.map((s) => s.title), ready: reviewing.length, working: working.length, last: lastAt && { title: lastAt.title, ago: ago(lastAt.updatedAt) } }) : { line: '', sub: '' };
  say($('.td-line', status), said.line);
  say($('.td-sub', status), said.sub);
  put($('.td-top', home), slotHtml('today.top'));

  const cardBox = $('.td-needs', home);
  const few = spellProp('today.needs', 'count') || CARDS;
  show(cardBox, asks.length > 0);
  say($('h4 .n', cardBox), asks.length > few ? `${few} of ${asks.length}` : String(asks.length));
  syncRows($('.td-cards', cardBox), asks.slice(0, few).map(cardOf), () => `<article class="td-card">${cells(4)}</article>`);

  const rowBox = (sel, list, key, count) => {
    const box = $(sel, home);
    show(box, list.length > 0);
    say($('h4 .n', box), String(list.length));
    paintMore(box, key, list.length, count);
    syncRows($('.td-board', box), (all[key] ? list : list.slice(0, count)).map(taskRow), taskShell);
  };
  const rows = spellProp('today.working', 'count') || ROWS;
  rowBox('.td-ready', reviewing, 'ready', rows);
  rowBox('.td-working', working, 'working', rows);

  const doneBox = $('.td-done', home);
  const on = opened.done && today.length > 0;
  show(doneBox, today.length > 0);
  flag($('.td-fold', doneBox), on);
  say($('.td-fold .n', doneBox), String(today.length));
  paintMore(doneBox, 'done', on ? today.length : 0, ROWS);
  const list = $('.td-rows', doneBox);
  show(list, on);
  if (on) syncRows(list, (all.done ? today : today.slice(0, ROWS)).map(plainRow), () => `<button class="sh-task">${cells(4)}</button>`);

  // One quiet line each. Coming up unfolds its list; usage goes to Settings.
  const line = $('.td-coming', home);
  const next = ahead[0];
  show(line, !!next && !!$('.sh-coming', home).firstElementChild);
  if (next) {
    say($('span', line), `Coming up: ${next.title} ${aheadLabel(next.at)}${ahead.length > 1 ? ` · ${ahead.length - 1} more` : ''}`);
    flag(line, opened.coming);
  }
  paintPlans(home);
}

export function paintPlans(home) {
  const rows = plansOf(S.agents);
  const line = $('.td-plans', home);
  show(line, rows.length > 0);
  if (!rows.length) return;
  say($('span', line), `Left in your plans: ${plansLine(rows)}`);
  const tip = rows.map((r) => `${r.name}${r.account ? ` (${r.account})` : ''}, ${r.label.toLowerCase()}: ${r.left}% left, resets ${fmtDate(r.resetsAt, { weekday: 'short', ...SHORT_TIME })}`).join('\n');
  if (line.title !== tip) line.title = tip;
}

// A click on one of its headings; true when it took it (split.js repaints).
export function todayClick(e) {
  if (e.target.closest('.td-done .td-fold')) {
    opened.done = !opened.done;
    save('wisp.todayDone', opened.done);
    return true;
  }
  if (e.target.closest('.td-coming')) {
    opened.coming = !opened.coming;
    return true;
  }
  if (e.target.closest('.td-plans')) {
    openSettings({ pane: 'usage' });
    return false;
  }
  const more = e.target.closest('.td-all');
  if (more) all[more.dataset.all] = !all[more.dataset.all];
  return !!more;
}
