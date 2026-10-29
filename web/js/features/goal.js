// Goals (server/goal.js): a task that keeps going until a condition holds. Here: the band on top of
// the open task (what it's going for, how far the last check put it, what the check said), the
// row's pill, the popover that sets one, and its actions under the same names everywhere:
// Set goal… / Edit goal…, Pause goal, Resume goal, Drop goal (design/goals.md).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { fmtDuration } from '../blocks.js';
import { whenLabel } from '../core/format.js';
import { slotHtml } from './spells.js';

const LIVE = new Set(['working', 'checking']);
// The state, in the band's fixed column. The row's pill has the round instead; the band's second
// line says what the check found, in the checker's own words.
const STATE = { working: 'Working', checking: 'Checking', met: 'Goal met', impossible: 'Can’t be done', out: 'Stopped', paused: 'Paused', handed: 'Moved on' };

export const goalLive = (g) => !!g && LIVE.has(g.status);
const lastProgress = (g, back = 0) => g?.checks?.filter((c) => c.progress != null).at(-1 - back)?.progress ?? null;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// A ring that fills with the last check's progress: the row's glyph and the band's mark.
function ring(p, size = 14) {
  const r = size / 2 - 1.6;
  const c = 2 * Math.PI * r;
  return `<svg class="g-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="g-ring-bg"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="g-ring-fg" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - (p ?? 0) / 100)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/><circle cx="${size / 2}" cy="${size / 2}" r="${(size / 7).toFixed(2)}" class="g-ring-dot"/></svg>`;
}

// The row: the ring and the round, always the same width; how it ended tints it (the tooltip names it).
export function goalPill(s) {
  const g = s.goal;
  if (!g || s.pending) return '';
  const tip = `Done when: ${g.text}\n${STATE[g.status] || ''}${g.last ? ` · ${g.last.why}` : ''}`;
  return `<span class="pill goal-pill g-${g.status}" title="${esc(tip)}">${ring(g.status === 'met' ? 100 : lastProgress(g))}<span class="gp-n">${g.round}</span></span>`;
}

// What the band's second line says, by state.
function checkLine(g) {
  const last = g.checks?.at(-1);
  const spent = g.endedAt && g.setAt ? fmtDuration(g.endedAt - g.setAt) : '';
  if (g.status === 'met') return `<b>Met in ${plural(g.round, 'round')}</b>${esc([spent, last?.why].filter(Boolean).join(' · '))}`;
  if (g.status === 'impossible') return `<b>Why</b>${esc(g.why || last?.why || '')}`;
  if (g.status === 'out') return `<b>Stopped at ${lastProgress(g) ?? 0}%</b>${last ? esc(last.why) : ''}`;
  // Goals from before rounds were unlimited could run out of them.
  // Automations stop at held the next round back: it goes on by itself at the plan's reset.
  if (g.status === 'paused' && g.held) return `<b>Round ${g.round} goes on ${esc(whenLabel(g.held))}</b>${esc(g.why || '')}`;
  if (g.status === 'paused') return `<b>${esc(g.why || 'Paused')}</b>${last ? esc(last.why) : ''}`;
  if (g.status === 'handed') return '<b>Another run carries it on</b>';
  if (g.status === 'checking') return last ? `<b>Last check</b>${esc(last.why)}` : '<b>First check under way</b>';
  if (!last) return '<b>First check after this round</b>';
  return `<b>${last.verdict === 'not_yet' ? 'Not yet' : 'Last check'}</b>${esc(last.why)}${last.next ? `<span class="gb-next">Next: ${esc(last.next)}</span>` : ''}`;
}

