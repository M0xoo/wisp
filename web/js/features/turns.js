// An expanded card's body: its turns (prompt, live progress or presentation, trail), newest open
// and older ones folded.

import { countChanges, fmtDuration, renderPresentation } from '../blocks.js';
import { esc, inlineMd, md } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toastError } from '../ui/toast.js';
import { execAction, moreMenu, openInEditor, revertFile, rollbackTurn, takeOver, toggleDone } from './actions.js';
import { btwTip, paintBtw } from './btw.js';
import { draftInto, renderDock, sendReply, startOptimistic, updateDock } from './composer.js';
import { expand, fetchFull, renderFeed, scheduleRefetch, setFocus } from './feed.js';
import { feedbackOn, rateTurn, whyForm } from './feedback.js';
import { projectById } from './places.js';
import { agentName, DEFAULT_MODE, effortLabel, modelBadge, MODES } from './runners.js';
import { scrollByPx, topInset, watching } from './scroll.js';
import { renderPrStrip, shipDialog } from './ship.js';
import { copiesOf, memberLabel, renderSubs, subKey, teamLiveHtml, teamSize } from './team.js';
import { appendStep, KIND_ICON, pickView, renderLiveTranscript, renderTranscript, sameStep, transcriptOn, updateStep } from './transcript.js';
import { paintCard } from './spells.js';

export function ctxFor(s, turn, isLatest) {
  return {
    session: s,
    turn,
    isLatest,
    reply: (text) => sendReply(s.id, text),
    draft: (text) => draftInto(s.id, text),
    openFile: (p, line) => openInEditor(s, p, line),
    fileUrl: (p) => `/api/sessions/${s.id}/file?path=${encodeURIComponent(p)}`,
    zoom: (src) => overlay(el(`<img class="lightbox" src="${esc(src)}">`)),
    revertFile: (file, restore) => revertFile(s.id, turn.id, file, restore),
    exec: (command, key) => execAction(s.id, turn.id, command, key),
    approve: (allow) => approveBlocked(s, turn, allow),
    refresh: () => fetchFull(s.id).then(() => S.full.get(s.id)),
  };
}

// The "Blocked by permissions" card's buttons. Allow starts the retry, so the card goes to
// Working at once; a refusal rolls that back and shows why.
async function approveBlocked(s, turn, allow) {
  const undo = allow ? startOptimistic(s.id, 'Allow & retry what was blocked', null, {}) : null;
  try {
    await api(`/sessions/${s.id}/approve`, { method: 'POST', body: { turnId: turn.id, allow } });
    if (undo) scheduleRefetch(s.id);
  } catch (err) {
    undo?.();
    toastError(err);
    throw err;
  }
}

// Older turns render as one-line folded rows; past this many they hide behind "Show earlier".
const VISIBLE_TURNS = 8;

