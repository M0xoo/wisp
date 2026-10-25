// Later on the page (design/later.md): scheduled follow-ups on a task (the pill, the rows above the
// reply box, Send later), tasks and reminders that haven't started (the Scheduled section), what's
// coming up next (split home), and the time menu they share. Times ahead are always absolute
// (14:32, Tue 9:00); "in 18 min" goes in the tooltip.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { fmtDate } from '../core/format.js';
import { S } from '../core/state.js';
import { clampToViewport, popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { parseWhen } from '../when.js';
import { avatarHtml, crewList, openMember } from './crew.js';
import { renderFeed, reveal } from './feed.js';
import { openAutomations } from './automations.js';
import { projectLabel } from './places.js';
import { agentName, MODES } from './runners.js';

// A time ahead, short: 14:32 today, Mon 9:00 this week, 2 Nov 9:00 after.
export function aheadLabel(t) {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtDate(t, { hour: '2-digit', minute: '2-digit' });
  if (t - now.getTime() < 6 * 86400_000) return `${fmtDate(t, { weekday: 'short' })} ${fmtDate(t, { hour: '2-digit', minute: '2-digit' })}`;
  return `${fmtDate(t, { day: 'numeric', month: 'short' })} ${fmtDate(t, { hour: '2-digit', minute: '2-digit' })}`;
}

const FULL = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

// "in 18 min", "in 2 h", "in 3 days": for tooltips only.
export function inWords(t, now = Date.now()) {
  const m = Math.max(1, Math.round((t - now) / 60_000));
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}
export const whenTip = (t) => `${inWords(t).replace(/^in/, 'In')} · ${fmtDate(t, FULL)}`;
const whoSet = (by) => (by === 'user' ? 'you' : by === 'agent' ? 'the agent' : by);

// A task with only follow-ups to wait for: it sits in Scheduled. One that asks you or has a report
// to read stays in Needs you with the pill (nothing an agent schedules hides what needs you).
export const isScheduled = (s) => !s.archived && s.state === 'done' && !!s.later?.length;

export function laterTip(s) {
  return (s.later || []).map((l) => `${l.remind ? 'Reminder' : 'Follow-up'} at ${aheadLabel(l.at)} (${inWords(l.at)}), set by ${whoSet(l.by)}: ${l.text}`).join('\n');
}

// The pill on a card: the next one, and how many more.
export function laterPill(s) {
  const l = s.later?.[0];
  if (!l || isScheduled(s)) return '';
  return `<span class="pill later-pill" title="${esc(laterTip(s))}">${icon(l.remind ? 'bell' : 'clock')}<span class="lp-t">${esc(aheadLabel(l.at))}</span>${s.later.length > 1 ? `<b>+${s.later.length - 1}</b>` : ''}</span>`;
}

// "16:30", "tomorrow 10", "Friday 9", "in 2h": the Pick a time… field.
export function parseTime(v, now = new Date()) {
  const t = String(v || '').trim();
  if (!t) return null;
  for (const x of [`${t} x`, `at ${t} x`, `on ${t} x`, `in ${t} x`]) {
    const p = parseWhen(x, now);
    if (p && p.rest === 'x') return p.at;
  }
  return null;
}

const tomorrowAt9 = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0).getTime();
};