// The band: fixed two rows, so a round starting or a check landing never moves what's under it.
function bandHtml(s) {
  const g = s.goal;
  const p = g.status === 'met' ? 100 : lastProgress(g);
  const was = lastProgress(g, 1);
  const delta = p != null && was != null && p !== was ? p - was : null;
  const ended = !LIVE.has(g.status);
  const primary = ['paused', 'out'].includes(g.status) ? `<button class="ghost xs gb-go" data-g="resume">${icon('play')}Resume goal</button>` : '';
  const history = (g.checks || []).map((c) => `Round ${c.round}: ${c.verdict === 'met' ? 'met' : c.verdict === 'not_yet' ? 'not yet' : c.verdict === 'impossible' ? 'can’t be done' : 'not checked'}${c.progress != null ? ` (${c.progress}%)` : ''}`).join('\n');
  return `
    <section class="goal-band g-${g.status}" aria-label="Goal">
      <div class="gb-row">
        <span class="gb-mark">${g.status === 'met' ? '<svg class="gb-met" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.2"/><path d="M6.2 10.4l2.6 2.6 5-5.4"/></svg>' : icon('target')}</span>
        <span class="gb-k">Done when</span>
        <span class="gb-text" title="${esc(g.text)}">${esc(g.text)}</span>
        <span class="gb-state">${g.held && g.status === 'paused' ? 'Waiting' : STATE[g.status] || ''}</span>
        <button class="icon-btn gb-more" data-g="menu" aria-label="Goal actions" title="Goal actions">${icon('dots')}</button>
      </div>
      <div class="gb-row gb-sub">
        <span class="gb-track" title="${esc(history || 'Not checked yet')}" style="--p:${p ?? 0}%;--was:${was ?? 0}%"><i class="gb-was"></i><i class="gb-fill"></i></span>
        <span class="gb-pct">${p == null ? '–' : `${p}%`}${delta ? `<small class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : '−'}${Math.abs(delta)}</small>` : ''}</span>
        ${ended ? '' : `<span class="gb-round">Round ${g.round}</span>`}
        <span class="gb-check"${g.held && g.why ? ` title="${esc(g.why)}"` : ''}>${checkLine(g)}</span>
        ${primary}${slotHtml('goal.band', S.sessions.get(s.id))}
      </div>
    </section>`;
}

// Paint (or clear) the open task's band in place. The goal-met moment plays once per goal.
export function paintGoal(id) {
  const n = S.nodes.get(id);
  const slot = n?.body && $('.goal-slot', n.body);
  if (!slot) return;
  const s = S.sessions.get(id);
  const html = s?.goal ? bandHtml(s) : '';
  if (slot.dataset.h === html) return;
  slot.innerHTML = html;
  slot.dataset.h = html;
  slot.hidden = !html;
  const g = s?.goal;
  if (g?.status === 'met' && g.endedAt) {
    const seen = load('wisp.goalsMet', []);
    const key = `${id}:${g.endedAt}`;
    if (!seen.includes(key) && Date.now() - g.endedAt < 10 * 60_000) {
      $('.goal-band', slot).classList.add('landing');
      save('wisp.goalsMet', [key, ...seen].slice(0, 40));
    }
  }
}

// Clicks on the band: its menu, and Resume when it waits for you.
export function wireGoalSlot(slot, id) {
  slot.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    if (b.dataset.g === 'menu') goalMenu(id, b);
    else goalAction(id, b.dataset.g);
  });
  slot.addEventListener('dblclick', (e) => {
    if (e.target.closest('.gb-text')) editGoal(id, e.target.closest('.goal-band'));
  });
}

// The goal's actions, the same everywhere: More, right-click, ⌘K and the band's own menu.
export function goalActions(s) {
  if (!s || s.parentId || s.agent === 'wisp' || s.pending || s.kind === 'reminder' || s.delegated) return [];
  const g = s.goal;
  if (!g) return [{ a: 'goal-set', label: 'Set goal…', icon: 'target' }];
  return [
    { a: 'goal-set', label: 'Edit goal…', icon: 'target' },
    ...(LIVE.has(g.status) ? [{ a: 'goal-pause', label: 'Pause goal', icon: 'pause' }] : g.status !== 'met' && g.status !== 'handed' ? [{ a: 'goal-resume', label: 'Resume goal', icon: 'play' }] : []),
    { a: 'goal-drop', label: 'Drop goal', icon: 'x' },
  ];
}
export const goalMenuHtml = (s) => goalActions(s).map((x) => `<button data-a="${x.a}">${icon(x.icon)}${x.label}</button>`).join('');

export function runGoalAction(a, id, anchor) {
  if (a === 'goal-set') editGoal(id, anchor);
  if (a === 'goal-pause') goalAction(id, 'pause');
  if (a === 'goal-resume') goalAction(id, 'resume');
  if (a === 'goal-drop') goalAction(id, 'drop');
}

function goalMenu(id, anchor) {
  const s = S.sessions.get(id);
  const r = anchor.getBoundingClientRect();
  const menu = el(`<div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">${goalMenuHtml(s)}</div>`);
  menu.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a) runGoalAction(a, id, anchor);
  };
  const close = popover(menu, { anchor });
}

// Repaint everything that shows the goal: the row, the band, the details.
async function repaint(id) {
  const { renderFeed } = await import('./feed.js');
  renderFeed();
  paintGoal(id);
}

