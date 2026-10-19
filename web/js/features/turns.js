// An expanded card's body: its turns (prompt, live progress or presentation, trail), newest open
// and older ones folded.

import { countChanges, fmtDuration, renderPresentation } from '../blocks.js';
import { esc, inlineMd, md } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toastError } from '../ui/toast.js';
import { execAction, moreMenu, openInEditor, revertFile, rollbackTurn, takeOver, toggleDone } from './actions.js';
import { draftInto, renderDock, sendReply, startOptimistic, updateDock } from './composer.js';
import { scheduleRefetch } from './feed.js';
import { feedbackOn, rateTurn, whyForm } from './feedback.js';
import { projectById } from './places.js';
import { agentName, DEFAULT_MODE, effortLabel, modelBadge, MODES } from './runners.js';
import { scrollByPx, watching } from './scroll.js';
import { renderPrStrip, shipDialog } from './ship.js';
import { copiesOf, memberLabel, renderSubs, subKey, teamLiveHtml, teamSize } from './team.js';

const KIND_ICON = { read: 'read', edit: 'pen', run: 'terminal', search: 'search', web: 'web', agent: 'agent', plan: 'plan', tool: 'tool', text: 'text', error: 'warn', ask: 'ask', answer: 'check', wait: 'ask', background: 'clock' };

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
            <button class="ghost xs" data-a="replay" title="Replay presentation (R)">${icon('replay')}</button>
            <button class="ghost xs" data-a="takeover" title="Take over in your terminal (T)">${icon('terminal')}</button>
            <button class="ghost xs" data-a="ship" title="Commit, push and open a pull request (S)" hidden>${icon('send')}<span>Ship it</span></button>
            <button class="ghost xs it-done" data-a="done" title="Mark done (E)" hidden>${icon('done')}<span>Mark done</span></button>
            <button class="ghost xs" data-a="more" title="More">${icon('dots')}</button>
          </div>
        </div>
        <button class="link xs earlier" hidden></button>
        <div class="turns"></div>
        <div class="pr-strip" hidden></div>
        <div class="it-dock"></div>
      </div>`);
    n.body ? n.body.replaceWith(body) : n.card.append(body);
    n.body = body;
    $('.it-bar', body).addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'replay') replay(id);
      if (a === 'takeover') takeOver(id);
      if (a === 'ship') shipDialog(id);
      if (a === 'done') toggleDone(id);
      if (a === 'more') moreMenu(id, e.target.closest('button'));
    });
    $('.earlier', body).onclick = () => ((n.showAll = true), renderBody(id, { fresh: false }));
    renderDock(id);
  }

  const body = n.body;
  const proj = projectById(summary.projectId);
  // The head already shows the harness, model and project, and the task head has Compare. This bar
  // says how the run was set up: a mode worth noticing (Plan or Edits, as on the launcher), the
  // branch, and what launched it.
  const mode = MODES.find((m) => m.id === s.mode);
  const where = (proj?.path || s.cwd).replace(S.config.home || '', '~');
  $('.it-meta', body).title = [agentName(s.agent), s.model, s.effort && `${effortLabel(s.effort)} thinking`, mode?.label, where].filter(Boolean).join(' · ');
  $('.it-meta', body).innerHTML = `
    ${mode && mode !== DEFAULT_MODE ? `<span class="m mode m-${mode.id}" title="${esc(mode.hint)}">${icon(mode.icon)}${esc(mode.label)}</span>` : ''}
    ${s.worktree ? `<span class="m branch" title="Worktree: ${esc(s.worktree.path)}\nFrom ${esc(s.worktree.baseRef)}">${icon('branch')}${esc(s.worktree.branch)}</span>` : ''}
    ${s.subagents?.length ? `<span class="m team-m" title="${esc(s.subagents.map((m) => `@${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n'))}">${icon('agent')}${teamSize(s.subagents)} subagent${teamSize(s.subagents) > 1 ? 's' : ''}</span>` : ''}
    ${s.origin ? `<span class="m" title="${s.origin.kind === 'telegram' ? 'Started from Telegram' : `Launched by a ${esc(s.origin.kind)}`}">${icon({ trigger: 'replay', telegram: 'send' }[s.origin.kind] || 'spark')}${esc(s.origin.name)}</span>` : ''}`;
  const live = s.state === 'running' || s.state === 'waiting';
  // Ship and Done sit in the top bar and again next to the composer, so they're there on opening the
  // card and after reading the result. The PR row sits right above the composer for the same reason.
  renderPrStrip(id);
  $$('[data-a="done"]', body).forEach((b) => {
    b.classList.toggle('on', s.state === 'done');
    b.hidden = s.state === 'running' || s.state === 'waiting';
    $('span', b).textContent = s.state === 'done' ? 'Reopen' : 'Mark done';
  });
  $('[data-a="takeover"]', body).hidden = !s.agentSessionId;

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
    const key = `${t.status}|${isLatest}|${folded}|${revKey}|${t.approval || ''}|${t.status === 'running' ? (s.ask?.id || '') + s.queue?.length : ''}|${subKey(s, t)}`;
    const prev = n.turnNodes.get(t.id);
    let node = prev?.node;
    if (!prev || prev.key !== key) {
      const toggle = () => (n.unfolded.has(t.id) ? n.unfolded.delete(t.id) : n.unfolded.add(t.id), renderBody(id, { fresh: false }));
      node = folded ? renderFoldedTurn(t, toggle) : renderTurn(s, t, isLatest, isLatest ? null : toggle);
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

  updateDock(id);
  if (dock?.isConnected) scrollByPx(dock.getBoundingClientRect().top - dockTop);
  if (firstNew && watched) requestAnimationFrame(() => firstNew.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function renderFoldedTurn(t, unfold) {
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  const node = el(`
    <article class="turn folded" data-turn="${t.id}">
      <button class="t-fold" title="Show this exchange">
        ${icon('chevron', 'chev')}
        <span class="t-prompt">${esc(t.prompt.replace(/\s+/g, ' '))}</span>
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
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

// `fold` is set for older turns the user unfolded, so they can tuck them away again.
function renderTurn(s, t, isLatest, fold) {
  const node = el(`<article class="turn ${t.rolledBackAt ? 'is-rolled-back' : ''}" data-turn="${t.id}"></article>`);
  const long = t.prompt.length > 360 || t.prompt.split('\n').length > 5;
  const cp = t.checkpoint;
  const cpLabel = cp?.head ? `${cp.branch ? `${cp.branch}@` : ''}${cp.head.slice(0, 7)}${cp.dirty ? '*' : ''}` : '';
  const ask = el(`
    <div class="ask">
      <div class="ask-text ${long ? 'clamped' : ''}">${esc(t.prompt)}</div>
      ${long ? '<button class="link xs more-btn">Show all</button>' : ''}
      ${t.attachments?.length ? `<div class="ask-atts">${t.attachments.map((a) => (a.mime?.startsWith('image/') ? `<img src="/api/uploads/${a.id}" alt="${esc(a.name)}" title="${esc(a.name)}">` : `<a class="att-pill" href="/api/uploads/${a.id}" target="_blank">${icon('file')}${esc(a.name)}</a>`)).join('')}</div>` : ''}
      <div class="ask-foot">
        ${modelBadge(t.agent || s.agent, t.model ?? s.model, t.effort ?? s.effort)}
        ${modeSwitch(s, t)}
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
    node.append(renderWorking(s, t));
  } else {
    node.append(renderPresentation(t.presentation, ctxFor(s, t, isLatest)));
    const subs = renderSubs(s, t);
    if (subs) node.append(subs);
    node.append(renderTrail(s, t));
  }
  return node;
}

function renderWorking(s, t) {
  const waiting = !!s.ask;
  const node = el(`
    <div class="w-panel ${waiting ? 'waiting' : ''}">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status">
          <b>${waiting ? `${esc(agentName(s.agent))} is waiting for you` : `${esc(agentName(s.agent))} is working`}</b>
          <span class="elapsed" data-start="${t.startedAt}">${fmtDuration(Date.now() - t.startedAt)}</span>
          <span class="w-count">${t.activity.filter((a) => a.kind !== 'text').length} actions</span>
        </div>
        <div class="ask-slot"></div>
        ${teamLiveHtml(s, t)}
        <ul class="ticker"></ul>
        <div class="w-actions">
          <button class="link xs peek">Show all activity</button>
          ${s.queue?.length ? `<span class="w-queued">${s.queue.length} follow-up${s.queue.length > 1 ? 's' : ''} queued</span>` : ''}
          <span class="grow"></span>
          <button class="ghost sm danger stop">${icon('stop')}Stop</button>
        </div>
        <ul class="log" hidden></ul>
      </div>
    </div>`);
  if (waiting) $('.ask-slot', node).append(renderAskCard(s));
  const ticker = $('.ticker', node);
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
  $('.peek', node).onclick = (e) => {
    const log = $('.log', node);
    log.hidden = !log.hidden;
    e.target.textContent = log.hidden ? 'Show all activity' : 'Hide activity';
    if (!log.hidden) log.innerHTML = t.activity.map((a) => actItem(a).outerHTML).join('');
  };
  return node;
}

function actItem(a) {
  return el(`<li class="act k-${a.kind}">${icon(KIND_ICON[a.kind] || 'tool')}<span>${esc(a.label || '')}</span></li>`);
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

function renderTrail(s, t) {
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
        ${acts.length ? `<button class="tb-acts" data-tab="activity" title="Show activity">${parts.length ? parts.map(([ic, l, n]) => `<span class="tb" title="${n} ${l}">${icon(ic)}${n}</span>`).join('') : 'Activity'}</button>` : ''}
        ${t.endedAt ? `<span class="tb">${fmtDuration(t.endedAt - t.startedAt)}</span>` : ''}
        ${st.costUsd ? `<span class="tb">$${st.costUsd.toFixed(2)}</span>` : ''}
        <span class="grow"></span>
        ${t.changes?.length ? `<button class="link xs" data-tab="changes">${t.changes.length} file${t.changes.length > 1 ? 's' : ''} <span class="plus">+${totals.add}</span> <span class="minus">−${totals.del}</span></button>` : ''}
        <span class="tb-tools">
          ${t.presentation?.notes ? `<button class="tb-btn" data-tab="notes" title="Agent notes" aria-label="Agent notes">${icon('text')}</button>` : ''}
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

// Live activity without re-rendering the whole turn.
export function onActivity({ sessionId, turnId, item }) {
  const s = S.full.get(sessionId);
  if (!s) return;
  const turn = s.turns.find((t) => t.id === turnId);
  if (turn && !turn.activity.includes(item)) turn.activity.push(item);
  const node = S.nodes.get(sessionId)?.turnNodes.get(turnId)?.node;
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
