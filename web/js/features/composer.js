// The composer at the bottom of an expanded card: follow-ups, answers, queued follow-ups, and
// side questions (/btw), which don't interrupt the run.

import { esc } from '../md.js';
import { btwQuestion, goalAsk, isBtw, isGoalDrop, SPELL_HINT, spellAsk } from '../slash-text.js';
import { editGoal, goalAction, setGoal } from './goal.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { here, S, saveOpen } from '../core/state.js';
import { toast, toastError } from '../ui/toast.js';
import { toggleDone } from './actions.js';
import { acceptFiles, attachTray, autosize } from './attachments.js';
import { askBtw, askCrew, btwTipShown } from './btw.js';
import { addressedTo } from './crew.js';
import { expand, renderFeed, scheduleRefetch, setFocus } from './feed.js';
import { feedbackCommand, isFeedback } from './feedback.js';
import { mentionBox } from './mentions.js';
import { connectMachine } from './machines.js';
import { placeMenu } from './place-menu.js';
import { machineById, placeName } from './places.js';
import { runnerPicker } from './runner-picker.js';
import { accountMark, accountOf, agentById, agentName, DEFAULT_MODE, effortLabel, effortsFor, harnessesAt, harnessLogo, modeMenu, MODES, runnerTip, savedAccount, savedEffort, savedModel } from './runners.js';
import { feedAnchor, keepFollowing, keepInPlace, watching } from './scroll.js';
import { shipDialog } from './ship.js';
import { slashMenu } from './slash.js';
import { renderBody } from './turns.js';
import { paintCard, runAction, spellProp } from './spells.js';
import { spellSlash } from './launcher.js';
import { cast } from './spell-ui.js';
import { canLead, copiesOf, memberLabel, paintTeamBtn, teamEditor } from './team.js';
import { parseWhen } from '../when.js';
import { aheadLabel, followUpItems, scheduleFollowUp, timeMenu, whenTip } from './later.js';
import { keyedRows, queuedItems } from './queued.js';
import { hideHold, holdNow, showHold } from './hold.js';
import { commentCount, commentTray, paintCommentTray, restoreComments, takeComments, withPending } from './comments.js';

export function draftInto(id, text) {
  const ta = $('.reply', S.nodes.get(id)?.card);
  if (!ta) return;
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
}

// Split view folds an empty follow-up box to one line while you read. Once you're in it, it stays
// open through its own pickers (harness, mode, computer: they open on <body> and take focus) until
// you click or tab somewhere else on the page.
const OWN_POPUPS = '.picker, .menu, .overlay, .team-pop';
// Moving to another task in the list from an open box keeps it open: the old one goes with its
// task without folding first, and the new task's box is drawn open (feed.js then focuses it).
let carry = false;
let carryTo = null;
export function carryDock(id) {
  carryTo = carry ? id : null;
}
// Folding hides the bar, which moves everything around the box: done on the press, the button
// under the pointer slides away before the click lands and needs a second one. So a press only
// folds once it's released and its click has gone through.
let pressed = false;
function settle(e) {
  if (e.type === 'pointerdown') carry = !!e.target.closest?.('body.split #feed .it-head') && !!document.querySelector('.composer:is(.awake, :has(.reply:focus))');
  if (carry && e.target.closest?.('.it-head')) return;
  const folding = [...document.querySelectorAll('.composer.awake')].filter((c) => !c.contains(e.target) && !e.target.closest?.(OWN_POPUPS));
  if (!folding.length) return;
  if (e.type === 'pointerdown') {
    pressed = true;
    const release = () => {
      removeEventListener('pointerup', release, true);
      removeEventListener('pointercancel', release, true);
      setTimeout(() => {
        pressed = false;
        // A box the click put the focus back into stays open.
        for (const c of folding) if (!c.contains(document.activeElement)) c.classList.remove('awake');
      });
    };
    addEventListener('pointerup', release, true);
    addEventListener('pointercancel', release, true);
    return;
  }
  if (pressed) return; // the press's own focus change: its release folds
  for (const c of folding) c.classList.remove('awake');
}
document.addEventListener('pointerdown', settle, true);
document.addEventListener('focusin', settle, true);