// Pause / Resume / Drop: the page changes first; the server's refusal puts it back.
export async function goalAction(id, action) {
  const s = S.sessions.get(id);
  if (!s?.goal) return;
  const prev = s.goal;
  const prevLater = s.later;
  // A round that waited for the plan leaves Scheduled with it: Resume sends it now, the rest drop it.
  if (prev.held) s.later = s.later?.filter((l) => !l.goal);
  if (s.later && !s.later.length) delete s.later;
  if (action === 'drop') delete s.goal;
  else s.goal = { ...prev, held: undefined, status: action === 'pause' ? 'paused' : 'working', why: action === 'pause' ? 'You paused it' : undefined };
  repaint(id);
  try {
    if (action === 'drop') await api(`/sessions/${id}/goal`, { method: 'DELETE', body: {} });
    else await api(`/sessions/${id}/goal`, { method: 'PATCH', body: { action } });
    if (action === 'drop') toast(`${icon('target')} Goal dropped`, { action: { label: 'Undo', run: () => setGoal(id, prev.text) } });
  } catch (err) {
    if (S.sessions.get(id) === s) (s.goal = prev), (s.later = prevLater), repaint(id);
    toastError(err);
  }
}

export async function setGoal(id, text) {
  const s = S.sessions.get(id);
  if (!s) return;
  const prev = s.goal;
  s.goal = { ...(prev && LIVE.has(prev.status) ? prev : { round: 1, checks: [], setAt: Date.now() }), text, status: s.state === 'running' && prev?.status !== 'checking' ? 'working' : 'checking' };
  repaint(id);
  try {
    await api(`/sessions/${id}/goal`, { method: 'PUT', body: { text } });
  } catch (err) {
    if (S.sessions.get(id) === s) (prev ? (s.goal = prev) : delete s.goal), repaint(id);
    toastError(err);
  }
}

// Set goal… / Edit goal…: a popover by what asked, with the condition.
export function editGoal(id, anchor) {
  const s = S.sessions.get(id);
  if (!s) return;
  $('.menu.goal-pop')?.close();
  const node = el(`
    <div class="menu goal-pop" role="dialog" aria-label="${s.goal ? 'Edit goal' : 'Set goal'}">
      <label class="gp-k" for="goalText">${icon('target')}Done when</label>
      <textarea id="goalText" rows="3" spellcheck="false" placeholder="all tests pass and the page works on a phone"></textarea>
      <p class="gp-hint">wisp checks after every round, reading the code and running the tests, and sends it back with what’s missing.</p>
      <div class="gp-foot"><span class="grow"></span><button class="ghost sm" data-a="no">Cancel</button><button class="primary sm" data-a="yes">${s.goal ? 'Save goal' : 'Set goal'}</button></div>
    </div>`);
  const ta = $('textarea', node);
  ta.value = s.goal?.text || '';
  const go = () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    close();
    setGoal(id, text);
  };
  node.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'no') close();
    if (a === 'yes') go();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go();
    }
  });
  const close = popover(node, { anchor, capture: true });
  const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const x = r ? r.right - w : (innerWidth - w) / 2;
  const y = r ? (r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : r.top - 6 - h) : innerHeight * 0.18;
  node.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// The launcher's Goal: a toggle in its bar and, while on, a "Done when" line under the prompt.
// On/off and the text survive a reload.
export function launcherGoal(box, ta) {
  const btn = $('#goalBtn', box);
  const line = $('.l-goal', box);
  const input = $('input', line);
  let on = false; // every prompt starts without a goal: the user turns it on for this one
  input.value = S.drafts.get('home-goal') || '';
  const paint = () => {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    btn.innerHTML = `${icon('target')}<span>Goal</span>`;
    btn.title = on ? 'Goal: the task keeps going until “Done when” holds. Click to launch without one.' : 'Goal: keep going until a condition holds (wisp checks after every round)';
    line.hidden = !on;
  };
  paint();
  btn.onclick = () => {
    on = !on;
    paint();
    (on ? input : ta).focus();
  };
  input.addEventListener('input', () => S.drafts.set('home-goal', input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') (e.preventDefault(), ta.focus());
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), $('#launch', box).click());
  });
  // A bare /goal in the box: open Done when and type there.
  box.goalOpen = () => {
    if (on) return input.focus();
    btn.click();
  };
  // What the launch sends: { text }, or nothing. Taking it clears the line and turns Goal off for
  // the next prompt (both back on failure).
  box.goal = () => {
    if (!on) return null;
    const text = input.value.trim();
    if (!text) {
      toast(`${icon('target')} No goal: Done when is empty`);
      return null;
    }
    return { text };
  };
  box.goalTaken = (goal) => {
    if (!goal) return () => {};
    input.value = '';
    S.drafts.delete('home-goal');
    on = false;
    paint();
    return () => {
      input.value = goal.text;
      S.drafts.set('home-goal', goal.text);
      on = true;
      paint();
    };
  };
}

export const launcherGoalHtml = () => `<div class="l-goal" hidden><span class="lg-k">${icon('target')}<span>Done when</span></span><input type="text" spellcheck="false" placeholder="all tests pass and it works on a phone" aria-label="Done when"></div>`;