export function renderBody(id, { fresh }) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  if (!s || !n) return;
  const summary = S.sessions.get(id) || {};

  if (fresh || !n.body?.querySelector('.turns')) {
    n.turnNodes.clear();
    const body = el(`
      <div class="it-body">
        <div class="it-bar">
          <div class="it-meta"></div>
          <div class="it-actions">
            <button class="ghost xs tx-toggle" data-a="transcript" aria-pressed="false">${icon('transcript')}<span>Transcript</span></button>
            <button class="ghost xs" data-a="replay" title="Replay presentation (R)">${icon('replay')}</button>
            <button class="ghost xs" data-a="takeover" title="Take over in your terminal (T)">${icon('terminal')}</button>
            <button class="ghost xs" data-a="ship" title="Commit, push and open a pull request (S)" hidden>${icon('send')}<span>Ship it</span></button>
            <button class="ghost xs it-done" data-a="done" title="Mark done (E)" hidden>${icon('done')}<span>Mark done</span></button>
            <button class="ghost xs" data-a="more" title="More">${icon('dots')}</button>
          </div>
        </div>
        <button class="link xs earlier" hidden></button>
        <div class="turns"></div>
        <div class="it-dock"><div class="pr-strip" hidden></div></div>
      </div>`);
    n.body ? n.body.replaceWith(body) : n.card.append(body);
    n.body = body;
    $('.it-bar', body).addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'transcript') toggleTranscript(id);
      if (a === 'replay') replay(id);
      if (a === 'takeover') takeOver(id);
      if (a === 'ship') shipDialog(id);
      if (a === 'done') toggleDone(id);
      if (a === 'more') moreMenu(id, e.target.closest('button'));
      if (a === 'moved') openMoved(S.full.get(id)?.movedTo?.id);
    });
    $('.earlier', body).onclick = () => ((n.showAll = true), renderBody(id, { fresh: false }));
    renderDock(id);
  }

  const body = n.body;
  paintCard(id); // spell panels and buttons in the card
  const proj = projectById(summary.projectId);
  // The head already shows the harness, model and project, and the task head has Compare. This bar
  // says how the run was set up: a mode worth noticing (Plan or Edits, as on the launcher), the
  // branch, the other folders it works in, and what launched it.
  const mode = MODES.find((m) => m.id === s.mode);
  const where = (proj?.path || s.cwd).replace(S.config.home || '', '~');
  $('.it-meta', body).title = [agentName(s.agent), s.model, s.effort && `${effortLabel(s.effort)} thinking`, mode?.label, where].filter(Boolean).join(' · ');
  $('.it-meta', body).innerHTML = `
    ${mode && mode !== DEFAULT_MODE ? `<span class="m mode m-${mode.id}" title="${esc(mode.hint)}">${icon(mode.icon)}${esc(mode.label)}</span>` : ''}
    ${s.worktree ? `<span class="m branch" title="Worktree: ${esc(s.worktree.path)}\nFrom ${esc(s.worktree.baseRef)}">${icon('branch')}${esc(s.worktree.branch)}</span>` : ''}
    ${(s.also || []).map((a, i) => `<span class="m also c-${summary.also?.[i]?.color || 'slate'}" title="${esc(`Also works in ${a.cwd}${a.worktree ? `\nWorktree: ${a.worktree.path}\nBranch ${a.worktree.branch}, from ${a.worktree.baseRef}` : ''}`)}"><i class="p-dot"></i>${esc(summary.also?.[i]?.project || a.cwd.split(/[\\/]/).pop())}</span>`).join('')}
    ${s.subagents?.length ? `<span class="m team-m" title="${esc(s.subagents.map((m) => `@${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n'))}">${icon('agent')}${teamSize(s.subagents)} subagent${teamSize(s.subagents) > 1 ? 's' : ''}</span>` : ''}
    ${s.moved?.from ? `<span class="m" title="${esc(`This task ran on ${s.moved.from} before it moved here, with its work and history`)}">${icon('server')}From ${esc(s.moved.from)}</span>` : ''}
    ${s.movedTo?.id ? `<button class="m moved-to" data-a="moved" title="This task carries on as a new session on ${esc(s.movedTo.place)}">${icon('server')}Continues on ${esc(s.movedTo.place)}</button>` : ''}
    ${s.origin ? `<span class="m" title="${s.origin.kind === 'telegram' ? 'Started from Telegram' : `Launched by a ${esc(s.origin.kind)}`}">${icon({ trigger: 'replay', telegram: 'send' }[s.origin.kind] || 'spark')}${esc(s.origin.name)}</span>` : ''}`;
  const live = s.state === 'running' || s.state === 'waiting';
  // Ship and Done sit in the top bar and again next to the composer, so they're there on opening the
  // card and after reading the result. The PR row sits in the composer's dock for the same reason, so in split view it stays pinned with it.
  renderPrStrip(id);
  $$('[data-a="done"]', body).forEach((b) => {
    b.classList.toggle('on', s.state === 'done');
    b.hidden = s.state === 'running' || s.state === 'waiting';
    $('span', b).textContent = s.state === 'done' ? 'Reopen' : 'Mark done';
  });
  $('[data-a="takeover"]', body).hidden = !s.agentSessionId || MOBILE;
  const tx = transcriptOn(id);
  const txBtn = $('[data-a="transcript"]', body);
  txBtn.classList.toggle('on', tx);
  txBtn.setAttribute('aria-pressed', tx);
  txBtn.title = tx ? 'Back to the presentation (V)' : 'Full transcript: every message and step (V)';

  // Turns: keep nodes whose content hasn't changed so animations don't replay.
  const turnsEl = $('.turns', body);
  const turns = n.showAll ? s.turns : s.turns.slice(-VISIBLE_TURNS);
  const hiddenCount = s.turns.length - turns.length;
  const earlier = $('.earlier', body);
  earlier.hidden = !hiddenCount;
  earlier.textContent = `Show ${hiddenCount} earlier turn${hiddenCount === 1 ? '' : 's'}`;
  // A new turn re-folds everything older, so the latest exchange is what's open by default.
  const latestId = s.turns.at(-1)?.id;
  const newTurn = n.latestTurn !== latestId;
  if (newTurn) (n.unfolded.clear(), (n.latestTurn = latestId));
  // Folding the last answer when a follow-up starts can take a screen or more out of the card
  // above the composer. Hold the composer still, so the new exchange lands where the user was
  // typing instead of the whole card sliding off the top of the screen.
  const watched = watching(id);
  const dock = watched && newTurn && !fresh ? $('.it-dock', body) : null;
  const dockTop = dock?.getBoundingClientRect().top;
  const keep = new Set();
  let firstNew = null;
  turns.forEach((t, i) => {
    const isLatest = t.id === latestId;
    const folded = !isLatest && !n.unfolded.has(t.id);
    const revKey = `${t.rolledBackAt || 0}:${(t.changes || []).map((c) => (c.reverted ? 1 : 0)).join('')}`;
    const key = `${t.status}|${isLatest}|${folded}|${revKey}|${t.approval || ''}|${t.status === 'running' ? (s.ask?.id || '') + s.queue?.length : ''}|${subKey(s, t)}|${tx}`;
    const prev = n.turnNodes.get(t.id);
    let node = prev?.node;
    if (!prev || prev.key !== key) {
      const toggle = () => (n.unfolded.has(t.id) ? n.unfolded.delete(t.id) : n.unfolded.add(t.id), renderBody(id, { fresh: false }));
      node = folded ? renderFoldedTurn(t, toggle) : renderTurn(s, t, isLatest, isLatest ? null : toggle, tx);
      if (prev) prev.node.replaceWith(node);
      if (!prev && !fresh && !folded) firstNew ??= node;
      if (prev && prev.status === 'running' && t.status !== 'running') firstNew ??= node;
      n.turnNodes.set(t.id, { key, node, status: t.status });
    }
    keep.add(t.id);
    // Place the turn without re-inserting a node that's already here: re-parenting restarts its
    // CSS animations, so a refetch would replay the whole card's entrance.
    if (turnsEl.children[i] !== node) turnsEl.insertBefore(node, turnsEl.children[i] || null);
  });
  for (const [tid, v] of n.turnNodes) if (!keep.has(tid)) (v.node.remove(), n.turnNodes.delete(tid));
  paintBtw(id); // side questions update in place, so they don't re-render their turn

  updateDock(id);
  if (dock?.isConnected) scrollByPx(dock.getBoundingClientRect().top - dockTop);
  // A transcript was being read at its tail: its result lands right there, so show that, not the prompt.
  const landing = firstNew && tx ? $('.tx-end', firstNew) || firstNew : firstNew;
  if (landing && watched) requestAnimationFrame(() => landing.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// The full transcript or the presentation, for one card. The turn being read keeps its place: its
// prompt stays where it was on screen, or comes back into view if it had scrolled off the top.
export function toggleTranscript(id) {
  const n = S.nodes.get(id);
  pickView(id, !transcriptOn(id));
  if (!S.open.has(id)) return expand(id);
  if (!n?.body?.querySelector('.turns')) return;
  const turns = [...n.body.querySelectorAll('.turn:not(.folded)')];
  const mid = innerHeight / 2;
  const reading = turns.find((x) => { const r = x.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; }) || turns.at(-1);
  const tid = reading?.dataset.turn;
  const before = reading && $('.ask', reading)?.getBoundingClientRect().top;
  renderBody(id, { fresh: false });
  const ask = tid && $(`.turn[data-turn="${tid}"] .ask`, n.body);
  if (!ask || before === undefined) return;
  if (before < topInset()) ask.scrollIntoView({ block: 'start', behavior: 'smooth' });
  else scrollByPx(ask.getBoundingClientRect().top - before);
}

// After the setting changes: every open card follows it.
export function repaintViews() {
  for (const id of S.open) if (S.full.has(id)) renderBody(id, { fresh: false });
}

// The session a moved task carries on in: shown, opened and focused (archived ones stay hidden).
function openMoved(next) {
  if (!next || !S.sessions.has(next)) return;
  renderFeed();
  expand(next);
  setFocus(next);
}

function renderFoldedTurn(t, unfold) {
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  const node = el(`
    <article class="turn folded" data-turn="${t.id}">
      <button class="t-fold" title="Show this exchange">
        ${icon('chevron', 'chev')}
        <span class="t-prompt">${t.by === 'wisp' ? '<b class="t-by">wisp</b> ' : ''}${mentionHtml(esc(t.prompt.replace(/\s+/g, ' ')), { link: false })}</span>
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
        ${t.moved ? `<span class="t-moved" title="${esc(`Ran on ${t.moved}`)}">${icon('server')}${esc(t.moved)}</span>` : ''}
        ${hero?.title ? `<span class="t-result">${esc(hero.title)}</span>` : ''}
        <time>${new Date(t.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      </button>
    </article>`);
  $('.t-fold', node).onclick = unfold;
  return node;
}

// A follow-up that switched the mode says so, next to the model it ran on.
function modeSwitch(s, t) {
  const i = s.turns.indexOf(t);
  const prev = s.turns.slice(0, i).findLast((x) => x.mode)?.mode;
  const m = t.mode && prev && t.mode !== prev && MODES.find((x) => x.id === t.mode);
  return m ? `<span class="t-mode m-${m.id}" title="Switched from ${esc(MODES.find((x) => x.id === prev)?.label || prev)} to ${m.label} for this follow-up">${icon(m.icon)}${m.label}</span>` : '';
}

// `fold` is set for older turns the user unfolded, so they can tuck them away again. `tx`: the card
// shows the full transcript.
function renderTurn(s, t, isLatest, fold, tx) {
  const node = el(`<article class="turn ${t.rolledBackAt ? 'is-rolled-back' : ''}" data-turn="${t.id}"></article>`);
  const long = t.prompt.length > 360 || t.prompt.split('\n').length > 5;
  const cp = t.checkpoint;
  const cpLabel = cp?.head ? `${cp.branch ? `${cp.branch}@` : ''}${cp.head.slice(0, 7)}${cp.dirty ? '*' : ''}` : '';
  const ask = el(`
    <div class="ask${t.by === 'wisp' ? ' by-wisp' : ''}">
      ${t.by === 'wisp' ? `<div class="ask-by">${icon('spark')}Sent by wisp after its test run</div>` : ''}
      <div class="ask-text ${long ? 'clamped' : ''}">${mentionHtml(esc(t.prompt))}</div>
      ${long ? '<button class="link xs more-btn">Show all</button>' : ''}
      ${t.attachments?.length ? `<div class="ask-atts">${t.attachments.map((a) => (a.mime?.startsWith('image/') ? `<img src="/api/uploads/${a.id}" alt="${esc(a.name)}" title="${esc(a.name)}">` : `<a class="att-pill" href="/api/uploads/${a.id}" target="_blank">${icon('file')}${esc(a.name)}</a>`)).join('')}</div>` : ''}
      <div class="ask-foot">
        ${modelBadge(t.agent || s.agent, t.model ?? s.model, t.effort ?? s.effort)}
        ${modeSwitch(s, t)}
        ${t.moved ? `<span class="t-moved" title="${esc(`Ran on ${t.moved}, before the task moved`)}">${icon('server')}${esc(t.moved)}</span>` : ''}
        <time>${new Date(t.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        ${cpLabel ? `<span class="cp-sha" title="Git checkpoint before this turn (${esc(cp.head)}${cp.dirty ? ' + uncommitted changes' : ''})">${icon('branch')}${esc(cpLabel)}</span>` : ''}
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
      </div>
      ${fold ? `<button class="ghost xs t-unfold" title="Collapse this exchange">${icon('chevron', 'chev')}</button>` : ''}
    </div>`);
  if (fold) ask.querySelector('.t-unfold').onclick = fold;
  ask.querySelector('.more-btn')?.addEventListener('click', (e) => {
    ask.querySelector('.ask-text').classList.toggle('clamped');
    e.target.textContent = ask.querySelector('.ask-text').classList.contains('clamped') ? 'Show all' : 'Show less';
  });
  ask.querySelectorAll('.ask-atts img').forEach((img) => img.addEventListener('click', () => overlay(el(`<img class="lightbox" src="${img.src}">`))));
  node.append(ask);

  if (t.status === 'running') {
    if (tx) node.append(renderLiveTranscript(s, t, ctxFor(s, t, isLatest)));
    node.append(renderWorking(s, t, tx));
  } else {
    const ctx = ctxFor(s, t, isLatest);
    node.append(tx ? renderTranscript(s, t, ctx) : renderPresentation(t.presentation, ctx));
    const subs = renderSubs(s, t);
    if (subs) node.append(subs);
    node.append(renderTrail(s, t, tx));
  }
  node.append(el('<div class="btw-list"></div>')); // side questions asked during this turn (btw.js)
  return node;
}

// The live panel. With the transcript on, the steps are already on the timeline above it, so it
// keeps only the status, the question, the team and Stop.
function renderWorking(s, t, tx) {
  const waiting = !!s.ask;
  const node = el(`
    <div class="w-panel ${waiting ? 'waiting' : ''} ${tx ? 'tx-panel' : ''}">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status">
          <b>${waiting ? `${esc(agentName(s.agent))} is waiting for you` : `${esc(agentName(s.agent))} is working`}</b>
          <span class="elapsed" data-start="${t.startedAt}">${fmtDuration(Date.now() - t.startedAt)}</span>
          <span class="w-count">${t.activity.filter((a) => a.kind !== 'text').length} actions</span>
        </div>
        <div class="ask-slot"></div>
        ${teamLiveHtml(s, t)}
        ${tx ? '' : '<ul class="ticker"></ul>'}
        <div class="w-actions">
          ${tx ? '' : '<button class="link xs peek">Show all activity</button>'}
          ${s.queue?.length ? `<span class="w-queued">${s.queue.length} follow-up${s.queue.length > 1 ? 's' : ''} queued</span>` : ''}
          <span class="grow"></span>
          <button class="ghost sm danger stop">${icon('stop')}Stop</button>
        </div>
        <ul class="log" hidden></ul>
      </div>
    </div>`);
  if (waiting) $('.ask-slot', node).append(renderAskCard(s));
  // The /btw tip goes after Show all activity. The transcript's panel has none: it leads the row with Stop.
  const tip = btwTip(s.id);
  if (tip && tx) $('.w-actions', node).prepend(tip);
  else if (tip) $('.peek', node).after(tip);
  const ticker = $('.ticker', node);
  if (ticker)
    t.activity
      .filter((a) => a.kind !== 'text')
      .slice(-5)
      .forEach((a) => ticker.prepend(actItem(a)));
  $('.stop', node).onclick = async (e) => {
    // Shows at once; the run winds down and the live update replaces this panel.
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.lastChild.textContent = 'Stopping…';
    $('.w-status b', node).textContent = `Stopping ${agentName(s.agent)}…`;
    await api(`/sessions/${s.id}/stop`, { method: 'POST', body: {} }).catch((err) => {
      btn.disabled = false;
      btn.lastChild.textContent = 'Stop';
      $('.w-status b', node).textContent = `${agentName(s.agent)} is working`;
      toastError(err);
    });
  };
  if (!tx) $('.peek', node).onclick = (e) => {
    const log = $('.log', node);
    log.hidden = !log.hidden;
    e.target.textContent = log.hidden ? 'Show all activity' : 'Hide activity';
    if (!log.hidden) log.innerHTML = t.activity.map((a) => actItem(a).outerHTML).join('');
  };
  return node;
}

// A line in the ticker and the activity log. A message (kept whole for the transcript) shows its start.
function actItem(a) {
  const label = a.kind === 'text' && a.label?.length > 400 ? `${a.label.slice(0, 400)}…` : a.label || '';
  return el(`<li class="act k-${a.kind}">${icon(KIND_ICON[a.kind] || 'tool')}<span>${esc(label)}</span></li>`);
}

function renderAskCard(s) {
  const a = s.ask;
  const p = a.permission;
  // A live approval: the agent is paused on a tool call its permissions don't allow by themselves.
  const node = p
    ? el(`
    <div class="ask-card perm">
      <div class="q-head">${icon('lock')}<span>Needs your approval</span></div>
      <p class="q-text">${inlineMd(a.question)}</p>
      ${p.detail && !a.question.includes(p.detail) ? `<pre class="perm-detail">${esc(p.detail)}</pre>` : ''}
      ${a.context ? `<p class="q-context">${esc(a.context)}</p>` : ''}
      <div class="q-opts">${a.options.map((o, i) => `<button class="opt ${i === 0 ? 'go' : i === a.options.length - 1 ? 'no' : ''}" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}</button>`).join('')}</div>
      <form class="q-own"><input class="input" placeholder="Or say what to do instead (denies this call)…"><button class="ghost sm">Send</button></form>
    </div>`)
    : el(`
    <div class="ask-card">
      <div class="q-head">${icon('ask')}<span>Needs your call</span></div>
      <p class="q-text">${esc(a.question)}</p>
      ${a.context ? `<div class="prose q-context">${md(a.context)}</div>` : ''}
      ${a.options?.length ? `<div class="q-opts">${a.options.map((o, i) => `<button class="opt" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}</button>`).join('')}</div>` : ''}
      <form class="q-own"><input class="input" placeholder="${a.options?.length ? 'Or answer in your own words…' : 'Your answer…'}"><button class="primary sm">Answer</button></form>
    </div>`);
  const answer = async (text) => {
    if (!text.trim()) return;
    node.classList.add('sent');
    const undo = startOptimistic(s.id, text, null, { answering: true });
    try {
      await api(`/sessions/${s.id}/answer`, { method: 'POST', body: { text } });
      if (undo) scheduleRefetch(s.id);
    } catch (e) {
      node.classList.remove('sent');
      undo?.();
      toastError(e);
    }
  };
  node.addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (b) answer(a.options[b.dataset.i]);
  });
  $('form', node).onsubmit = (e) => (e.preventDefault(), answer($('input', node).value));
  return node;
}