export function renderDock(id) {
  const n = S.nodes.get(id);
  const dock = $('.it-dock', n.body);
  const comp = el(`
    <div class="composer">
      <ul class="c-queued"></ul>
      <div class="c-hold" role="group" aria-label="Near the usage limit" aria-live="polite" hidden></div>
      <textarea class="reply" rows="1" spellcheck="false"></textarea>
      <div class="c-bar">
        <button class="icon-btn c-attach" title="Attach files">${icon('clip')}</button>
        <button class="mode-btn c-mode" aria-haspopup="menu"></button>
        <button class="c-runner" aria-haspopup="dialog"></button>
        <button class="c-place" aria-haspopup="menu" hidden></button>
        <button class="team-btn c-team" aria-haspopup="dialog" hidden></button>
        <span class="c-hint"></span>
        <button class="ghost sm c-ship" data-a="ship" aria-label="Ship it" title="Commit, push and open a pull request (S)" hidden>${icon('send')}<span>Ship it</span></button>
        <button class="ghost sm c-done" data-a="done" aria-label="Mark done" title="Mark done (E)">${icon('done')}<span>Mark done</span></button>
        <button class="ghost xs c-queue" aria-pressed="false" hidden>${icon('queue')}<span>Queue</span><i class="c-switch"></i></button>
        <button class="icon-btn c-later" aria-label="Send later" title="Send later" aria-haspopup="menu">${icon('clock')}</button>
        <button class="send" title="Send (Enter · Shift+Enter for newline)">${icon('enter')}</button>
      </div>
    </div>`);
  if (carryTo === id) (comp.classList.add('awake'), (carryTo = null));
  dock.append(comp);
  // Only typing opens it: a chip pressed in the folded box would move before the click landed.
  comp.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('reply')) comp.classList.add('awake');
  });
  n.tray = attachTray();
  comp.prepend(n.tray.node);
  $('.reply', comp).before(commentTray(id)); // comments on the answer, going out with the next message
  const ta = mentionBox($('.reply', comp));
  slashMenu(ta, comp);
  autosize(ta, 260);
  acceptFiles(comp, ta, n.tray);
  $('.c-attach', comp).onclick = n.tray.pick;
  $('.c-done', comp).onclick = () => toggleDone(id);
  $('.c-ship', comp).onclick = () => shipDialog(id);
  $('.c-queue', comp).onclick = toggleQueue;
  const modeBtn = $('.c-mode', comp);
  modeBtn.onclick = () => modeMenu(modeBtn, replyMode(id), (m) => setReplyMode(id, m), ta);
  const runnerBtn = $('.c-runner', comp);
  runnerBtn.onclick = () => {
    pickReplyRunner(id, runnerBtn);
  };
  const teamBtn = $('.c-team', comp);
  teamBtn.onclick = () => {
    pickReplyTeam(id, teamBtn);
  };
  const placeBtn = $('.c-place', comp);
  placeBtn.onclick = () => {
    pickReplyPlace(id, placeBtn);
  };
  ta.value = S.drafts.get(id) || '';
  ta.addEventListener('input', () => {
    S.drafts.set(id, ta.value);
    if (!ta.value.trim()) notTime.delete(id);
    paintSide(id);
    readWhen(id);
  });
  const laterBtn = $('.c-later', comp);
  laterBtn.onclick = () => pickSendTime(id, laterBtn, ta);
  ta.addEventListener('focus', () => setFocus(id, { scroll: false }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // A time set with the clock, or one wisp read (the chip shows it): scheduled. Alt+Enter sends
      // it now, as typed.
      if (e.altKey) armedAt.delete(id);
      else if (armedAt.has(id) && !isBtw(ta.value)) return sendArmed(id, ta);
      const w = !e.altKey && whenShown.get(id);
      if (w) return scheduleReply(id, w.at, w.rest, { remind: w.reminder, typed: ta.value });
      sendReply(id, ta.value);
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setReplyMode(id, MODES[(MODES.findIndex((m) => m.id === replyMode(id)) + 1) % MODES.length].id);
    }
  });
  $('.send', comp).onclick = () => {
    if (armedAt.has(id) && !isBtw(ta.value)) return sendArmed(id, ta);
    const w = whenShown.get(id);
    if (w) return scheduleReply(id, w.at, w.rest, { remind: w.reminder, typed: ta.value });
    sendReply(id, ta.value);
  };
  comp.addEventListener('click', (e) => {
    if (e.target.closest('.c-when-now')) {
      whenShown.delete(id);
      sendReply(id, ta.value);
    }
    if (e.target.closest('.c-when-clear')) {
      armedAt.delete(id);
      readWhen(id);
      paintSide(id);
      ta.focus();
    } else if (e.target.closest('.c-when-x')) {
      notTime.add(id);
      whenShown.delete(id);
      paintSide(id);
      ta.focus();
    }
  });
  paintCommentTray(id);
  paintCard(id); // what spells add to the box and the card
}

// "in 10 min check again", "remind me to … in 1 h": the time wisp read in a follow-up, shown in
// the hint row once you stop typing for a moment (so "at 2" doesn't flash 02:00 before "pm").
// Only a shown time schedules; × (Not a time) holds for that draft.
const whenShown = new Map(); // id -> { at, rest, reminder }
// A time set with Send later's clock, before or after typing: Enter schedules the follow-up then,
// and no time in the text replaces it.
const armedAt = new Map(); // id -> at
const passed = (id) => armedAt.has(id) && armedAt.get(id) < Date.now() + 60_000;

