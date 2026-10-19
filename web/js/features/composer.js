// The composer at the bottom of an expanded card: follow-ups, answers, queued follow-ups.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { toggleDone } from './actions.js';
import { acceptFiles, attachTray, autosize } from './attachments.js';
import { renderFeed, scheduleRefetch, setFocus } from './feed.js';
import { feedbackCommand, isFeedback } from './feedback.js';
import { placeName } from './places.js';
import { runnerPicker } from './runner-picker.js';
import { agentById, agentName, DEFAULT_MODE, effortLabel, effortsFor, harnessesAt, harnessLogo, modeMenu, MODES, runnerTip, savedEffort, savedModel } from './runners.js';
import { feedAnchor, keepInPlace, watching } from './scroll.js';
import { shipDialog } from './ship.js';
import { renderBody } from './turns.js';

export function draftInto(id, text) {
  const ta = $('.reply', S.nodes.get(id)?.card);
  if (!ta) return;
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
}

export function renderDock(id) {
  const n = S.nodes.get(id);
  const dock = $('.it-dock', n.body);
  const comp = el(`
    <div class="composer">
      <ul class="c-queued"></ul>
      <textarea class="reply" rows="1" spellcheck="false"></textarea>
      <div class="c-bar">
        <button class="icon-btn c-attach" title="Attach files">${icon('clip')}</button>
        <button class="mode-btn c-mode" aria-haspopup="menu"></button>
        <button class="c-runner" aria-haspopup="dialog"></button>
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
  const modeBtn = $('.c-mode', comp);
  modeBtn.onclick = () => modeMenu(modeBtn, replyMode(id), (m) => (setReplyMode(id, m), ta.focus()));
  const runnerBtn = $('.c-runner', comp);
  runnerBtn.onclick = () => {
    pickReplyRunner(id, runnerBtn);
  };
  ta.value = S.drafts.get(id) || '';
  ta.addEventListener('input', () => S.drafts.set(id, ta.value));
  ta.addEventListener('focus', () => setFocus(id, { scroll: false }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendReply(id, ta.value);
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setReplyMode(id, MODES[(MODES.findIndex((m) => m.id === replyMode(id)) + 1) % MODES.length].id);
    }
  });
  $('.send', comp).onclick = () => sendReply(id, ta.value);
}

// The mode the next follow-up runs in: the session's own until the user picks another here.
// The pick goes out with that follow-up and stays from then on.
const replyMode = (id) => S.replyModes.get(id) || S.full.get(id)?.mode || DEFAULT_MODE.id;

function setReplyMode(id, mode) {
  if (mode === S.full.get(id)?.mode) S.replyModes.delete(id);
  else S.replyModes.set(id, mode);
  updateDock(id);
}

function paintReplyMode(id, btn) {
  const s = S.full.get(id);
  const m = MODES.find((x) => x.id === replyMode(id)) || DEFAULT_MODE;
  const from = s && S.replyModes.has(id) && MODES.find((x) => x.id === s.mode);
  btn.className = `mode-btn c-mode m-${m.id}${from ? ' changed' : ''}`;
  btn.innerHTML = `${icon(m.icon)}${m === DEFAULT_MODE && !from ? '' : `<span>${m.label}</span>`}`;
  btn.title = from
    ? `${m.label}: ${m.hint}\nYour next follow-up switches this task from ${from.label} to ${m.label}. Shift+Tab to switch`
    : `${m.label}: ${m.hint}\nPick another mode for your next follow-up. Shift+Tab to switch`;
  // Subagents run in their lead's mode; the tour has nothing to run.
  btn.hidden = !s || s.agent === 'wisp' || !!s.parentId;
}

// The harness, model and thinking level the next follow-up runs on: the session's own until the
// user picks another here. Like the mode, the pick goes out with that follow-up and stays.
const replyRunner = (id) => {
  const s = S.full.get(id);
  return S.replyRunners.get(id) || { agent: s?.agent, model: s?.model || '', effort: s?.effort || '' };
};

function setReplyRunner(id, run) {
  const s = S.full.get(id);
  if (s && run.agent === s.agent && run.model === (s.model || '') && run.effort === (s.effort || '')) S.replyRunners.delete(id);
  else S.replyRunners.set(id, run);
  updateDock(id);
}

function pickReplyRunner(id, btn) {
  const s = S.full.get(id);
  if (!s) return;
  const cur = replyRunner(id);
  // The session's own harness offers its own model first; other harnesses their remembered one.
  const model = (a) => (a === s.agent && (agentById(a)?.models || []).some((m) => m.id === s.model) ? s.model : savedModel(a));
  const effort = (a, m) => (a === s.agent && m === s.model && effortsFor(a, m).includes(s.effort) ? s.effort : savedEffort(a, m));
  runnerPicker(btn, { agent: cur.agent, model: cur.model, effort: cur.effort, savedModel: model, savedEffort: effort, places: [s.machine?.id || ''] }, (agent, m, e) => {
    setReplyRunner(id, { agent, model: m, effort: e });
  });
}

function paintReplyRunner(id, btn) {
  const s = S.full.get(id);
  const run = replyRunner(id);
  const changed = !!s && S.replyRunners.has(id);
  const harness = agentName(run.agent);
  btn.className = `c-runner${changed ? ' changed' : ''}`;
  // One quiet logo until it changes; then it says where the next follow-up goes.
  const model = (run.model && agentById(run.agent)?.models?.find((m) => m.id === run.model)?.label) || run.model || 'Default';
  const label = run.agent === s?.agent ? model : `${harness} · ${model}`;
  btn.innerHTML = `<span class="rb-logo">${harnessLogo(run.agent)}</span>${changed ? `<span class="cr-label">${esc(label)}</span>${run.effort ? `<span class="rb-e">${esc(effortLabel(run.effort))}</span>` : ''}` : ''}`;
  const now = runnerTip(s?.agent, s?.model, s?.effort);
  const where = s?.machine ? ` (on ${placeName(s.machine.id)})` : '';
  btn.title = !changed
    ? `${now}\nPick another harness or model for your next follow-up${where}`
    : run.agent !== s.agent
      ? `${runnerTip(run.agent, run.model, run.effort)}\nYour next follow-up moves this task from ${agentName(s.agent)} to ${harness}, with the conversation so far. Click to change`
      : `${runnerTip(run.agent, run.model, run.effort)}\nYour next follow-up switches from ${now}. Same conversation. Click to change`;
  btn.hidden = !s || s.agent === 'wisp' || !!s.parentId || !harnessesAt([s.machine?.id || '']).some((a) => a.available);
}

export function updateDock(id) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  const ta = n && $('.reply', n.card);
  if (!s || !ta) return;
  const name = agentName(s.agent);
  const next = agentName(replyRunner(id).agent); // where the next follow-up goes, if it was switched
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
          ? next !== name
            ? `Follow up with ${next} to reopen…`
            : 'Follow up to reopen…'
          : `Follow up with ${next}…`;
  $('.c-hint', n.card).innerHTML = s.queue?.length ? `${s.queue.length} queued` : '';
  paintReplyMode(id, $('.c-mode', n.card));
  paintReplyRunner(id, $('.c-runner', n.card));
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
  const key = (s.queue || []).map((q) => `${q.id}${q.run ? `:${q.run.agent}/${q.run.model}` : ''}`).join();
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.innerHTML = '';
  (s.queue || []).forEach((q, i) => {
    const li = el(`
      <li class="cq">
        <span class="cq-tag">${i === 0 ? `Next · after ${esc(name)} finishes` : `Queued #${i + 1}`}${q.run ? ` · on ${esc(runnerTip(q.run.agent, q.run.model, ''))}` : ''}</span>
        <span class="cq-text">${esc(q.text)}</span>
        <button class="att-x" title="Cancel this follow-up">${icon('x')}</button>
      </li>`);
    const cancel = () => {
      // Items queued by a wisp older than queue ids get one when wisp restarts.
      if (!q.id) return toast('Restart wisp to cancel this follow-up.', { tone: 'bad' });
      const short = q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text;
      if (!confirm(`Cancel this queued follow-up?\n\n“${short}”`)) return;
      api(`/sessions/${s.id}/queue?item=${encodeURIComponent(q.id)}`, { method: 'DELETE' }).catch(toastError);
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
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'cancel') cancel();
  };
  const close = popover(menu);
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
  await api('/config', { method: 'PATCH', body: { defaults: { followUp } } }).catch(toastError);
}

export async function sendReply(id, text) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  text = (text || '').trim();
  if (!s || !text) return;
  const ta = n && $('.reply', n.card);
  if (isFeedback(text)) {
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    return feedbackCommand(text, { sessionId: id, restore: () => ta?.isConnected && !ta.value && ((ta.value = text), ta.dispatchEvent(new Event('input'))) });
  }
  if (n?.tray?.busy) toast('Waiting for uploads…');
  const attachments = n?.tray ? await n.tray.ids() : [];
  const mode = S.replyModes.get(id);
  const run = S.replyRunners.get(id);
  // An answer goes to the run that asked; a new mode or harness needs a new run, so that's a follow-up.
  const answering = !!s.ask && !attachments.length && !mode && !run;
  // Optimistic: the composer empties and the card goes to Working before the server answers
  // (it may first have to bring back an archived worktree, or reach another machine).
  if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
  S.drafts.delete(id);
  S.replyModes.delete(id);
  S.replyRunners.delete(id);
  const files = n?.tray?.take();
  const undo = startOptimistic(id, text, files, { answering, mode, run });
  try {
    const r = answering
      ? await api(`/sessions/${id}/answer`, { method: 'POST', body: { text } })
      : await api(`/sessions/${id}/reply`, { method: 'POST', body: { text, attachments, queue: queueing(), mode, ...run } });
    if (undo) scheduleRefetch(id); // the summary that follows says "running" too, so it won't refetch by itself
    if (r.queued)
      toast(r.ahead ? `Queued behind ${r.ahead} earlier follow-up${r.ahead > 1 ? 's' : ''} — they go out first, in order.` : 'Queued — it goes out as soon as the agent finishes.');
  } catch (err) {
    undo?.();
    // Give the message back, unless the user has already started typing another one.
    if (ta?.isConnected && !ta.value) ((ta.value = text), ta.dispatchEvent(new Event('input')));
    if (mode && !S.replyModes.has(id)) setReplyMode(id, mode);
    if (run && !S.replyRunners.has(id)) setReplyRunner(id, run);
    n?.tray?.restore(files);
    toastError(err);
  }
}

// Show a follow-up as started right away: the card moves to Working with the prompt as a live
// turn. Only when it will start now, not when it queues or interrupts a run already working.
// Returns an undo for a failed send, or null when nothing changed.
export function startOptimistic(id, text, files, { answering, mode, run }) {
  const full = S.full.get(id);
  const sum = S.sessions.get(id);
  if (!full || !sum) return null;
  const live = full.state === 'running' || full.state === 'waiting';
  if (live && !answering) return null;
  const now = Date.now();
  const turn = { id: `pending-${now}`, prompt: text, status: 'running', startedAt: now, activity: [], attachments: (files || []).filter((f) => f.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime })) };
  if (mode) turn.mode = mode;
  if (run) Object.assign(turn, run);
  const nextFull = { ...full, state: 'running', ask: null, turns: answering ? full.turns : [...full.turns, turn], ...(mode && { mode }), ...run };
  const nextSum = { ...sum, state: 'running', live: answering ? 'Picking up your answer' : run && run.agent !== full.agent ? `Handing over to ${agentName(run.agent)}` : 'Starting up', updatedAt: now, ...(mode && { mode }), ...run };
  const apply = (f, sm) => {
    S.full.set(id, f);
    S.sessions.set(id, sm);
    const card = S.nodes.get(id)?.card;
    keepInPlace(watching(id) ? card : feedAnchor(id), renderFeed);
    renderBody(id, { fresh: false });
  };
  apply(nextFull, nextSum);
  return () => {
    // A live update may already have replaced the guess; only roll back what is still ours.
    if (S.full.get(id) !== nextFull || S.sessions.get(id) !== nextSum) return scheduleRefetch(id);
    apply(full, sum);
  };
}