// Under a finished turn. With the transcript showing, its steps and the agent's notes are already on
// the page, so the bar drops those two.
function renderTrail(s, t, tx) {
  const acts = t.activity || [];
  const count = (k) => acts.filter((a) => a.kind === k).length;
  const parts = [
    ['read', 'read', count('read')],
    ['pen', 'edited', count('edit')],
    ['terminal', 'ran', count('run')],
    ['search', 'searched', count('search')],
    ['web', 'web', count('web')],
  ].filter((p) => p[2]);
  const totals = (t.changes || []).reduce((acc, c) => {
    const n = countChanges(c.edits);
    return { add: acc.add + n.add, del: acc.del + n.del };
  }, { add: 0, del: 0 });
  const st = t.stats || {};
  const canRollback = s.agent !== 'wisp' && s.state !== 'running' && (t.changes?.length || t.checkpoint?.commit);
  const rolledBack = !!t.rolledBackAt;
  const rated = t.feedback?.rating;
  const node = el(`
    <div class="trail">
      <div class="trail-bar">
        ${acts.length && !tx ? `<button class="tb-acts" data-tab="activity" title="Show activity">${parts.length ? parts.map(([ic, l, n]) => `<span class="tb" title="${n} ${l}">${icon(ic)}${n}</span>`).join('') : 'Activity'}</button>` : ''}
        ${t.endedAt ? `<span class="tb">${fmtDuration(t.endedAt - t.startedAt)}</span>` : ''}
        ${st.costUsd ? `<span class="tb">$${st.costUsd.toFixed(2)}</span>` : ''}
        <span class="grow"></span>
        ${t.changes?.length ? `<button class="link xs" data-tab="changes">${t.changes.length} file${t.changes.length > 1 ? 's' : ''} <span class="plus">+${totals.add}</span> <span class="minus">−${totals.del}</span></button>` : ''}
        <span class="tb-tools">
          ${t.presentation?.notes && !tx ? `<button class="tb-btn" data-tab="notes" title="Agent notes" aria-label="Agent notes">${icon('text')}</button>` : ''}
          ${canRollback ? (rolledBack
            ? `<button class="link xs cp-rollback rolled-back" data-a="rollback" title="Re-apply changes from this turn">${icon('rerun')}Re-apply</button>`
            : `<button class="tb-btn cp-rollback" data-a="rollback" title="Restore working tree to before this turn${t.checkpoint?.head ? ` (${t.checkpoint.head.slice(0, 7)})` : ''}" aria-label="Restore to before this turn">${icon('replay')}</button>`) : ''}
          ${feedbackOn() ? `<span class="rate ${rated ? 'rated' : ''}">${['up', 'down'].map((r) => `<button class="rate-btn ${rated === r ? 'on' : ''}" data-rate="${r}" title="${r === 'up' ? 'Good result' : 'Bad result'}: tell the wisp team" aria-pressed="${rated === r}">${icon(`thumb-${r}`)}</button>`).join('')}</span>` : ''}
        </span>
      </div>
      <div class="trail-body" hidden></div>
    </div>`);
  const body = $('.trail-body', node);
  let open = null;
  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-a="rollback"]')) {
      return rollbackTurn(s.id, t.id, rolledBack);
    }
    const rb = e.target.closest('[data-rate]');
    if (rb) {
      const next = t.feedback?.rating === rb.dataset.rate ? null : rb.dataset.rate;
      rateTurn(s, t, node, next);
      if (next !== 'down' && open === 'rate') ((open = null), (body.hidden = true));
      if (next === 'down') {
        open = 'rate';
        $$('[data-tab]', node).forEach((x) => x.classList.remove('on'));
        body.hidden = false;
        body.innerHTML = '';
        body.append(whyForm(s, t, () => ((open = null), (body.hidden = true))));
      }
      return;
    }
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    $$('[data-tab]', node).forEach((x) => x.classList.toggle('on', x === b && open !== tab));
    if (open === tab) {
      open = null;
      body.hidden = true;
      return;
    }
    open = tab;
    body.hidden = false;
    body.innerHTML = '';
    if (tab === 'activity') body.append(el(`<ul class="log">${acts.map((a) => actItem(a).outerHTML).join('')}</ul>`));
    if (tab === 'notes') body.append(el(`<div class="prose">${md(t.presentation.notes)}</div>`));
    if (tab === 'changes') {
      body.append(renderPresentation({ blocks: t.changes.map((c) => ({ type: 'diff', file: c.file })) }, ctxFor(s, t, false)));
    }
  });
  return node;
}