function pickSendTime(id, btn, ta) {
  timeMenu(btn, {
    back: ta,
    pick: (at) => {
      armedAt.set(id, at);
      clearTimeout(whenTimers.get(id));
      whenShown.delete(id);
      paintSide(id);
      ta.focus();
    },
  });
}

// Enter with a time set: scheduled, or (gone by while you typed) pick another; the draft waits.
function sendArmed(id, ta) {
  const text = ta.value.trim();
  if (!text) return ta.focus();
  if (passed(id)) return paintSide(id), pickSendTime(id, $('.c-later', S.nodes.get(id)?.card), ta);
  const at = armedAt.get(id);
  armedAt.delete(id);
  scheduleReply(id, at, text, { typed: ta.value, armed: at });
}
const notTime = new Set(); // ids whose draft isn't a time, as the user said
const whenTimers = new Map();
function readWhen(id) {
  clearTimeout(whenTimers.get(id));
  const s = S.full.get(id);
  const ta = $('.reply', S.nodes.get(id)?.card);
  const text = ta?.value || '';
  // Typing on: the chip that's up stays until the new reading is in, so the row doesn't flicker.
  const ok = !armedAt.has(id) && S.config.defaults?.readTimes !== 'off' && s && !s.ask && s.agent !== 'wisp' && s.kind !== 'reminder' && !s.parentId && !isBtw(text) && !addressedTo(text).members.length && !notTime.has(id);
  const now = ok ? parseWhen(text) : null;
  if (!now) {
    if (whenShown.delete(id)) paintSide(id);
    return;
  }
  whenTimers.set(
    id,
    setTimeout(() => {
      const again = parseWhen($('.reply', S.nodes.get(id)?.card)?.value || '');
      if (again) whenShown.set(id, again);
      else whenShown.delete(id);
      paintSide(id);
    }, 250),
  );
}

// Scheduled from the box: it empties at once and the row above it appears; back if refused. Its
// files go with it (wisp keeps uploads until it's sent). armed: the clock's time, set again if refused.
async function scheduleReply(id, at, text, { remind = false, typed, armed } = {}) {
  const n = S.nodes.get(id);
  const ta = n && $('.reply', n.card);
  if (n?.tray?.busy) toast('Waiting for uploads…');
  const attachments = !remind && n?.tray ? await n.tray.ids() : [];
  const files = (!remind && n?.tray?.take()) || [];
  const was = typed ?? ta?.value ?? text;
  whenShown.delete(id);
  if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
  S.drafts.delete(id);
  const ok = await scheduleFollowUp(id, { at, text, remind, attachments: attachments.length ? attachments : undefined });
  if (ok) return;
  n?.tray?.restore(files);
  if (ta?.isConnected && !ta.value) {
    if (armed) armedAt.set(id, armed);
    ta.value = was;
    ta.dispatchEvent(new Event('input'));
  }
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
  btn.innerHTML = `${icon(m.icon)}<span>${m.label}</span>`;
  btn.setAttribute('aria-label', m.label); // the phone app hides the text
  btn.title = from
    ? `${m.label}: ${m.hint}\nYour next follow-up switches this task from ${from.label} to ${m.label}. Shift+Tab to switch`
    : `${m.label}: ${m.hint}\nPick another mode for your next follow-up. Shift+Tab to switch`;
  // Subagents run in their lead's mode; the tour has nothing to run.
  btn.hidden = !s || s.agent === 'wisp' || !!s.parentId;
}

// The harness, model and thinking level the next follow-up runs on: the session's own until the
// user picks another here. Like the mode, the pick goes out with that follow-up and stays.
// The account too ('' when the harness has one, or wisp picks): follow-ups stay on the task's.
const replyRunner = (id) => {
  const s = S.full.get(id);
  return S.replyRunners.get(id) || { agent: s?.agent, model: s?.model || '', effort: s?.effort || '', account: s?.account || '' };
};

