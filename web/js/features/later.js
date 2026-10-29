// Later on the page (design/later.md): scheduled follow-ups on a task (the pill, the rows above the
// reply box, Send later), tasks and reminders that haven't started (the Scheduled section), what's
// coming up next (split home), and the time menu they share. Times ahead are always absolute
// (14:32, Tue 9:00); "in 18 min" goes in the tooltip.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { fmtDate } from '../core/format.js';
import { S } from '../core/state.js';
import { clampToViewport, popover, refocus } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { parseWhen } from '../when.js';
import { avatarHtml, crewList, openMember } from './crew.js';
import { renderFeed, reveal } from './feed.js';
import { openAutomations } from './automations.js';
import { projectLabel } from './places.js';
import { agentName, MODES } from './runners.js';
import { HELD_LABEL, heldAction } from './hold.js';
import { editRow } from './queued.js';
import { openPlan, planShown } from './plan-view.js';

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
export const isScheduled = (s) => !s.archived && !s.forLater && s.state === 'done' && (!!s.later?.length || !!s.held?.waiting); // saved for later: that wins
// When a scheduled task's next thing happens: its follow-up, or its held run's reset (features/hold.js).
export const nextAt = (s) => Math.min(s.later?.[0]?.at ?? Infinity, s.held?.waiting ? s.held.until : Infinity);

export function laterTip(s) {
  return (s.later || []).map((l) => (l.held ? `${l.goal ? `Goal round ${l.goal}` : 'Follow-up'} at ${aheadLabel(l.at)} (${inWords(l.at)}), when the plan resets. Waits for your plan: ${l.held.why}` : `${l.remind ? 'Reminder' : 'Follow-up'} at ${aheadLabel(l.at)} (${inWords(l.at)}), set by ${whoSet(l.by)}: ${l.text}`)).join('\n');
}

// What a scheduled follow-up says on its row: its text, or (moved to the plan's reset by
// Settings → Usage → Automations stop at) that it waits for the plan. [icon, text]
export function laterLine(l) {
  if (l.held) return ['pause', l.goal ? `Goal round ${l.goal} waits for your plan` : `Waits for your plan: ${l.text}`];
  if (l.goal) return ['target', `Goal round ${l.goal}`];
  return [l.remind ? 'bell' : 'clock', l.text];
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
// row per choice with the time it means on the right, then Pick a time…, which turns into a field
// in its own row (the menu keeps its size and place): its time shows where the others do, Enter
// takes it, Escape goes back to the row.
export function timeMenu(anchor, { back, at: point, pick }) {
  const open = $('.menu.later-menu');
  if (open) return open.close(), refocus(back);
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
        <input class="lm-in" placeholder="tomorrow 10, Fri 9" aria-label="When" autocomplete="off" spellcheck="false" enterkeyhint="done">
        <button class="lm-go" type="submit" disabled></button>
      </form>
    </div>`);
  const form = $('.lm-pick', menu);
  const input = $('.lm-in', menu);
  const go = $('.lm-go', menu);
  const pickRow = $('[data-a=pick]', menu);
  let chosen = null;
  input.addEventListener('input', () => {
    chosen = parseTime(input.value);
    if (chosen && chosen < Date.now() + 60_000) chosen = null;
    go.innerHTML = chosen ? `<span class="lm-t">${esc(aheadLabel(chosen))}</span><kbd class="key-hint">↵</kbd>` : input.value.trim() ? '<span class="lm-t no">not yet</span>' : '';
    go.title = chosen ? whenTip(chosen) : '';
    go.disabled = !chosen;
  });
  // Escape in the field: back to its row, the menu stays.
  const unpick = () => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    form.hidden = true;
    pickRow.hidden = false;
    pickRow.focus();
    return true;
  };
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
      pickRow.hidden = true;
      form.hidden = false;
      input.focus();
      return;
    }
    close();
    pick(choices[b.dataset.i][1]);
    refocus(back);
  };
  menu.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = $$('button[role=menuitem]:not([hidden])', menu);
    if (ev.target === input) return items[ev.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  const close = popover(menu, { anchor, back, onClose: () => anchor?.classList.remove('open'), onEscape: () => document.activeElement === input && unpick() });
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

// remind: a reminder about this task (no agent run). attachments: upload ids that go with it.
// Resolves true once the server has it.
export async function scheduleFollowUp(id, { at, text, remind = false, attachments }) {
  const s = S.sessions.get(id);
  const before = s?.later || [];
  const temp = { id: `tmp${Date.now()}`, at, text, by: 'user', setAt: Date.now(), ...(remind && { remind: true }), ...(attachments?.length && { files: attachments.length }) };
  setLater(id, [...before, temp].sort((a, b) => a.at - b.at));
  try {
    await api(`/sessions/${id}/later`, { method: 'POST', body: { at, text, remind, attachments } });
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
      ${l.goal || !anchor.matches?.('.cq') ? '' : `<button data-a="edit">${icon('pen')}${l.remind ? 'Edit reminder' : 'Edit follow-up'}</button>`}
      <button data-a="time">${icon('clock')}Change time…</button>
      <button data-a="cancel" class="danger">${icon('x')}${l.remind ? 'Cancel reminder' : 'Cancel follow-up'}</button>
    </div>`);
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    if (a === 'edit') editLaterRow(id, anchor);
    if (a === 'now') sendNow(id, l);
    if (a === 'cancel') cancelFollowUp(id, l);
    if (a === 'time') timeMenu(anchor, { at: { x, y }, pick: (at) => moveFollowUp(id, l, at) });
  };
  const close = popover(menu);
  clampToViewport(menu, x, y);
}