// Live activity without re-rendering the whole turn. `update`: a step already shown changed (its
// output came in).
export function onActivity({ sessionId, turnId, item, update }) {
  const s = S.full.get(sessionId);
  if (!s) return;
  const turn = s.turns.find((t) => t.id === turnId);
  const node = S.nodes.get(sessionId)?.turnNodes.get(turnId)?.node;
  if (update) {
    const known = turn?.activity.findLast((a) => sameStep(a, item));
    if (known) Object.assign(known, item);
    if (node) updateStep(node, item, turn);
    return;
  }
  if (turn && !turn.activity.includes(item)) turn.activity.push(item);
  if (node && turn) appendStep(node, item, turn, scrollByPx);
  if (!node || item.kind === 'text') return;
  const ticker = $('.ticker', node);
  if (ticker) {
    const li = actItem(item);
    li.classList.add('new');
    ticker.prepend(li);
    while (ticker.children.length > 5) ticker.lastElementChild.remove();
  }
  const log = $('.log', node);
  if (log && !log.hidden) log.append(actItem(item));
  const c = $('.w-count', node);
  if (c && turn) c.textContent = `${turn.activity.filter((a) => a.kind !== 'text').length} actions`;
}

export function replay(id) {
  const n = S.nodes.get(id);
  if (!n?.body) return;
  for (const v of n.turnNodes.values()) v.node.remove();
  n.turnNodes.clear();
  renderBody(id, { fresh: false });
  $('.turns', n.body).lastElementChild?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