// The time menu (Send later, Start later, Change time…, Snooze…), in the mode menu's style: one
// row per choice with the time it means on the right, then Pick a time…, which turns into a field.
// verb: what the field's result says ('Sends', 'Starts', 'Reminds you'). action: its button.
export function timeMenu(anchor, { verb = 'Sends', action = 'Schedule', back, at: point, pick }) {
  const open = $('.menu.later-menu');
  if (open) return open.close(), back?.focus();
  const now = Date.now();
  const choices = [
    ['In 10 min', now + 10 * 60_000],
    ['In 30 min', now + 30 * 60_000],
    ['In 1 hour', now + 3600_000],
    ['In 3 hours', now + 3 * 3600_000],
    ['Tomorrow morning', tomorrowAt9()],
  ];
  const menu = el(`
    <div class="menu later-menu" role="menu">
      ${choices.map(([label, t], i) => `<button role="menuitem" data-i="${i}"><span class="lm-l">${label}</span><span class="lm-t">${esc(aheadLabel(t))}</span></button>`).join('')}
      <button role="menuitem" data-a="pick"><span class="lm-l">Pick a time…</span></button>
      <form class="lm-pick" hidden>
        <input class="lm-in" placeholder="16:30, tomorrow 10, Friday 9" aria-label="When" autocomplete="off" spellcheck="false">
        <div class="lm-row"><span class="lm-says muted xs"></span><button class="primary sm" type="submit" disabled>${esc(action)}</button></div>
      </form>
    </div>`);
  const form = $('.lm-pick', menu);
  const input = $('.lm-in', menu);
  const says = $('.lm-says', menu);
  let chosen = null;
  input.addEventListener('input', () => {
    chosen = parseTime(input.value);
    if (chosen && chosen < Date.now() + 60_000) chosen = null;
    says.textContent = chosen ? `${verb} ${aheadLabel(chosen)}` : input.value.trim() ? 'Not a time yet' : '';
    says.title = chosen ? whenTip(chosen) : '';
    $('button[type=submit]', form).disabled = !chosen;
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!chosen) return;
    close();
    pick(chosen);
  };
  menu.onclick = (ev) => {
    const b = ev.target.closest('button[role=menuitem]');
    if (!b) return;
    if (b.dataset.a === 'pick') {
      $$('button[role=menuitem]', menu).forEach((x) => (x.hidden = true));
      form.hidden = false;
      input.focus();
      return;
    }
    close();
    pick(choices[b.dataset.i][1]);
    back?.focus();
  };
  menu.addEventListener('keydown', (ev) => {
    if (ev.target === input) return;
    const items = $$('button[role=menuitem]:not([hidden])', menu);
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  const close = popover(menu, { anchor, back, onClose: () => anchor?.classList.remove('open') });
  anchor?.classList.add('open');
  if (point) return clampToViewport(menu, point.x, point.y), $('button', menu).focus();
  const r = anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.top - 6 - h > 8 ? r.top - 6 - h : r.bottom + 6}px`;
  $('button', menu).focus();
}

// --- a task's follow-ups: optimistic, rolled back with a toast ---------------------------------

function setLater(id, later) {
  const s = S.sessions.get(id);
  if (!s) return;
  S.sessions.set(id, { ...s, later: later.length ? later : undefined });
  renderFeed();
  import('./composer.js').then((m) => m.updateDock(id));
}

// remind: a reminder about this task (no agent run). Resolves true once the server has it.
export async function scheduleFollowUp(id, { at, text, remind = false }) {
  const s = S.sessions.get(id);
  const before = s?.later || [];
  const temp = { id: `tmp${Date.now()}`, at, text, by: 'user', setAt: Date.now(), ...(remind && { remind: true }) };
  setLater(id, [...before, temp].sort((a, b) => a.at - b.at));
  try {
    await api(`/sessions/${id}/later`, { method: 'POST', body: { at, text, remind } });
    return true;
  } catch (err) {
    setLater(id, (S.sessions.get(id)?.later || []).filter((x) => x !== temp));
    toastError(err);
    return false;
  }
}

export async function cancelFollowUp(id, l) {
  const was = S.sessions.get(id)?.later || [];
  setLater(id, was.filter((x) => x.id !== l.id));
  try {
    await api(`/sessions/${id}/later?item=${encodeURIComponent(l.id)}`, { method: 'DELETE' });
  } catch (err) {
    setLater(id, was);
    return toastError(err);
  }
  toast('Cancelled', { action: { label: 'Undo', run: () => (l.at > Date.now() + 60_000 ? scheduleFollowUp(id, l) : sendNowText(id, l)) } });
}
const sendNowText = (id, l) => api(`/sessions/${id}/reply`, { method: 'POST', body: { text: l.text, queue: true } }).catch(toastError);

export async function sendNow(id, l) {
  const was = S.sessions.get(id)?.later || [];
  setLater(id, was.filter((x) => x.id !== l.id));
  await api(`/sessions/${id}/later`, { method: 'PATCH', body: { item: l.id, now: true } }).catch((err) => (setLater(id, was), toastError(err)));
}

export async function moveFollowUp(id, l, at) {
  const was = S.sessions.get(id)?.later || [];
  setLater(id, was.map((x) => (x.id === l.id ? { ...x, at } : x)).sort((a, b) => a.at - b.at));
  await api(`/sessions/${id}/later`, { method: 'PATCH', body: { item: l.id, at } }).catch((err) => (setLater(id, was), toastError(err)));
}

// Right-click (or tap) on a follow-up row above the reply box.
export function followUpMenu(e, id, l, anchor) {
  $('.menu.later-row')?.close();
  const x = e.clientX || anchor.getBoundingClientRect().left;
  const y = e.clientY || anchor.getBoundingClientRect().bottom;
  const menu = el(`
    <div class="menu later-row" role="menu">
      <button data-a="now">${icon('send')}${l.remind ? 'Remind me now' : 'Send now'}</button>
      <button data-a="time">${icon('clock')}Change time…</button>
      <button data-a="cancel" class="danger">${icon('x')}${l.remind ? 'Cancel reminder' : 'Cancel follow-up'}</button>
    </div>`);
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    if (a === 'now') sendNow(id, l);
    if (a === 'cancel') cancelFollowUp(id, l);
    if (a === 'time') timeMenu(anchor, { verb: l.remind ? 'Reminds you' : 'Sends', action: 'Move', at: { x, y }, pick: (at) => moveFollowUp(id, l, at) });
  };
  const close = popover(menu);
  clampToViewport(menu, x, y);
}

// The rows above the reply box: queued follow-ups go first (composer.js), then these, by time.
export function followUpRows(s, list) {
  for (const l of s.later || []) {
    const li = el(`
      <li class="cq later" data-later="${esc(l.id)}">
        <span class="cq-tag" title="${esc(whenTip(l.at))}">${icon(l.remind ? 'bell' : 'clock')}${l.remind ? 'Reminder at' : 'At'} ${esc(aheadLabel(l.at))} · set by ${esc(whoSet(l.by))}</span>
        <span class="cq-text">${esc(l.text)}</span>
        <button class="att-x" aria-label="${l.remind ? 'Cancel reminder' : 'Cancel follow-up'}" title="${l.remind ? 'Cancel reminder' : 'Cancel follow-up'}">${icon('x')}</button>
      </li>`);
    $('.att-x', li).onclick = (e) => {
      e.stopPropagation();
      cancelFollowUp(s.id, l);
    };
    const menu = (e) => {
      if (e.target.closest('.att-x')) return;
      e.preventDefault();
      e.stopPropagation();
      followUpMenu(e, s.id, l, li);
    };
    li.addEventListener('contextmenu', menu);
    li.addEventListener('click', menu);
    list.append(li);
  }
}

// --- reminders that came due --------------------------------------------------------------

export function snooze(id, anchor, point) {
  timeMenu(anchor, {
    verb: 'Reminds you',
    action: 'Snooze',
    at: point,
    pick: async (at) => {
      try {
        await api(`/sessions/${id}/later`, { method: 'PATCH', body: { item: 'reminder', at } });
        toast(`Snoozed until ${esc(aheadLabel(at))}`);
      } catch (err) {
        toastError(err);
      }
    },
  });
}

// --- plans: tasks and reminders that don't exist yet -----------------------------------------

export const plans = () => (S.config.later || []).slice().sort((a, b) => a.at - b.at);

function setPlans(list) {
  S.config.later = list;
  renderFeed();
}

// body: what POST /sessions would get, or { text } for a reminder. Resolves the plan, or null.
export async function addPlan(kind, at, body) {
  const temp = { id: `tmp${Date.now()}`, kind, at, setAt: Date.now(), ...(kind === 'task' ? { body, title: body.prompt.split('\n')[0].slice(0, 80) } : { text: body.text }) };
  setPlans([...(S.config.later || []), temp]);
  try {
    const p = await api('/later', { method: 'POST', body: { kind, at, ...body } });
    setPlans([...(S.config.later || []).filter((x) => x !== temp && x.id !== p.id), p]);
    return p;
  } catch (err) {
    setPlans((S.config.later || []).filter((x) => x !== temp));
    toastError(err);
    return null;
  }
}

async function cancelPlan(p) {
  const was = S.config.later || [];
  setPlans(was.filter((x) => x.id !== p.id));
  try {
    await api(`/later/${p.id}`, { method: 'DELETE' });
  } catch (err) {
    setPlans(was);
    return toastError(err);
  }
  toast(p.kind === 'task' ? 'Deleted' : 'Reminder deleted', { action: { label: 'Undo', run: () => addPlan(p.kind, Math.max(p.at, Date.now() + 61_000), p.kind === 'task' ? p.body : { text: p.text, from: p.from }) } });
}

async function startPlan(p) {
  const was = S.config.later || [];
  setPlans(was.filter((x) => x.id !== p.id));
  try {
    const out = await api(`/later/${p.id}`, { method: 'PATCH', body: { now: true } });
    if (out.session?.id) (S.sessions.set(out.session.id, out.session), renderFeed(), reveal(out.session.id));
  } catch (err) {
    setPlans(was);
    toastError(err);
  }
}

async function movePlan(p, at) {
  const was = S.config.later || [];
  setPlans(was.map((x) => (x.id === p.id ? { ...x, at } : x)));
  await api(`/later/${p.id}`, { method: 'PATCH', body: { at } }).catch((err) => (setPlans(was), toastError(err)));
}

export function planMenu(e, p, anchor) {
  $('.menu.later-plan')?.close();
  const r = anchor.getBoundingClientRect();
  const x = e.clientX || r.left + 24;
  const y = e.clientY || r.bottom;
  const task = p.kind === 'task';
  const menu = el(`
    <div class="menu later-plan" role="menu">
      <p class="lp-what">${esc(task ? p.body.prompt : p.text)}</p>
      <button data-a="now">${icon(task ? 'play' : 'bell')}${task ? 'Start now' : 'Remind me now'}</button>
      <button data-a="time">${icon('clock')}${task ? 'Change start time…' : 'Change time…'}</button>
      <button data-a="cancel" class="danger">${icon('trash')}${task ? 'Delete' : 'Delete reminder'}</button>
    </div>`);
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    if (a === 'now') startPlan(p);
    if (a === 'cancel') cancelPlan(p);
    if (a === 'time') timeMenu(anchor, { verb: task ? 'Starts' : 'Reminds you', action: 'Move', at: { x, y }, pick: (at) => movePlan(p, at) });
  };
  const close = popover(menu);
  clampToViewport(menu, x, y);
}

// The rows of plans in the Scheduled section, above its task cards. Same columns as a card's head,
// with the start time where a card has its age. Rows stay in place on a refresh (dataset.h).
// Kept nodes, so a refresh doesn't re-insert (and replay) them; feed.js places them among the cards.
const planNodes = new Map();
export function planRows() {
  const list = plans();
  const want = new Map(list.map((p) => [p.id, p]));
  for (const [id, n] of planNodes) if (!want.has(id)) (n.remove(), planNodes.delete(id));
  const rows = [];
  list.forEach((p) => {
    const task = p.kind === 'task';
    const project = task && S.config.projects?.find((x) => x.path === p.body.cwd);
    const html = `
      <span class="q-dot auto">${icon(task ? 'clock' : 'bell')}</span>
      <span class="it-main">
        <span class="it-title" title="${esc(task ? p.body.prompt : p.text)}">${esc(task ? p.title : p.text)}</span>
        <span class="it-sub">${task ? esc([agentName(p.body.agent || 'auto'), MODES.find((m) => m.id === p.body.mode)?.label].filter(Boolean).join(' · ')) : 'Reminder'}</span>
      </span>
      <span class="it-side">
        ${task && project ? projectLabel({ project: project.name, color: project.color, projectId: project.id }) : ''}
        <span class="q-time" title="${esc(whenTip(p.at))}">${esc(aheadLabel(p.at))}</span>
        <span class="it-quick-gap" aria-hidden="true"></span>
        ${icon('chevron', 'chev')}
      </span>`;
    let n = planNodes.get(p.id);
    if (!n) {
      n = el(`<div class="item plan-row c-${project?.color || 'slate'}" data-plan="${esc(p.id)}"><div class="it-head" role="button" tabindex="0"></div></div>`);
      const head = $('.it-head', n);
      const menu = (e) => {
        e.preventDefault();
        planMenu(e, want.get(n.dataset.plan) || plans().find((x) => x.id === n.dataset.plan), head);
      };
      head.addEventListener('click', menu);
      head.addEventListener('contextmenu', menu);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') menu(e);
      });
      planNodes.set(p.id, n);
    }
    const head = $('.it-head', n);
    if (head.dataset.h !== html) (head.dataset.h = html), (head.innerHTML = html);
    n.dataset.at = p.at;
    rows.push(n);
  });
  return rows;
}

// --- Coming up (split home) ----------------------------------------------------------------

// Everything with a time ahead: plans, follow-ups (here and on machines, from their summaries),
// crew check-ins and wake-ups, and schedule triggers. Soonest first.
export function upcoming() {
  const out = [];
  for (const p of plans()) out.push({ kind: p.kind, at: p.at, title: p.kind === 'task' ? p.title : p.text, sub: p.kind === 'task' ? 'Scheduled task' : 'Reminder', plan: p });
  for (const s of S.sessions.values()) {
    if (s.archived || !s.later?.length) continue;
    for (const l of s.later) out.push({ kind: l.remind ? 'reminder' : 'followup', at: l.at, title: s.title, sub: l.text, id: s.id, crew: s.crew });
  }
  for (const m of crewList()) {
    if (m.paused || !m.nextAt) continue;
    out.push({ kind: 'checkin', at: m.nextAt, title: m.name, sub: m.wakeAt && m.wakeAt <= m.nextAt + 1000 ? 'Looks again' : 'Check-in', member: m });
  }
  for (const t of S.config.triggers || []) if (t.kind === 'schedule' && t.enabled && t.nextAt) out.push({ kind: 'trigger', at: t.nextAt, title: t.name, sub: 'Schedule', trigger: t });
  return out.filter((x) => x.at > Date.now() - 60_000).sort((a, b) => a.at - b.at);
}

export function upcomingRow(x, i) {
  const glyph = x.kind === 'checkin' ? avatarHtml(x.member, { size: 18, dot: false }) : `<span class="q-dot auto">${icon(x.kind === 'trigger' ? 'bolt' : x.kind === 'reminder' ? 'bell' : 'clock')}</span>`;
  return `<button class="sh-task sh-up" data-up="${i}" title="${esc(`${x.title}: ${x.sub}`)}">
    ${glyph}
    <span class="sh-t">${esc(x.title)}</span>
    <span class="sh-s">${esc(x.sub)}</span>
    <span class="q-time" title="${esc(whenTip(x.at))}">${esc(aheadLabel(x.at))}</span>
  </button>`;
}

export function openUpcoming(x, anchor, e) {
  if (x.id) return reveal(x.id);
  if (x.member) return openMember(x.member.id);
  if (x.trigger) return openAutomations({ tab: 'triggers' });
  if (x.plan) return planMenu(e, x.plan, anchor);
}

// --- task actions, the same everywhere (right-click, More, ⌘K) -------------------------------

// What a task's menus offer for its follow-ups and reminders. Several pending: the soonest, named.
export function laterActions(s) {
  if (!s) return [];
  const out = [];
  if (s.reminder && s.state === 'review') out.push({ a: 'later-snooze', label: 'Snooze…', icon: 'bell' });
  const l = s.later?.[0];
  if (l) {
    const what = l.remind ? 'reminder' : 'follow-up';
    const named = s.later.length > 1 ? `${aheadLabel(l.at)} ${what}` : what;
    out.push({ a: 'later-now', label: l.remind ? 'Remind me now' : 'Send follow-up now', icon: l.remind ? 'bell' : 'send' });
    out.push({ a: 'later-time', label: `Change ${named} time…`, icon: 'clock' });
    out.push({ a: 'later-cancel', label: `Cancel ${named}`, icon: 'x' });
  }
  return out;
}
export const laterMenuHtml = (s) => laterActions(s).map((x) => `<button data-a="${x.a}">${icon(x.icon)}${esc(x.label)}</button>`).join('');

// anchor / point: where Change time… and Snooze… open their menu.
export function runLaterAction(a, s, anchor, point) {
  const l = s.later?.[0];
  if (a === 'later-snooze') return snooze(s.id, anchor, point);
  if (!l) return;
  if (a === 'later-now') sendNow(s.id, l);
  if (a === 'later-cancel') cancelFollowUp(s.id, l);
  if (a === 'later-time') timeMenu(anchor, { verb: l.remind ? 'Reminds you' : 'Sends', action: 'Move', at: point, pick: (at) => moveFollowUp(s.id, l, at) });
}