export async function editFollowUp(id, l, text) {
  const was = S.sessions.get(id)?.later || [];
  setLater(id, was.map((x) => (x.id === l.id ? { ...x, text } : x)));
  try {
    await api(`/sessions/${id}/later`, { method: 'PATCH', body: { item: l.id, text } });
    return true;
  } catch (err) {
    setLater(id, was);
    toastError(err);
    return false;
  }
}

// The rows above the reply box, for queued.js's keyedRows: queued follow-ups go first, then these,
// by time. A click (or right-click) is the row's menu; the pencil edits what it says.
export function followUpItems(s) {
  return (s.later || []).map((l) => ({
    key: `l-${l.id}`,
    cls: 'cq later',
    item: l,
    html: `<span class="cq-tag" title="${esc(l.held ? `${whenTip(l.at)}\nWaits for your plan: ${l.held.why}` : whenTip(l.at))}">${icon(l.held ? 'pause' : l.remind ? 'bell' : 'clock')}${l.remind ? 'Reminder at' : 'At'} ${esc(aheadLabel(l.at))} · ${l.held ? 'when your plan resets' : `set by ${esc(whoSet(l.by))}`}${l.files ? ` · <span title="${l.files === 1 ? '1 file goes with it' : `${l.files} files go with it`}">${icon('clip')}${l.files}</span>` : ''}</span>
      <span class="cq-text">${esc(l.goal ? laterLine(l)[1] : l.text)}</span>
      ${l.goal || String(l.id).startsWith('tmp') ? '' : `<button class="cq-pen" aria-label="${l.remind ? 'Edit reminder' : 'Edit follow-up'}" title="${l.remind ? 'Edit reminder' : 'Edit follow-up'}">${icon('pen')}</button>`}
      <button class="att-x" aria-label="${l.remind ? 'Cancel reminder' : 'Cancel follow-up'}" title="${l.remind ? 'Cancel reminder' : 'Cancel follow-up'}">${icon('x')}</button>`,
    make: (li) => {
      const menu = (e) => {
        if (li.classList.contains('editing')) return;
        e.preventDefault();
        e.stopPropagation();
        followUpMenu(e, s.id, li.item, li);
      };
      li.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b?.classList.contains('att-x')) return e.stopPropagation(), cancelFollowUp(s.id, li.item);
        if (b?.classList.contains('cq-pen')) return e.stopPropagation(), editLaterRow(s.id, li);
        menu(e);
      });
      li.addEventListener('contextmenu', menu);
    },
  }));
}

function editLaterRow(id, li) {
  const l = li.item;
  editRow(li, l.text, (text) => editFollowUp(id, l, text));
}

// --- reminders that came due --------------------------------------------------------------

