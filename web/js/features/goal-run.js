// One goal check, to read like a task: what the checker was told, what it did, how it voted. A page
// laid over the open task (it stays open underneath, so Back finds it where it was, scrolled as it
// was) with the task's own transcript. Read-only: no reply box, band or Ship; a check isn't a task
// (server/goal-runs.js), so it's never a row, a result or a notification. Opened from the checks
// popover (judges.js). Under way, it grows from the same steps a task's transcript does.
//
// Spells reach it through spell-schema.js: goal.run, goal.runHead, goal.runVote, goal.runPrompt.

import { renderPresentation } from '../blocks.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { actionCount, turnTime } from '../core/format.js';
import { esc } from '../md.js';
import { viewImage } from '../ui/viewer.js';
import { openInEditor, revealFile } from './actions.js';
import { faceOf, SAID, VOTE_ICON } from './judges.js';
import { agentName, modelBadge } from './runners.js';
import { paintSplit, splitOpen } from './split.js';
import { appendStep, judgeResult, renderLiveTranscript, renderTranscript, sameStep, updateStep } from './transcript.js';

S.goalRun = null; // { task, run, hint }: not kept over a reload, the task is
let view = null;
let rec = null; // the record on the page
let early = []; // steps that came in while the record loaded
let caughtUp = false;
const kept = new Map(); // finished records: they don't change, so a second look paints at once

const ENDS = {
  timeout: 'It ran out of time, so it voted for nothing. This is what it got done.',
  stopped: 'It was stopped before it voted. This is what it got done.',
  error: 'Its run failed before it voted.',
  nojson: 'It answered, but its answer had no vote in it.',
  interrupted: 'wisp restarted during this check, so it never voted.',
};

function shell() {
  if (view) return view;
  view = el('<div class="goal-run" id="goalRun" role="region" aria-label="Goal check" tabindex="-1" hidden></div>');
  document.body.append(view);
  view.addEventListener('click', (e) => {
    if (e.target.closest('.gr-back')) return closeGoalRun();
    const more = e.target.closest('.more-btn');
    if (more) {
      const text = $('.ask-text', more.parentElement);
      more.textContent = text.classList.toggle('clamped') ? 'Show all' : 'Show less';
    }
  });
  return view;
}

// Which judge, which round, how it voted and why: from what opened it at once, so it never loads.
function headHtml(h) {
  const running = h.status === 'running' || (h.live && !h.status);
  const v = h.verdict;
  const who = h.crew || h.agent ? faceOf(h, 28) : icon('target');
  const run = [agentName(h.agent), h.model].filter(Boolean).join(' · ');
  return `
    <header class="gr-head">
      <button class="ghost xs gr-back">${icon('back')}Back to the task</button>
      <div class="gr-who">
        <span class="jv-face">${who}</span>
        <span class="gr-name"><b>${esc(h.name || 'Goal check')}</b><small>Round ${esc(h.round ?? '')}${run && h.name !== run ? ` · ${esc(run)}` : ''}</small></span>
        <span class="gr-vote v-${running ? 'none' : esc(v || 'none')}">${running ? 'Checking' : v ? `${icon(VOTE_ICON[v] || 'minus')}${SAID[v] || esc(v)}` : ''}</span>
      </div>
      ${h.why ? `<p class="gr-why">${esc(h.why)}</p>` : ''}
      ${h.next ? `<p class="gr-next"><b>Next</b> ${esc(h.next)}</p>` : ''}
      ${h.end && ENDS[h.end] ? `<p class="gr-end">${ENDS[h.end]}</p>` : ''}
    </header>`;
}

// The real shapes while it loads: the prompt's box and a few steps.
const skeleton = () => `
  <div class="gr-skel" aria-hidden="true">
    <div class="ask"><i class="sk" style="width:92%"></i><i class="sk" style="width:78%"></i><i class="sk" style="width:64%"></i></div>
    ${[58, 72, 44, 66, 50].map((w) => `<div class="gr-sk-step"><i class="sk gr-sk-ic"></i><i class="sk" style="width:${w}%"></i></div>`).join('')}
  </div>`;

function askHtml(r) {
  const t = r.turn;
  return `
    <div class="ask by-wisp gr-prompt">
      <div class="ask-by">${icon('target')}What wisp asked it</div>
      <div class="ask-text clamped">${esc(t.prompt)}</div>
      <button class="link xs more-btn">Show all</button>
      <div class="ask-foot">${modelBadge(r.agent, r.model || '', r.effort || '', null, null, null)}${turnTime(t.startedAt)}</div>
    </div>`;
}