function setReplyRunner(id, run) {
  const s = S.full.get(id);
  if (s && run.agent === s.agent && run.model === (s.model || '') && run.effort === (s.effort || '') && (run.account || '') === (s.account || '')) S.replyRunners.delete(id);
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
  const account = (a) => (a === s.agent && s.account ? s.account : savedAccount(a));
  const back = $('.reply', S.nodes.get(id)?.card); // back to typing the follow-up
  runnerPicker(btn, { agent: cur.agent, model: cur.model, effort: cur.effort, account: cur.account || '', savedModel: model, savedEffort: effort, savedAccount: account, places: [replyPlace(id)], back }, (agent, m, e, acc) => {
    setReplyRunner(id, { agent, model: m, effort: e, account: acc || '' });
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
  const acc = accountOf(run.agent, run.account);
  btn.innerHTML = `<span class="rb-logo">${harnessLogo(run.agent)}${acc ? accountMark(acc) : ''}</span>${changed ? `<span class="cr-label">${esc(label)}</span>${run.effort ? `<span class="rb-e">${esc(effortLabel(run.effort))}</span>` : ''}${acc ? `<span class="rb-a">${esc(acc.label)}</span>` : ''}` : ''}`;
  const now = runnerTip(s?.agent, s?.model, s?.effort, s?.account);
  const where = s?.machine || S.replyPlaces.has(id) ? ` (on ${placeName(replyPlace(id))})` : '';
  btn.title = !changed
    ? `${now}\nPick another harness or model for your next follow-up${where}`
    : run.agent !== s.agent
      ? `${runnerTip(run.agent, run.model, run.effort, run.account)}\nYour next follow-up moves this task from ${agentName(s.agent)} to ${harness}, with the conversation so far. Click to change`
      : `${runnerTip(run.agent, run.model, run.effort, run.account)}\nYour next follow-up switches from ${now}. Same conversation. Click to change`;
  btn.hidden = !s || s.agent === 'wisp' || !!s.parentId || !harnessesAt([replyPlace(id)]).some((a) => a.available);
}

// The subagents the lead can delegate to from the next follow-up on: the session's own team (none
// for a task launched without one) until the user picks another here. The pick goes out with that
// follow-up and stays; members the lead already used keep their conversation.
const sameTeam = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
const replyTeam = (id) => (S.replyTeams.has(id) ? S.replyTeams.get(id).team : S.full.get(id)?.subagents || []);

function setReplyTeam(id, team, preset) {
  const s = S.full.get(id);
  if (s && sameTeam(team, s.subagents)) S.replyTeams.delete(id);
  else S.replyTeams.set(id, { team, preset });
  updateDock(id);
}

function pickReplyTeam(id, btn) {
  if (!S.full.get(id)) return;
  const run = replyRunner(id);
  teamEditor(btn, { lead: run.agent, leadModel: run.model, leadEffort: run.effort, team: replyTeam(id), presetId: S.replyTeams.get(id)?.preset || '', places: [replyPlace(id)] }, (members, preset) => {
    setReplyTeam(id, members, preset);
  });
}

function paintReplyTeam(id, btn) {
  const s = S.full.get(id);
  const team = replyTeam(id);
  const lead = replyRunner(id).agent;
  const changed = !!s && S.replyTeams.has(id);
  const open = btn.classList.contains('open');
  paintTeamBtn(btn, team, S.replyTeams.get(id)?.preset || '', lead);
  btn.classList.add('c-team');
  btn.classList.toggle('changed', changed);
  btn.classList.toggle('open', open);
  const list = team.map((m) => `• ${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n');
  btn.title = !canLead(lead)
    ? `${agentName(lead)} can't delegate (wisp can't give it tools), so follow-ups run without delegates`
    : changed
      ? team.length
        ? `Your next follow-up lets ${agentName(lead)} delegate to:\n${list}\nClick to change`
        : `Your next follow-up runs without delegates. Click to change`
      : team.length
        ? `${agentName(lead)} can delegate to:\n${list}\nClick to change them for your next follow-up`
        : `Delegate: give ${agentName(lead)} agents on other harnesses or machines to hand work to from your next follow-up`;
  // Subagents don't get a team of their own; a lead that can't delegate only shows one it has.
  btn.hidden = !s || s.agent === 'wisp' || !!s.parentId || (!canLead(lead) && !team.length);
}

// Where the next follow-up runs: where the task is, until the user picks another computer here.
// Then the follow-up moves the task there, its work and history with it (server/services/move.js).
const placeNow = (s) => s?.machine?.id || '';
const replyPlace = (id) => (S.replyPlaces.has(id) ? S.replyPlaces.get(id) : placeNow(S.full.get(id)));

function setReplyPlace(id, k) {
  const s = S.full.get(id);
  if (!s) return;
  if (k === placeNow(s)) S.replyPlaces.delete(id);
  else S.replyPlaces.set(id, k);
  if (k && machineById(k)?.state === 'off') connectMachine(k);
  // The harness it runs on has to be there: keep it if it is, else the first one that is.
  const run = replyRunner(id);
  const there = harnessesAt([k]).filter((a) => a.available);
  if (there.length && !there.some((a) => a.id === run.agent)) {
    const a = there[0].id;
    const m = savedModel(a);
    setReplyRunner(id, { agent: a, model: m, effort: savedEffort(a, m), account: savedAccount(a) });
  }
  updateDock(id);
}

function pickReplyPlace(id, btn) {
  const s = S.full.get(id);
  if (!s) return;
  const busy = s.state === 'running' || s.state === 'waiting';
  placeMenu(
    btn,
    {
      title: 'Next follow-up runs on',
      current: replyPlace(id),
      from: placeNow(s),
      note: 'Another computer takes the task with it: its branch, uncommitted changes and history. wisp clones the project there if it has to.',
      locked: busy ? 'Stop the task or let it finish to move it to another computer.' : '',
      back: $('.reply', S.nodes.get(id)?.card),
    },
    (k) => {
      setReplyPlace(id, k);
    },
  );
}

function paintReplyPlace(id, btn) {
  const s = S.full.get(id);
  const k = replyPlace(id);
  const changed = !!s && S.replyPlaces.has(id);
  btn.className = `c-place${changed ? ' changed' : ''}`;
  btn.innerHTML = `${icon(k ? 'server' : 'laptop')}${changed ? `<span class="cr-label">${esc(placeName(k))}</span>` : ''}`;
  btn.title = changed
    ? `Your next follow-up moves this task from ${placeName(placeNow(s))} to ${placeName(k)}, with its work and history. Click to change`
    : `Runs on ${placeName(k)}. Pick another computer for your next follow-up`;
  // Only with machines to move to; subagents go where their lead is, the tour nowhere.
  btn.hidden = !s || !S.machines.length || s.agent === 'wisp' || !!s.parentId;
}

export function updateDock(id) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  const ta = n && $('.reply', n.card);
  if (!s || !ta) return;
  const name = agentName(s.agent);
  const next = agentName(replyRunner(id).agent); // where the next follow-up goes, if it was switched
  const tour = s.agent === 'wisp';
  const btw = btwTipShown() ? '' : '. /btw asks'; // the working panel's tip says it while it shows
  ta.disabled = tour;
  ta.placeholder = tour
    ? 'This is the tour — launch a real wisp from the box at the top'
    : s.ask
      ? s.ask.permission
        ? `Or tell ${name} what to do instead (denies this call)…`
        : `Answer ${name}…`
      : S.sessions.get(id)?.term
        ? `${name} is open in a terminal: carry on there, or end it to follow up here. /btw asks on the side`
      : s.state === 'running'
        ? queueing()
          ? next !== name
            ? `Queue a follow-up for ${next} — sent when ${name} finishes${btw && `${btw} now`}`
            : `Queue a follow-up — sent when ${name} finishes${btw && `${btw} now`}`
          : next !== name
            ? `Hand over to ${next} — interrupts ${name} and sends now${btw && `${btw} without interrupting`}`
            : `Steer ${name} — interrupts and sends now${btw && `${btw} without interrupting`}`
        : S.replyPlaces.has(id)
          ? `Follow up on ${replyPlace(id) ? placeName(replyPlace(id)) : here} with ${next}…`
          : (S.sessions.get(id)?.state || s.state) === 'done' // the summary: Mark done / Reopen change it first
            ? next !== name
              ? `Follow up with ${next} to reopen…`
              : 'Follow up to reopen…'
            : `Follow up with ${next}…`;
  const spellPh = spellProp('composer.input', 'placeholder');
  if (spellPh && !tour && !s.ask) ta.placeholder = spellPh;
  const notes = commentCount(id);
  if (notes && !tour && !s.ask) ta.placeholder = `Add a message, or send your ${notes > 1 ? `${notes} comments as they are` : 'comment as it is'}`;
  paintSide(id);
  paintReplyMode(id, $('.c-mode', n.card));
  paintReplyRunner(id, $('.c-runner', n.card));
  paintReplyPlace(id, $('.c-place', n.card));
  paintReplyTeam(id, $('.c-team', n.card));
  renderQueued(s, $('.c-queued', n.card), name);
  const q = $('.c-queue', n.card);
  q.hidden = tour || s.state !== 'running';
  q.classList.toggle('on', queueing());
  q.setAttribute('aria-pressed', queueing());
  q.title = queueing()
    ? `Queueing: follow-ups wait until ${name} finishes. Click to send now instead.`
    : `Sending now: follow-ups interrupt ${name}. Click to queue them instead.`;
}

// "/btw …" in the box: a side question, so the composer says it won't interrupt anything, and the
// mode and harness pickers (which are for the next follow-up) step back.
function paintSide(id) {
  const s = S.full.get(id);
  const comp = $('.composer', S.nodes.get(id)?.card);
  if (!s || !comp) return;
  const side = isBtw($('.reply', comp).value);
  const live = s.state === 'running' || s.state === 'waiting';
  comp.classList.toggle('is-btw', side);
  const armed = !side && armedAt.has(id) ? { at: armedAt.get(id) } : null;
  const w = armed || (!side && whenShown.get(id));
  const send = $('.send', comp);
  const touch = matchMedia('(pointer: coarse)').matches;
  send.title = side ? 'Ask on the side (Enter): nothing is interrupted' : w ? `${w.reminder ? 'Remind you' : 'Send'} at ${aheadLabel(w.at)}${touch ? '' : ' (Enter) · Alt+Enter sends now'}` : 'Send (Enter · Shift+Enter for newline)';
  const later = $('.c-later', comp);
  later.title = armed ? 'Change send time' : 'Send later';
  later.classList.toggle('on', !!w);
  later.hidden = s.agent === 'wisp' || s.kind === 'reminder' || !!s.parentId || side;
  const html = side
    ? `<span class="c-side">Side question</span> · ${live ? `${esc(agentName(s.agent))} keeps working` : 'no new turn'}`
    : armed
      ? `<span class="when-chip${passed(id) ? ' passed' : ''}" title="${esc(whenTip(w.at))}">${icon('clock')}<span>${passed(id) ? `${esc(aheadLabel(w.at))} has passed` : `Sends at ${esc(aheadLabel(w.at))}`}</span><button type="button" class="att-x c-when-clear" aria-label="Clear the time" title="Clear the time">${icon('x')}</button></span>`
      : w
        ? `<span class="when-chip" title="${esc(whenTip(w.at))}">${icon(w.reminder ? 'bell' : 'clock')}<span>${w.reminder ? `Reminds you at ${esc(aheadLabel(w.at))}` : `Sends at ${esc(aheadLabel(w.at))}`}</span>${w.reminder ? '' : '<button type="button" class="link c-when-now">Send now</button>'}<button type="button" class="att-x c-when-x" aria-label="Not a time" title="Not a time">${icon('x')}</button></span>`
        : '';
  const hint = $('.c-hint', comp);
  if (hint.dataset.h !== html) (hint.innerHTML = html), (hint.dataset.h = html);
}

// Follow-ups waiting their turn, shown above the composer so it's clear what goes out next
// (queued.js), then the ones scheduled for later, by time (later.js).
function renderQueued(s, list, name) {
  keyedRows(list, [...queuedItems(s, name), ...followUpItems(S.sessions.get(s.id) || {})]);
}

// Follow-ups sent while an agent works interrupt it, unless the user flipped this on.
const queueing = () => S.config?.defaults?.followUp === 'queue';

async function toggleQueue() {
  const followUp = queueing() ? 'now' : 'queue';
  S.config.defaults.followUp = followUp;
  S.nodes.forEach((_, id) => updateDock(id));
  await api('/config', { method: 'PATCH', body: { defaults: { followUp } } }).catch(toastError);
}

// confirm: you said yes to sending it although it takes the window past your line (Send anyway).
export async function sendReply(id, text, { confirm = false } = {}) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  text = (text || '').trim();
  // Comments on the answer go out on their own too: Enter in an empty box sends them.
  if (!s || (!text && !commentCount(id))) return;
  const ta = n && $('.reply', n.card);
  // A spell's slash command: it does its thing on this task instead of being sent.
  const slash = !isBtw(text) && spellSlash(text);
  if (slash) {
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    return runAction(slash.spell, slash.cmd.do, { session: id, args: slash.args, input: ta });
  }
  // A side question: answered next to the run, so nothing is interrupted, queued or switched.
  if (isBtw(text)) {
    const question = btwQuestion(text);
    if (!question) return toast('Type your question after /btw, like “/btw did you update the docs too?”');
    if (n?.tray?.busy) toast('Waiting for uploads…');
    const attachments = n?.tray ? await n.tray.ids() : [];
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    const files = n?.tray?.take() || [];
    const restore = () => {
      if (ta?.isConnected && !ta.value) ((ta.value = text), ta.dispatchEvent(new Event('input')));
      n?.tray?.restore(files);
    };
    return askBtw(id, question, { attachments, files, restore });
  }
  // "@Ada …": a message for a crew member, answered on this card; the task's agent carries on.
  const to = addressedTo(text);
  if (to.members.length) {
    if (!to.rest) return toast(`Tell ${esc(to.members.map((m) => m.name).join(' and '))} what to do after the name.`);
    if (n?.tray?.busy) toast('Waiting for uploads…');
    const attachments = n?.tray ? await n.tray.ids() : [];
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    const files = n?.tray?.take() || [];
    const restore = () => {
      if (ta?.isConnected && !ta.value) ((ta.value = text), ta.dispatchEvent(new Event('input')));
      n?.tray?.restore(files);
    };
    return askCrew(id, text, to.members, to.rest, { attachments, restore });
  }
  // /spell <what to change>: cast a spell (a task of its own) instead of sending a follow-up.
  const ask = spellAsk(text);
  if (ask !== null) {
    if (!ask) return toast(SPELL_HINT);
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    return cast(ask).catch((err) => {
      toastError(err);
      if (ta?.isConnected && !ta.value) ((ta.value = text), ta.dispatchEvent(new Event('input')));
    });
  }
  // /goal <condition>: the task keeps going until it holds (server/goal.js). Bare, it opens the
  // goal's popover; /goal drop drops it.
  const goal = goalAsk(text);
  if (goal !== null) {
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    if (!goal) return editGoal(id, ta);
    if (isGoalDrop(goal)) return S.sessions.get(id)?.goal ? goalAction(id, 'drop') : toast('This task has no goal to drop.');
    return setGoal(id, goal);
  }
  if (isFeedback(text)) {
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    return feedbackCommand(text, { sessionId: id, restore: () => ta?.isConnected && !ta.value && ((ta.value = text), ta.dispatchEvent(new Event('input'))) });
  }
  if (n?.tray?.busy) toast('Waiting for uploads…');
  const attachments = n?.tray ? await n.tray.ids() : [];
  const mode = S.replyModes.get(id);
  const run = S.replyRunners.get(id);
  const team = S.replyTeams.get(id);
  const place = S.replyPlaces.has(id) ? S.replyPlaces.get(id) : undefined;
  if (place !== undefined) {
    const notes = takeComments(id);
    return moveWithReply(id, notes.length ? withPending(id, text, notes) : text, { attachments, mode, run, team, place, notes, said: text });
  }
  // An answer goes to the run that asked; a new mode, harness or team needs a new run, so that's a follow-up.
  const answering = !!s.ask && !attachments.length && !mode && !run && !team;
  // Near the limit (features/hold.js): it waits for a yes, with the draft still in the box.
  const holdRow = n && $('.c-hold', n.card);
  const who = { agent: run?.agent || s.agent, account: run?.account ?? s.account ?? '' };
  // An answer's buttons and spells send text that was never in the box: the hold keeps it.
  const typed = !!ta && ta.value.trim() === text;
  if (!answering && !confirm) {
    const h = holdNow(who.agent, who.account, 'followUp');
    if (h) return holdReply(id, ta, holdRow, { ...who, ...h }, typed ? null : text);
  }
  hideHold(holdRow);
  // Comments on the answer lead the message (comment-text.js); a refusal puts them back.
  const said = text;
  const notes = takeComments(id);
  if (notes.length) text = withPending(id, said, notes);
  // Optimistic: the composer empties and the card goes to Working before the server answers
  // (it may first have to bring back an archived worktree, or reach another machine).
  if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
  S.drafts.delete(id);
  S.replyModes.delete(id);
  S.replyRunners.delete(id);
  S.replyTeams.delete(id);
  const files = n?.tray?.take();
  const undo = startOptimistic(id, text, files, { answering, mode, run, team: team?.team });
  try {
    await (answering
      ? api(`/sessions/${id}/answer`, { method: 'POST', body: { text } })
      : api(`/sessions/${id}/reply`, { method: 'POST', body: { text, attachments, queue: queueing(), mode, ...run, ...(team && { subagents: team.team }), ...(confirm && { confirmLimit: true }) } }));
    // A queued follow-up shows in the list above the box (renderQueued): no toast, no count.
    if (undo) scheduleRefetch(id); // the summary that follows says "running" too, so it won't refetch by itself
  } catch (err) {
    undo?.();
    restoreComments(id, notes);
    // Give the message back, unless the user has already started typing another one.
    if (ta?.isConnected && !ta.value) ((ta.value = said), ta.dispatchEvent(new Event('input')));
    if (mode && !S.replyModes.has(id)) setReplyMode(id, mode);
    if (run && !S.replyRunners.has(id)) setReplyRunner(id, run);
    if (team && !S.replyTeams.has(id)) setReplyTeam(id, team.team, team.preset);
    n?.tray?.restore(files);
    // The server knew better (another account, a number that moved): the same row, from its answer.
    if (err.hold && holdRow) return holdReply(id, ta, holdRow, err.hold, ta?.value.trim() === text ? null : text);
    toastError(err);
  }
}

// The hold row over the reply box: Send anyway sends what's in the box then; Wait until schedules
// it for the reset (Later), the box empties as a scheduled send's does.
// held: the follow-up when it never was in the box (an answer's button, a spell); it goes as it
// is (Wait until leaves the box and its files alone).
function holdReply(id, ta, row, h, held = null) {
  if (!row) return;
  showHold(row, ta, h, {
    kind: 'followUp',
    go: () => sendReply(id, held ?? ta?.value ?? '', { confirm: true }),
    wait: async (at) => {
      const n = S.nodes.get(id);
      if (held !== null) return at && scheduleFollowUp(id, { at, text: held, attachments: [] });
      const text = (ta?.value || '').trim();
      if (!text || !at) return;
      const attachments = n?.tray ? await n.tray.ids() : [];
      const files = n?.tray?.take() || [];
      ((ta.value = ''), ta.dispatchEvent(new Event('input')));
      S.drafts.delete(id);
      if (!(await scheduleFollowUp(id, { at, text, attachments }))) {
        if (ta?.isConnected && !ta.value) ((ta.value = text), ta.dispatchEvent(new Event('input')));
        n?.tray?.restore(files);
      }
    },
  });
}

// A follow-up on another computer: the task moves there and carries on as a new session (the old
// one is archived). The card says it's moving at once; the new card takes its place, open.
async function moveWithReply(id, text, { attachments, mode, run, team, place, notes, said = text }) {
  const n = S.nodes.get(id);
  const ta = n && $('.reply', n.card);
  if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
  S.drafts.delete(id);
  for (const m of [S.replyModes, S.replyRunners, S.replyTeams, S.replyPlaces]) m.delete(id);
  const files = n?.tray?.take();
  const undo = startOptimistic(id, text, files, { mode, run, team: team?.team, live: `Moving to ${placeName(place)}` });
  try {
    const r = await api(`/sessions/${id}/reply`, { method: 'POST', body: { text, attachments, mode, ...run, ...(team && { subagents: team.team }), machine: place } });
    const next = r.session;
    S.sessions.set(next.id, next);
    const old = S.sessions.get(id);
    if (old) S.sessions.set(id, { ...old, state: 'review', live: '', archived: true, movedTo: { id: next.id, place: placeName(place) } });
    S.full.delete(id);
    const wasOpen = S.open.delete(id);
    saveOpen();
    keepInPlace(feedAnchor(), renderFeed);
    if (wasOpen) expand(next.id);
    setFocus(next.id);
    toast(`Moved to <b>${esc(place ? placeName(place) : here)}</b> with its work and history`);
  } catch (err) {
    undo?.();
    restoreComments(id, notes);
    if (ta?.isConnected && !ta.value) ((ta.value = said), ta.dispatchEvent(new Event('input')));
    if (mode && !S.replyModes.has(id)) setReplyMode(id, mode);
    if (run && !S.replyRunners.has(id)) setReplyRunner(id, run);
    if (team && !S.replyTeams.has(id)) setReplyTeam(id, team.team, team.preset);
    if (!S.replyPlaces.has(id)) {
      S.replyPlaces.set(id, place);
      updateDock(id);
    }
    n?.tray?.restore(files);
    toastError(err);
  }
}

// Show a follow-up as started right away: the card moves to Working with the prompt as a live
// turn. Only when it will start now, not when it queues or interrupts a run already working.
// Returns an undo for a failed send, or null when nothing changed.
export function startOptimistic(id, text, files, { answering, mode, run, team, live: label }) {
  const full = S.full.get(id);
  const sum = S.sessions.get(id);
  if (!full || !sum) return null;
  const live = full.state === 'running' || full.state === 'waiting';
  if (live && !answering) return null;
  const now = Date.now();
  const turn = { id: `pending-${now}`, prompt: text, status: 'running', startedAt: now, activity: [], attachments: (files || []).filter((f) => f.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime })) };
  if (mode) turn.mode = mode;
  if (run) Object.assign(turn, run);
  const nextFull = { ...full, state: 'running', ask: null, turns: answering ? full.turns : [...full.turns, turn], ...(mode && { mode }), ...run, ...(team && { subagents: team }) };
  const nextSum = { ...sum, state: 'running', live: label || (answering ? 'Picking up your answer' : run && run.agent !== full.agent ? `Handing over to ${agentName(run.agent)}` : 'Starting up'), updatedAt: now, ...(mode && { mode }), ...run };
  const apply = (f, sm) => {
    S.full.set(id, f);
    S.sessions.set(id, sm);
    const card = S.nodes.get(id)?.card;
    watching(id) ? keepFollowing(card, renderFeed) : keepInPlace(feedAnchor(id), renderFeed);
    renderBody(id, { fresh: false });
  };
  apply(nextFull, nextSum);
  return () => {
    // A live update may already have replaced the guess; only roll back what is still ours.
    if (S.full.get(id) !== nextFull || S.sessions.get(id) !== nextSum) return scheduleRefetch(id);
    apply(full, sum);
  };
}