export function snooze(id, anchor, point) {
  timeMenu(anchor, {
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

export async function cancelPlan(p) {
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

// Resolves true once it started (its task opens), false when the server refused.
export async function startPlan(p) {
  const was = S.config.later || [];
  setPlans(was.filter((x) => x.id !== p.id));
  try {
    const out = await api(`/later/${p.id}`, { method: 'PATCH', body: { now: true } });
    if (out.session?.id) (S.sessions.set(out.session.id, out.session), renderFeed(), reveal(out.session.id));
    return true;
  } catch (err) {
    setPlans(was);
    toastError(err);
    return false;
  }
}

// What a task will be asked (or a reminder will say). Resolves true once the server has it.
export async function editPlan(p, text) {
  const was = S.config.later || [];
  const task = p.kind === 'task';
  setPlans(was.map((x) => (x.id !== p.id ? x : task ? { ...x, body: { ...x.body, prompt: text }, title: text.split('\n')[0].slice(0, 80) } : { ...x, text })));
  try {
    await api(`/later/${p.id}`, { method: 'PATCH', body: task ? { prompt: text } : { text } });
    return true;
  } catch (err) {
    setPlans(was);
    toastError(err);
    return false;
  }
}

export async function movePlan(p, at) {
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
      <button data-a="open">${icon('pen')}${task ? 'Edit task' : 'Edit reminder'}</button>
      <button data-a="now">${icon(task ? 'play' : 'bell')}${task ? 'Start now' : 'Remind me now'}</button>
      <button data-a="time">${icon('clock')}${task ? 'Change start time…' : 'Change time…'}</button>
      <button data-a="cancel" class="danger">${icon('trash')}${task ? 'Delete' : 'Delete reminder'}</button>
    </div>`);
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    if (a === 'open') openPlan(p.id);
    if (a === 'now') startPlan(p);
    if (a === 'cancel') cancelPlan(p);
    if (a === 'time') timeMenu(anchor, { at: { x, y }, pick: (at) => movePlan(p, at) });
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
      // A click opens it as a page to edit (plan-view.js); right-click is its menu.
      head.addEventListener('click', () => openPlan(n.dataset.plan));
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        planMenu(e, plans().find((x) => x.id === n.dataset.plan), head);
      });
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), openPlan(n.dataset.plan));
      });
      planNodes.set(p.id, n);
    }
    const head = $('.it-head', n);
    if (head.dataset.h !== html) (head.dataset.h = html), (head.innerHTML = html);
    n.dataset.at = p.at;
    n.classList.toggle('sel', planShown() && S.planOpen === p.id);
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
    for (const l of s.later) out.push({ kind: l.remind ? 'reminder' : 'followup', at: l.at, title: s.title, sub: laterLine(l)[1], id: s.id, crew: s.crew, ...(l.held && { held: true }) });
  }
  for (const m of crewList()) {
    if (m.paused || !m.nextAt) continue;
    out.push({ kind: 'checkin', at: m.nextAt, title: m.name, sub: m.held ? 'Check-in waits for your plan' : m.wakeAt && m.wakeAt <= m.nextAt + 1000 ? 'Looks again' : 'Check-in', member: m, ...(m.held && { held: true }) });
  }
  for (const t of S.config.triggers || []) if (t.kind === 'schedule' && t.enabled && t.nextAt) out.push({ kind: 'trigger', at: t.nextAt, title: t.name, sub: 'Schedule', trigger: t });
  return out.filter((x) => x.at > Date.now() - 60_000).sort((a, b) => a.at - b.at);
}

// A day's heading in the full list: Today, Tomorrow, Fri 31 Oct.
export function dayLabel(t, now = new Date()) {
  const d = new Date(t);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return fmtDate(t, { weekday: 'short', day: 'numeric', month: 'short' });
}

// The full list, a heading per day: under it each row says only its time.
export function upcomingByDay(list) {
  let day = '';
  return list
    .map((x, i) => {
      const d = dayLabel(x.at);
      const head = d === day ? '' : `<div class="sh-day">${esc(d)}</div>`;
      day = d;
      return head + upcomingRow(x, i, fmtDate(x.at, { hour: '2-digit', minute: '2-digit' }));
    })
    .join('');
}

export function upcomingRow(x, i, time = aheadLabel(x.at)) {
  const glyph = x.kind === 'checkin' ? avatarHtml(x.member, { size: 18, dot: false }) : `<span class="q-dot auto">${icon(x.kind === 'trigger' ? 'bolt' : x.kind === 'reminder' ? 'bell' : 'clock')}</span>`;
  return `<button class="sh-task sh-up${x.held ? ' held' : ''}" data-up="${i}" title="${esc(`${x.title}: ${x.sub}`)}">
    ${glyph}
    <span class="sh-t">${esc(x.title)}</span>
    <span class="sh-s">${esc(x.sub)}</span>
    <span class="q-time" title="${esc(whenTip(x.at))}">${esc(time)}</span>
  </button>`;
}

export function openUpcoming(x, anchor, e) {
  if (x.id) return reveal(x.id);
  if (x.member) return openMember(x.member.id);
  if (x.trigger) return openAutomations({ tab: 'triggers' });
  if (x.plan) return openPlan(x.plan.id);
}

// --- task actions, the same everywhere (right-click, More, ⌘K) -------------------------------

// What a task's menus offer for its follow-ups and reminders. Several pending: the soonest, named.
export function laterActions(s) {
  if (!s) return [];
  const out = [];
  // A run held near the limit (features/hold.js): the card's three, by the card's names.
  if (s.held) {
    out.push({ a: 'held-start', label: HELD_LABEL.start(s), icon: 'play' });
    if (!s.held.waiting) out.push({ a: 'held-wait', label: HELD_LABEL.wait(s), icon: 'clock' });
    out.push({ a: 'held-skip', label: HELD_LABEL.skip(s), icon: 'skip' });
  }
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
  if (a.startsWith('held-')) return heldAction(s.id, a.slice(5));
  const l = s.later?.[0];
  if (a === 'later-snooze') return snooze(s.id, anchor, point);
  if (!l) return;
  if (a === 'later-now') sendNow(s.id, l);
  if (a === 'later-cancel') cancelFollowUp(s.id, l);
  if (a === 'later-time') timeMenu(anchor, { at: point, pick: (at) => moveFollowUp(s.id, l, at) });
}