const ctxOf = (s, t) => ({
  session: s,
  turn: t,
  isLatest: false,
  openFile: (p, line) => openInEditor(s, p, line),
  fileUrl: (p) => `/api/sessions/${s.id}/file?path=${encodeURIComponent(p)}`,
  zoom: (src, alt, set) => viewImage(src, alt, set),
  reveal: (p) => revealFile(s, p),
  keep: null,
});

function workingPanel(r) {
  return el(`
    <div class="w-panel tx-panel">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status">
          <b>${esc(r.name)} is checking</b>
          <span class="elapsed" data-start="${r.turn.startedAt}">0s</span>
          <span class="w-count">${actionCount(r.turn)}</span>
        </div>
      </div>
    </div>`);
}

function paintRecord(r) {
  rec = r;
  const s = S.full.get(S.goalRun.task) || S.sessions.get(S.goalRun.task);
  const t = { ...r.turn, presentation: judgeResult(r) };
  rec.turn = t;
  const ctx = ctxOf(s, t);
  view.innerHTML = `<div class="gr-page">${headHtml(r)}${askHtml(r)}<div class="gr-turn"></div></div>`;
  const box = $('.gr-turn', view);
  if (r.status === 'running') box.append(renderLiveTranscript(s, t, ctx), workingPanel(r));
  else box.append(renderTranscript(s, t, ctx));
  for (const d of early.splice(0)) onStep(d);
}

async function load() {
  const { task, run } = S.goalRun;
  try {
    const r = await api(`/sessions/${task}/goal-runs/${run}`);
    if (S.goalRun?.run !== run) return;
    if (r.status !== 'running') kept.set(run, r);
    paintRecord(r);
  } catch {
    if (S.goalRun?.run !== run) return;
    early = [];
    const page = $('.gr-page', view);
    rec = null;
    $('.gr-skel', page)?.remove();
    page.insertAdjacentHTML('beforeend', '<p class="gr-end">This check isn’t kept any more. A goal keeps its last 50.</p>');
  }
}

export function openGoalRun(task, hint) {
  shell();
  S.goalRun = { task, run: hint.run, hint };
  rec = null;
  early = [];
  caughtUp = false;
  view.hidden = false;
  view.scrollTop = 0;
  const known = kept.get(hint.run);
  if (known) paintRecord(structuredClone(known));
  else {
    view.innerHTML = `<div class="gr-page">${headHtml(hint)}${skeleton()}</div>`;
    load();
  }
  view.focus({ preventScroll: true });
}

// Back, Esc, the head's ×, the phone's Back: to the task, as it was. True if it was open.
export function closeGoalRun({ paint = true } = {}) {
  if (!S.goalRun) return false;
  const { task } = S.goalRun;
  S.goalRun = null;
  rec = null;
  view.hidden = true;
  view.textContent = '';
  if (paint) {
    paintSplit();
    $('.gb-check', S.nodes.get(task)?.body)?.focus?.({ preventScroll: true });
  }
  return true;
}

// After every render of the page (split.js): it goes when its task does, and a run that ended while
// the stream was down catches up.
export function paintGoalRun() {
  if (!S.goalRun) return;
  if (splitOpen() !== S.goalRun.task) return void closeGoalRun({ paint: false });
  if (rec?.status === 'running' && !caughtUp && S.sessions.get(S.goalRun.task)?.goal?.status !== 'checking') {
    caughtUp = true; // once: a check you stopped can run on to its time limit, and says when it ends
    load();
  }
}

function onStep(d) {
  if (S.goalRun?.run !== d.run) return;
  if (d.done) return rec ? load() : early.push(d);
  if (!rec) return early.push(d);
  const t = rec.turn;
  if (d.update) {
    const known = t.activity.findLast((a) => sameStep(a, d.item));
    if (known) Object.assign(known, d.item);
    return updateStep(view, d.item, t);
  }
  if (t.activity.some((a) => sameStep(a, d.item))) return; // it was in the record already
  t.activity.push(d.item);
  appendStep($('.gr-turn', view), d.item, t, (dy) => {
    view.scrollTop += dy;
  });
  const n = $('.w-count', view);
  if (n) n.textContent = actionCount(t);
}

bus.on('goal-run', onStep);
