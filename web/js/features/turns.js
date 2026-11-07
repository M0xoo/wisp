// An expanded card's body: its turns (prompt, live progress or presentation, trail), newest open
// and older ones folded.

import { countChanges, fmtDuration, renderPresentation } from '../blocks.js';
import { esc, inlineMd, md } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, beforePaint, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { actionCount, turnTime } from '../core/format.js';
import { toastError } from '../ui/toast.js';
import { viewImage } from '../ui/viewer.js';
import { popover } from '../ui/popover.js';
import { execAction, forkable, forkTask, moreMenu, openInEditor, rerun, revealFile, revertFile, rollbackTurn, takeOver, toggleDone } from './actions.js';
import { btwTip, paintBtw } from './btw.js';
import { draftInto, renderDock, sendReply, startOptimistic, updateDock } from './composer.js';
import { expand, fetchFull, renderFeed, reveal as revealTask, scheduleRefetch, setFocus, wholeTask } from './feed.js';
import { feedbackOn, rateTurn, whyForm } from './feedback.js';
import { projectById } from './places.js';
import { accountMark, accountOf, agentName, DEFAULT_MODE, effortLabel, limitUntil, modelBadge, MODES } from './runners.js';
import { heldCard } from './hold.js';
import { limitColdLine } from '../cold-cache.js';
import { harnessNote } from './harness-watch.js';
import { whatChanged } from '../what-changed.js';
import { whatChangedLine } from '../what-changed-line.js';
import { scheduleFollowUp } from './later.js';
import { handoffTargets } from '../vendors.js';
import { compareTip, offerSubagentModel, SUBAGENT_OFFER, OVERAGE, receiptOf, receiptParts, receiptTip, subagentParts, subagentTip } from '../receipt.js';
import { atTail, scrollByPx, topInset, topTurn } from './scroll.js';
import { landing, landStart, noteScroll, ownWaiting, toEnd, turnChange } from '../tail.js';
import { prsOf, renderPrStrip, shipDialog } from './ship.js';
import { renderOverlapStrip } from './overlaps.js';
import { changesButton, openPanel, paintDoor, shellButton, shellLive, watchButton } from './panel.js';
import { paintSplit } from './split.js';
import { copiesOf, memberLabel, renderSubs, subKey, teamLiveHtml, teamSize } from './team.js';
import { noOutputLine, stream } from '../no-output.js';
import { appendStep, KIND_ICON, pickView, renderLiveTranscript, renderTranscript, sameStep, transcriptOn, updateStep } from './transcript.js';
import { paintCard } from './spells.js';
import { paintGoal, wireGoalSlot } from './goal.js';
import { signIn } from './connectors.js';
import { crewFace, paintOffers } from './crew.js';
import { keepCtx, stuffBlock } from './stuff.js';
import { paintMarks, sentComments } from './comments.js';
import { clashCardHtml, sideWarnRows, sideChips, sideLine, sidesMenu } from './side.js';
import { typingLogin } from './agent-login.js';
import { signInCard } from './sign-in-card.js';

export function ctxFor(s, turn, isLatest) {
  return {
    session: s,
    turn,
    isLatest,
    reply: (text) => sendReply(s.id, text),
    draft: (text) => draftInto(s.id, text),
    openFile: (p, line) => openInEditor(s, p, line),
    fileUrl: (p) => `/api/sessions/${s.id}/file?path=${encodeURIComponent(p)}`,
    zoom: (src, alt, set) => viewImage(src, alt, set),
    reveal: (p) => revealFile(s, p),
    openTask: (id) => revealTask(id),
    revertFile: (file, restore) => revertFile(s.id, turn.id, file, restore),
    exec: (command, key) => execAction(s.id, turn.id, command, key),
    saveApp: (key, state) => saveAppState(s, turn, key, state),
    approve: (allow) => approveBlocked(s, turn, allow),
    refresh: () => fetchFull(s.id).then(() => S.full.get(s.id)),
    keep: s.agent === 'wisp' ? null : keepCtx(s, turn), // Save to My Stuff (not on the tour)
    stuffBlock: (b) => stuffBlock(b), // something the agent saved in My Stuff (stuff.js)
  };
}

// What an app block saved (wisp.save), kept on its turn so it opens as it was left. Kept here at
// once; a refused save only loses it on the next load, so it's not worth a toast.
function saveAppState(s, turn, key, state) {
  turn.appState = { ...turn.appState, [key]: state };
  api(`/sessions/${s.id}/app-state`, { method: 'POST', body: { turnId: turn.id, key, state } }).catch(() => {});
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
export const VISIBLE_TURNS = 8;
const PROMPT_CUT = 4000; // characters of a folded prompt laid out before Show all

// What a new worktree brought along (server/worktree-setup.js), for the branch's tooltip.
const preparedLine = (p) => (p ? `${p.copied?.length ? `\nCopied: ${p.copied.join(', ')}` : ''}${p.ran?.length ? `\nSet up with: ${p.ran.join(' && ')}` : ''}` : '');

// byHand: the user changed what shows themselves (unfolded a turn, Show earlier, V), so the view
// holds even at the tail: pulling them to the end would take away what they just opened.
export function renderBody(id, { fresh, byHand }) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  if (!s || !n) return;
  const summary = S.sessions.get(id) || {};

  // Where the reader is, before anything below changes the page. Only the tail and the user's own
  // send may move the view; anything else holds the turn at the top of it (docs/feed.md).
  const kept = !fresh && S.open.has(id) && !!n.body?.querySelector('.turns');
  const change = turnChange({ turns: s.turns, known: n.turnNodes, last: n.latestTurn, flagged: ownWaiting(n) });
  const flying = kept && !byHand && landing(n, n.body);
  const follow = kept && ((!byHand && (atTail(n.body) || flying)) || change.own);
  const place = kept && !follow ? topTurn(n.body) : null;
  if (change.own) n.ownUntil = 0;

  if (fresh || !n.body?.querySelector('.turns')) {
    n.turnNodes.clear();
    n.missed = false;
    const body = el(`
      <div class="it-body">
        <div class="it-mini"><div class="im-row"></div></div>
        <div class="it-bar">
          <div class="it-props"></div>
          <div class="it-meta"></div>
          <div class="it-actions">
            <button class="ghost xs tx-toggle" data-a="transcript" data-key="V" aria-pressed="false">${icon('transcript')}<span>Transcript</span></button>
            <button class="ghost xs" data-a="rerun" data-key="⇧R" title="Rerun: the same task again, on any harness, model or computer (⇧R)">${icon('rerun')}<i class="it-lbl">Rerun…</i></button>
            <button class="ghost xs" data-a="takeover" data-key="T" title="Take over: carry on with the agent yourself, in a terminal (T)">${icon('terminal')}<i class="it-lbl">Take over</i></button>
            <button class="ghost xs it-changes" data-a="changes" data-key="D" aria-pressed="false" title="Changes: every file this task changed (D)">${icon('file')}<i class="it-lbl">Changes</i></button>
            <button class="ghost xs it-shell" data-a="shell" data-key="⌃\`" aria-pressed="false" title="Shell: your terminal in this task's folder (⌃\`)">${icon('shell')}<i class="it-lbl">Shell</i></button>
            <button class="ghost xs it-watch" data-a="watch" aria-pressed="false" title="Watch: the page the agent keeps up to date while it works" hidden>${icon('eye')}<i class="it-lbl">Watch</i></button>
            <button class="ghost xs" data-a="ship" data-key="S" title="Commit, push and open a pull request (S)" hidden>${icon('send')}<span>Ship it…</span></button>
            <button class="ghost xs it-done" data-a="done" data-key="E" title="Mark done (E)" hidden>${icon('done')}<span>Mark done</span></button>
            <button class="ghost xs" data-a="more" title="More">${icon('dots')}<i class="it-lbl">More</i></button>
          </div>
          <div class="it-slot"></div>
          <button class="shell-door" data-a="shell"></button>
        </div>
        <div class="goal-slot" hidden></div>
        <button class="link xs earlier" hidden></button>
        <div class="turns"></div>
        <div class="it-dock"><button class="latest-pill" aria-label="Go to the latest turn" title="Go to the latest turn" hidden>${icon('arrow')}<span>Latest</span></button><div class="overlap-strip" hidden></div><div class="pr-strip" hidden></div></div>
      </div>`);
    n.body ? n.body.replaceWith(body) : n.card.append(body);
    n.body = body;
    body.addEventListener(
      'scroll',
      () => {
        noteScroll(body);
        if (n.missed) paintLatest(id);
      },
      { passive: true },
    );
    $('.latest-pill', body).onclick = () => {
      goLatest(id);
    };
    $('.it-bar', body).addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'transcript') toggleTranscript(id);
      if (a === 'rerun') rerun(id);
      if (a === 'takeover') takeOver(id);
      if (a === 'changes') changesButton(id);
      if (a === 'shell') shellButton(id);
      if (a === 'watch') watchButton(id);
      if (a === 'ship') shipDialog(id);
      if (a === 'done') toggleDone(id);
      if (a === 'more') moreMenu(id, e.target.closest('button'));
      if (a === 'moved') openMoved(S.full.get(id)?.movedTo?.id);
      if (a === 'fork-src') revealTask(S.full.get(id)?.forkedFrom?.id);
      if (a === 'share') import('./share.js').then((m) => m.shareTask(id));
      if (a === 'forks') forksMenu(id, e.target.closest('button'));
      if (a === 'side-of') revealTask(S.full.get(id)?.sideOf?.id);
      if (a === 'sides') sidesMenu(id, e.target.closest('button'));
    });
    // Narrow, the bar scrolls away with the task, and once its actions are gone the mini row pins
    // in their place: one row that does what the bar's buttons do.
    $('.im-row', body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      const a = b?.dataset.a;
      if (a === 'pr') openPanel(id, 'pr');
      else if (a === 'shell') shellButton(id);
      else if (a === 'watch') watchButton(id);
      else if (a === 'more') moreMenu(id, b);
      else if (a) $(`.it-actions [data-a="${a}"]`, body)?.click();
    });
    new IntersectionObserver(([e]) => $('.it-mini', body).classList.toggle('on', !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), { root: body }).observe($('.it-actions', body));
    $('.earlier', body).onclick = () => ((n.showAll = true), renderBody(id, { fresh: false, byHand: true }));
    wireGoalSlot($('.goal-slot', body), id);
    renderDock(id);
    if (s.parentId) subDock(body, s);
    placePr(body);
  }

  const body = n.body;
  paintCard(id); // spell panels and buttons in the card
  paintGoal(id); // the goal it keeps going for (goal.js)
  paintMeta(id);
  const live = s.state === 'running' || s.state === 'waiting';
  // Ship and Done sit in the top bar and again next to the composer (split view hides the composer's
  // copies: its bar is sticky, so they're in reach after reading the result anyway). The PR row sits
  // in the composer's dock; in split view it's in the details column with them (placePr).
  renderPrStrip(id);
  renderOverlapStrip(id);
  paintDone(id);
  paintDoor(id);
  // While it works, the session id may still be on its way: takeOver asks for it.
  $('[data-a="takeover"]', body).hidden = (!s.agentSessionId && !live) || !!s.sideOf;
  $('.it-actions [data-a="rerun"]', body).hidden = !!s.sideOf; // a side discussion has no task of its own to redo
  $('.it-watch', body).hidden = !summary.watch; // only once its agent put a page up (wisp_watch)
  $('.it-changes', body).hidden = !!summary.pending;
  const tx = transcriptOn(id);
  const txBtn = $('.it-actions [data-a="transcript"]', body);
  txBtn.classList.toggle('on', tx);
  txBtn.setAttribute('aria-pressed', tx);
  txBtn.title = tx ? 'Back to the presentation (V)' : 'Full transcript: every message and step (V)';
  paintMini(id);

  // Turns: keep nodes whose content hasn't changed so animations don't replay.
  const turnsEl = $('.turns', body);
  // A new turn would push the one being read behind Show earlier: it stays.
  if (place && s.turns.slice(0, -VISIBLE_TURNS).some((t) => t.id === place.id)) n.showAll = true;
  const turns = n.showAll ? s.turns : s.turns.slice(-VISIBLE_TURNS);
  const hiddenCount = s.turns.length - turns.length;
  const earlier = $('.earlier', body);
  earlier.hidden = !hiddenCount;
  earlier.textContent = `Show ${hiddenCount} earlier turn${hiddenCount === 1 ? '' : 's'}`;
  const latestId = s.turns.at(-1)?.id;
  const { newTurn, adopted } = change;
  // The real turn took over from the pending one: the same turn. It's drawn again in its place (the
  // old node's handlers hold the pending turn), and nothing about the view changes.
  if (adopted) {
    const was = n.turnNodes.get(adopted);
    n.turnNodes.delete(adopted);
    if (was) n.turnNodes.set(latestId, { ...was, key: null });
    if (place?.id === adopted) place.id = latestId;
    n.latestTurn = latestId;
  }
  // A new turn re-folds everything older, so the latest exchange is what's open by default. Not
  // under a reader who's elsewhere in the task: the answer they may be reading stays open.
  if (newTurn) {
    if (!kept || follow) n.unfolded.clear();
    else if (n.latestTurn) n.unfolded.add(n.latestTurn);
    n.latestTurn = latestId;
    // Compact now is housekeeping: the answer you were reading stays open above it.
    if (s.turns.at(-1)?.by === 'compact') {
      const answer = s.turns.findLast((t) => t.by !== 'compact');
      if (answer) n.unfolded.add(answer.id);
    }
  }
  // Folding the last answer when a follow-up starts can take a screen or more out of the card
  // above the composer. Hold the composer still, so the new exchange lands where the user was
  // typing instead of the whole card sliding off the top of the screen.
  const dock = follow && newTurn ? $('.it-dock', body) : null;
  const dockTop = dock?.getBoundingClientRect().top;
  const keep = new Set();
  let firstNew = null;
  const forkStart = s.forkedFrom && s.turns.find((t) => !t.forked)?.id;
  const sharedStart = s.sharedFrom && s.turns.find((t) => !t.shared)?.id;
  turns.forEach((t, i) => {
    const isLatest = t.id === latestId;
    const folded = !isLatest && (!n.unfolded.has(t.id) || !!t.stub);
    const revKey = `${t.rolledBackAt || 0}:${(t.changes || []).map((c) => (c.reverted ? 1 : 0)).join('')}`;
    // .env masking turned on or off (Settings → Privacy): the turn is drawn again with or without it.
    const envKey = t.changes?.some((c) => c.masked) || t.activity?.some((x) => x.masked) ? 'm' : '';
    const key = `${t.status}${t.held?.waiting ? '-waiting' : ''}|${isLatest}|${folded}|${revKey}|${t.approval || ''}|${t.status === 'running' ? (s.ask?.id || '') + (s.ask?.clash?.sig || '') + (t.sideWarn?.length || '') + s.queue?.length + !!summary.watch : ''}|${subKey(s, t)}|${tx}|${isLatest ? s.goal?.status || '' : ''}|${envKey}|${t.signedOut?.stillIn ? 'still' : ''}`;
    const prev = n.turnNodes.get(t.id);
    let node = prev?.node;
    // A code or key being typed into the turn's sign-in card: drawing it again would take the box away.
    const typing = prev && isLatest && t.signedOut && typingLogin(prev.node);
    if (!prev || (prev.key !== key && !typing)) {
      const toggle = () => {
        // A stub (the phone fetched only the latest turns): it opens once the whole task is here.
        if (t.stub) {
          n.unfolded.add(t.id);
          node.setAttribute('aria-busy', 'true');
          return wholeTask(id);
        }
        n.unfolded.has(t.id) ? n.unfolded.delete(t.id) : n.unfolded.add(t.id);
        renderBody(id, { fresh: false, byHand: true });
      };
      node = folded ? renderFoldedTurn(t, toggle) : renderTurn(s, t, isLatest, isLatest ? null : toggle, tx);
      // A fork's own turns start under a line: the ones above came with it from the original.
      // On a narrow pane the bar has no room for Forked from: the line names the original instead.
      if (t.id === forkStart) node.prepend(forkLine(s.forkedFrom));
      // A side discussion says what it is above its first message, with the way back.
      if (s.sideOf && t.id === s.turns[0]?.id) node.prepend(sideLine(s.sideOf));
      const warns = sideWarnRows(t);
      if (warns) $('.ask', node)?.after(warns);
      // An imported task's own turns start under a line too: the ones above came with the share.
      if (t.id === sharedStart) node.prepend(el(`<div class="fork-line"><span>${icon('share')}<i>Imported from ${esc(s.sharedFrom.name || s.sharedFrom.handle || 'a share')}: your turns start here</i></span></div>`));
      if (prev) prev.node.replaceWith(node);
      if (!prev && !fresh && !folded) firstNew ??= node;
      if (prev && !folded && prev.status === 'running' && t.status !== 'running') firstNew ??= node;
      n.turnNodes.set(t.id, { key, node, status: t.status });
    }
    keep.add(t.id);
    // Place the turn without re-inserting a node that's already here: re-parenting restarts its
    // CSS animations, so a refetch would replay the whole card's entrance.
    if (turnsEl.children[i] !== node) turnsEl.insertBefore(node, turnsEl.children[i] || null);
    if (!folded) paintWhatChanged(s, t, node, prev?.node === node);
  });
  for (const [tid, v] of n.turnNodes) if (!keep.has(tid)) (v.node.remove(), n.turnNodes.delete(tid));
  paintBtw(id); // side questions update in place, so they don't re-render their turn
  paintOffers(id); // so do kit files proposed for a crew member, which live on the member

  updateDock(id);
  paintMarks(id); // comments waiting to go out, marked on the answers they're about
  if (fresh) paintSplit(); // split view: the header and details column fill in from the summary
  if (dock?.isConnected) scrollByPx(dock.getBoundingClientRect().top - dockTop);
  const held = place && n.turnNodes.get(place.id)?.node;
  if (held?.isConnected) scrollByPx(held.getBoundingClientRect().top - place.top);
  if (firstNew && kept) {
    if (follow) n.missed = false;
    else if (!ownWaiting(n)) n.missed = true; // an own send's turn is on its way: it'll land there
  }
  paintLatest(id);
  // A transcript was being read at its tail: its result lands right there, so show that, not the prompt.
  const target = firstNew && (tx ? $('.tx-end', firstNew) || firstNew : firstNew);
  if (target && follow) {
    landStart(n);
    requestAnimationFrame(() => land(target));
  } else if (follow && live && !flying) toEnd(body); // a re-render can add more than the slack: a panel, a queue row
}

const land = (node) => node.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

// The Latest pill over the reply box: something landed while the reader was away from the tail
// (n.missed). It goes once they get there, by hand or by this button, or the turn's head shows.
function paintLatest(id) {
  const n = S.nodes.get(id);
  const pill = n?.body && $('.latest-pill', n.body);
  if (!pill) return;
  if (n.missed) {
    const head = n.turnNodes.get(n.latestTurn)?.node?.getBoundingClientRect().top;
    const floor = $('.it-dock', n.body).getBoundingClientRect().top;
    if (atTail(n.body) || (head >= topInset() && head < floor)) n.missed = false;
  }
  if (pill.hidden === !n.missed) return;
  pill.hidden = !n.missed;
}

function goLatest(id) {
  const n = S.nodes.get(id);
  const node = n?.turnNodes.get(n.latestTurn)?.node;
  n.missed = false;
  paintLatest(id);
  if (!node) return;
  landStart(n);
  land((transcriptOn(id) && $('.tx-end', node)) || node);
}

// The open task's card just left the page and came back (feed.js): a scroll on its way goes on.
export function landAgain(id) {
  const n = S.nodes.get(id);
  const node = n?.turnNodes.get(n.latestTurn)?.node;
  if (node && landing(n, n.body)) land((transcriptOn(id) && $('.tx-end', node)) || node);
}

// What moved in the CLI since the last turn. Painted in place, outside the turn's key: stats.cli can
// land after the answer (the Codex probe), and drawing the turn again would replay its entrance.
// A line that comes or goes on a turn already showing holds what's below it (`late`): keepInPlace
// holds a card, which split view keeps in the sidebar, and this moves inside the open task's body.
function paintWhatChanged(s, t, node, late) {
  const done = t.status !== 'running' && t.status !== 'held';
  const noted = !!$(':scope > .hw-note[data-hw]:not([hidden])', node); // it already gives the version
  const copy = done ? whatChangedLine(whatChanged(s, t), { name: agentName(t.agent || s.agent), noted }) : null;
  const html = copy && `${esc(copy.said)} <span class="wc-limit">${esc(copy.limit)}</span>`;
  const line = $(':scope > .wc-line', node);
  const say = line && $('.hw-say', line);
  if (line ? say.innerHTML === html : !html) return;
  const after = (html ? [...node.children].filter((c) => c.matches('.ask, .side-warns, .hw-note')).at(-1) : line).nextElementSibling;
  const top = late ? after?.getBoundingClientRect().top : undefined;
  if (!html) line.remove();
  else if (line) say.innerHTML = html;
  else after.before(el(`<div class="wc-line">${icon('info')}<span class="hw-say">${html}</span></div>`));
  if (top < innerHeight) scrollByPx(after.getBoundingClientRect().top - top);
}

// Trust this version took the harness's line away: the version goes back on this one.
bus.on('agents', () => {
  for (const id of S.open) renderBody(id, { fresh: false });
});

// Mark done / Reopen, in the task's bar and next to the composer. The state comes from the summary:
// toggling it is optimistic and changes the summary first; the full task catches up after the echo.
export function paintDone(id) {
  const body = S.nodes.get(id)?.body;
  if (!body) return;
  const state = S.sessions.get(id)?.state || S.full.get(id)?.state;
  const label = state === 'done' ? 'Reopen' : 'Mark done';
  $$('[data-a="done"]:not(.im-row *)', body).forEach((b) => {
    b.classList.toggle('on', state === 'done');
    b.hidden = state === 'running' || state === 'waiting';
    $('span', b).textContent = label;
    b.title = `${label} (E)`;
    if (b.hasAttribute('aria-label')) b.setAttribute('aria-label', label);
  });
  paintMini(id);
}

// After an optimistic state change: the buttons and the follow-up box's hint.
export const paintState = (id) => (paintDone(id), updateDock(id));

// The mini row (narrow panes, once the bar has scrolled away), from what the bar shows now: the
// state, its actions as icons, the PR as a chip in its tone, and the shell (a dot while yours runs).
export function paintMini(id) {
  const body = S.nodes.get(id)?.body;
  const row = body && $('.im-row', body);
  if (!row) return;
  const bar = $('.it-bar', body);
  const real = (a) => $(`.it-actions [data-a="${a}"]`, bar);
  const btn = (a, ic) => {
    const b = real(a);
    if (!b || b.hidden) return '';
    const label = b.getAttribute('aria-label') || $('span, .it-lbl', b)?.textContent || b.title;
    return `<button class="icon-btn${b.classList.contains('on') ? ' on' : ''}" data-a="${a}" title="${esc(b.title || label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
  };
  const s = S.sessions.get(id);
  const prs = s ? prsOf(s) : [];
  const pr = prs[0]?.pr;
  const tone = $('.pr-strip', body)?.className.match(/\bpr-(pass|fail|pending|merged|closed)\b/)?.[1] || 'pass';
  const ship = real('ship');
  const live = shellLive(id);
  const html = `${$('.it-props > .pill[class*="st-"]', bar)?.outerHTML || ''}
    <span class="im-acts">${btn('transcript', 'transcript')}${btn('rerun', 'rerun')}${btn('watch', 'eye')}${btn('done', 'done')}${btn('more', 'dots')}</span>
    <span class="grow"></span>
    ${pr ? `<button class="im-pr pr-${tone}" data-a="pr" title="Open PR #${pr.number}"><i class="pr-dot"></i>#${pr.number}${prs.length > 1 ? `<small>+${prs.length - 1}</small>` : ''}</button>` : ship && !ship.hidden ? `<button class="ghost xs" data-a="ship">${icon('send')}<span>${esc($('span', ship).textContent)}</span></button>` : ''}
    <button class="icon-btn im-shell" data-a="shell" title="${live ? 'Shell, running' : 'Shell'}" aria-label="${live ? 'Shell, running' : 'Shell'}">${icon('shell')}${live ? '<i class="sd-live"></i>' : ''}</button>`;
  if (row.dataset.h !== html) (row.innerHTML = html), (row.dataset.h = html);
}

// The bar's meta: how the run was set up, and where it came from (moved, forked, launched by).
// Repainted on its own when only the summary moved (a fork counted on the original).
export function paintMeta(id) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  if (!s || !n?.body?.querySelector('.it-meta')) return;
  const summary = S.sessions.get(id) || {};
  const forks = (summary.id ? summary.forks : s.forks) || [];
  const proj = projectById(summary.projectId);
  // The head already shows the harness, model and project, and the task head has Compare. This bar
  // says how the run was set up: a mode worth noticing (Plan or Edits, as on the launcher), the
  // branch, the other folders it works in, and what launched it.
  const mode = MODES.find((m) => m.id === s.mode);
  const where = (proj?.path || s.cwd).replace(S.config.home || '', '~');
  const box = $('.it-meta', n.body);
  box.title = [agentName(s.agent), s.model, s.effort && `${effortLabel(s.effort)} thinking`, mode?.label, where, s.worktree?.branch].filter(Boolean).join(' · ');
  box.innerHTML = `
    ${mode && mode !== DEFAULT_MODE ? `<span class="m mode m-${mode.id}" title="${esc(mode.hint)}">${icon(mode.icon)}${esc(mode.label)}</span>` : ''}
    ${s.worktree ? `<span class="m branch" title="${esc(`Worktree: ${s.worktree.path}\n${s.worktree.foreign ? 'Brought in, not made by wisp' : `From ${s.worktree.baseRef}`}${preparedLine(s.worktree.prepared)}`)}">${icon('branch')}${branchHtml(s.worktree.branch)}</span>` : ''}
    ${s.worktree?.prepared?.problems?.length ? `<span class="m setup-warn" title="${esc(s.worktree.prepared.problems.join('\n'))}">${icon('warn')}Worktree setup failed</span>` : ''}
    ${(s.also || []).map((a, i) => `<span class="m also c-${summary.also?.[i]?.color || 'slate'}" title="${esc(`Also works in ${a.cwd}${a.worktree ? `\nWorktree: ${a.worktree.path}\nBranch ${a.worktree.branch}, from ${a.worktree.baseRef}` : ''}`)}"><i class="p-dot"></i>${esc(summary.also?.[i]?.project || a.cwd.split(/[\\/]/).pop())}</span>`).join('')}
    ${s.subagents?.length ? `<span class="m team-m" title="${esc(s.subagents.map((m) => `@${m.name}${copiesOf(m) > 1 ? ` ×${copiesOf(m)}` : ''}: ${memberLabel(m)}${m.use ? ` — ${m.use}` : ''}`).join('\n'))}">${icon('agent')}${teamSize(s.subagents)} delegate${teamSize(s.subagents) > 1 ? 's' : ''}</span>` : ''}
    ${s.moved?.from ? `<span class="m" title="${esc(`This task ran on ${s.moved.from} before it moved here, with its work and history`)}">${icon('server')}From ${esc(s.moved.from)}</span>` : ''}
    ${s.movedTo?.id ? `<button class="m moved-to" data-a="moved" title="This task carries on as a new session on ${esc(s.movedTo.place)}">${icon('server')}Continues on ${esc(s.movedTo.place)}</button>` : ''}
    ${s.forkedFrom ? (S.sessions.has(s.forkedFrom.id) ? `<button class="m fork-from" data-a="fork-src" title="${esc(`Open “${forkTitle(s.forkedFrom)}”, the task this one was forked from`)}">` : `<span class="m fork-from" title="The task this one was forked from was deleted">`) + `${icon('fork')}<span>Forked from <b>${esc(forkTitle(s.forkedFrom))}</b></span>${S.sessions.has(s.forkedFrom.id) ? '</button>' : '</span>'}` : ''}
    ${sideChips(s, summary)}
    ${s.sharedFrom ? `<a class="m fork-from" href="${esc(s.sharedFrom.url)}" target="_blank" rel="noreferrer" title="${esc(`Shared by ${s.sharedFrom.name || s.sharedFrom.handle}${s.sharedFrom.skills?.length ? `\nWith their skills: ${s.sharedFrom.skills.join(', ')}` : ''}\nOpen the shared page`)}">${icon('share')}<span>From <b>${esc(s.sharedFrom.handle ? `@${s.sharedFrom.handle}` : s.sharedFrom.name)}</b></span></a>` : ''}
    ${summary.shared ? `<button class="m forks" data-a="share" title="${esc(`Shared${summary.shared.locked ? ' with a passkey' : ''}: ${summary.shared.url}`)}">${icon('share')}Shared</button>` : ''}
    ${forks.length ? `<button class="m forks" data-a="forks" title="${forks.length > 1 ? 'Tasks forked from this one' : 'Open the task forked from this one'}"${forks.length > 1 ? ' aria-haspopup="menu"' : ''}>${icon('fork')}${forks.length} fork${forks.length > 1 ? 's' : ''}</button>` : ''}
    ${s.origin ? `<span class="m" title="${s.origin.kind === 'telegram' ? 'Started from Telegram' : s.origin.kind === 'x' ? 'Started from a post on X' : `Launched by a ${esc(s.origin.kind)}`}">${icon({ recipe: 'bolt', trigger: 'replay', telegram: 'send' }[s.origin.kind] || 'spark')}${esc(s.origin.name)}</span>` : ''}`;
}

// A long branch gives way in the middle, so where it starts and its id at the end both stay:
// "wisp/add-a-rate…-e648a7" rather than "wisp/add-a-rate-lim…".
function branchHtml(b) {
  const cut = b.lastIndexOf('-');
  const at = b.length > 18 ? (cut > 0 && b.length - cut <= 10 ? cut : b.length - 8) : b.length;
  return `<span class="b-h">${esc(b.slice(0, at))}</span>${at < b.length ? `<span class="b-t">${esc(b.slice(at))}</span>` : ''}`;
}

function forkLine(f) {
  const there = S.sessions.has(f.id);
  const line = el(`<div class="fork-line"><span>${icon('fork')}<i class="fl-wide">This fork starts here</i><i class="fl-narrow">Forked from ${there ? `<button class="link" title="Open the task this one was forked from">${esc(forkTitle(f))}</button>` : `<b>${esc(forkTitle(f))}</b>`}</i></span></div>`);
  const b = $('button', line);
  if (b) b.onclick = () => revealTask(f.id);
  return line;
}

// The task a fork came from, by its name now (renamed since, say), else as it was then.
const forkTitle = (f) => S.sessions.get(f.id)?.title || f.title;

// The original's forks: one opens, several are listed with their state.
function forksMenu(id, btn) {
  const ids = (S.sessions.get(id)?.forks || S.full.get(id)?.forks || []).filter((x) => S.sessions.has(x));
  if (ids.length === 1) return revealTask(ids[0]);
  if (!ids.length) return;
  const r = btn.getBoundingClientRect();
  const menu = el(`<div class="menu forks-menu" style="top:${r.bottom + 6}px;left:${r.left}px">
      ${ids.map((x) => { const f = S.sessions.get(x); return `<button data-id="${esc(x)}">${icon('fork')}<span class="fm-title">${esc(f.title)}</span><span class="fm-state st-${esc(f.state)}">${esc(STATE_WORD[f.state] || f.state)}</span></button>`; }).join('')}
    </div>`);
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    close();
    revealTask(b.dataset.id);
  };
  const close = popover(menu);
  // In the details column the chip sits near the right edge: keep the whole menu on screen.
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 8 - menu.offsetWidth))}px`;
  if (r.bottom + 6 + menu.offsetHeight > innerHeight - 8) menu.style.top = `${Math.max(8, r.top - 6 - menu.offsetHeight)}px`;
}
const STATE_WORD = { running: 'Working', waiting: 'Asking', review: 'Review', done: 'Done' };

// The PR row: in the feed it rides on top of the follow-up box; in split view it sits in the open
// task's details column, above its actions, so it's in reach wherever the task is scrolled to.
export function placePr(body) {
  const strip = body && $('.pr-strip', body);
  if (!strip) return;
  if (document.body.classList.contains('split')) {
    const acts = $('.it-actions', body);
    if (strip.nextElementSibling !== acts) acts.before(strip);
  } else {
    const dock = $('.it-dock', body);
    if (dock.firstElementChild !== strip) dock.prepend(strip);
  }
}

// A subagent opened by itself: its lead hands it work, so instead of a follow-up box the dock
// sends you to the lead (its Ship, Rerun and Done are the lead's too: hidden, subagents.css).
function subDock(body, s) {
  body.classList.add('is-sub');
  const name = s.member ? `@${s.member}` : 'This delegate';
  const go = el(`<div class="sub-dock"><span>${icon('agent')}${esc(name)} takes work from its lead: ask it more from there.</span><button class="ghost xs">${icon('back')}<span>Go to the lead</span></button></div>`);
  $('button', go).onclick = () => {
    revealTask(s.parentId);
  };
  $('.it-dock', body).append(go);
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
  renderBody(id, { fresh: false, byHand: true });
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

// A Compact now turn, folded: what it did, or that nothing happened yet.
const compactSaid = (t) => t.presentation?.blocks?.find((b) => b.type === 'markdown')?.text || 'Compact now';

function renderFoldedTurn(t, unfold) {
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  const sent = !t.goal && sentComments(t.prompt);
  const shrank = t.by === 'compact';
  const said = shrank ? compactSaid(t) : sent ? sent.rest.trim() || `${sent.count} comment${sent.count > 1 ? 's' : ''}${sent.lines === sent.count ? ' on the changes' : sent.lines ? '' : ' on the answer'}` : t.prompt;
  const node = el(`
    <article class="turn folded${t.goal ? ' goal-turn' : ''}${shrank ? ' compact-turn' : ''}" data-turn="${t.id}">
      <button class="t-fold" title="Show this exchange">
        ${icon('chevron', 'chev')}
        <span class="t-prompt">${t.by === 'wisp' ? '<b class="t-by">wisp</b> ' : ''}${t.goal ? `Round ${Number(t.goal) || ''}: what’s still missing`.replace('Round : ', '') : `${sent ? icon('comment', 't-cm') : ''}${mentionHtml(esc(said.slice(0, 300).replace(/\s+/g, ' ')), { link: false })}`}</span>
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
        ${t.moved ? `<span class="t-moved" title="${esc(`Ran on ${t.moved}`)}">${icon('server')}${esc(t.moved)}</span>` : ''}
        ${hero?.title ? `<span class="t-result">${esc(hero.title)}</span>` : ''}
        ${turnTime(t.startedAt)}
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

// A follow-up that ran on another account than the turn before says so, unless wisp's own note
// in that turn (from older tasks, written before a limit asked you first) already names it.
function accountSwitch(s, t) {
  const i = s.turns.indexOf(t);
  const prev = s.turns.slice(0, i).findLast((x) => x.account)?.account;
  const acc = t.account && prev && t.account !== prev && accountOf(t.agent || s.agent, t.account);
  if (!acc || (t.activity || []).some((a) => a.kind === 'account')) return '';
  const was = accountOf(t.agent || s.agent, prev);
  return `<span class="t-acct" title="${esc(`Ran on ${acc.label}${was ? `, not ${was.label}` : ''}`)}">${accountMark(acc)}${esc(acc.label)}</span>`;
}

// A run that hit its account's usage limit (turn.limit): the hero says so, and this card under it
// offers what next. wisp never picks one by itself (the providers' terms, design/accounts.md).
// Every button disables the card at once; a refusal turns it back on with a red toast.
// The same words as the server's LIMIT_CARRY_ON (server/later.js): wisp's own wait uses them too.
const CARRY_ON = 'Carry on from where the last run stopped at the usage limit.';
const KIND_PLAN = { personal: 'a personal plan', work: 'a work plan' };

function limitCard(s, t) {
  const l = t.limit;
  const at = limitUntil({ until: l.until });
  const others = (l.others || []).filter((x) => x && x.id);
  const to = S.agents.find((a) => a.id !== s.agent && a.id !== 'wisp' && a.available);
  // Moving the conversation to an account of the other kind (work ↔ personal) says so, once.
  const across = others.filter((x) => x.kind && l.kind && x.kind !== l.kind);
  const note = across.length
    ? `${across.map((x) => x.label).join(' and ')} ${across.length > 1 ? `are ${KIND_PLAN[across[0].kind].replace(/^a /, '')}s` : `is ${KIND_PLAN[across[0].kind]}`}. This conversation, with its code, will go to ${across.length > 1 ? 'the one you pick' : 'it'}.`
    : '';
  // Waiting: the follow-up sits above the reply box (Later); the card says it's been picked.
  const waiting = (S.sessions.get(s.id)?.later || []).some((x) => x.text === CARRY_ON);
  // Waiting to the reset can outlast the cache: the reply then re-reads everything (web/js/cold-cache.js).
  const coldNote = l.until ? limitColdLine(s, l.until) : '';
  const node = el(`<div class="b-limit${waiting ? ' resolved' : ''}">
      <div class="lm-acts">
        ${l.until ? `<button class="primary sm" data-lm="wait" title="Schedules a follow-up for ${esc(at)}">${icon('clock')}Wait until ${esc(at)}</button>` : ''}
        ${others.map((x) => `<button class="ghost sm" data-lm="account" data-acc="${esc(x.id)}">${accountMark(x)}Continue on ${esc(x.label)}</button>`).join('')}
        ${to ? `<button class="ghost sm" data-lm="agent" data-agent="${esc(to.id)}">${icon('agent')}Hand to ${esc(to.name || agentName(to.id))}</button>` : ''}
        ${l.extra ? `<a class="ghost sm" href="${esc(l.extra)}" target="_blank" rel="noopener">${icon('external')}Get extra usage</a>` : ''}
      </div>
      ${coldNote ? `<p class="lm-note lm-cold">${esc(coldNote)}</p>` : ''}
      ${note ? `<p class="lm-note">${esc(note)}</p>` : ''}
    </div>`);
  const lock = (on) => {
    node.classList.toggle('resolved', on);
    for (const b of $$('button', node)) b.disabled = on;
  };
  if (waiting) lock(true);
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-lm]');
    if (!b || b.disabled) return;
    lock(true);
    if (b.dataset.lm === 'wait') {
      if (!(await scheduleFollowUp(s.id, { at: l.until, text: CARRY_ON }))) lock(false);
      return;
    }
    const run = b.dataset.lm === 'agent' ? { agent: b.dataset.agent } : { account: b.dataset.acc };
    const acc = others.find((x) => x.id === run.account);
    const undo = startOptimistic(s.id, CARRY_ON, null, { run, live: acc ? `Continuing on ${acc.label}` : undefined });
    try {
      await api(`/sessions/${s.id}/reply`, { method: 'POST', body: { text: CARRY_ON, ...run } });
      if (undo) scheduleRefetch(s.id);
    } catch (err) {
      undo?.();
      lock(false);
      toastError(err);
    }
  });
  return node;
}

// A harness that turned the task down (turn.refusal, server/refusal.js): the hero says so, and
// this card hands the same prompt (and its files) to another of your harnesses, which hears this
// task's turns first (server/handoff.js). One click, never by itself; the same Hand to <harness>
// as the usage-limit card. Every button disables the card at once; a refusal turns it back on.
// Only a harness on another vendor's model (web/js/vendors.js): Copilot, opencode or Cursor on a
// Claude model would ask Anthropic again after a Claude refusal. The model is pinned on the hand-off.
const REFUSAL_MAX = 3;
function refusalCard(s, t) {
  const from = t.refusal.agent || t.agent || s.agent;
  const fromModel = t.refusal.model ?? t.model ?? s.model ?? '';
  const to = handoffTargets({ from, fromModel, agents: S.agents, models: S.config?.defaults?.models || {}, max: REFUSAL_MAX });
  const nameOf = (id) => S.agents.find((a) => a.id === id)?.name || agentName(id);
  const node = el(`<div class="b-limit b-refusal">
      ${to.length ? `<div class="lm-acts">${to.map((x, i) => `<button class="${i ? 'ghost' : 'primary'} sm" data-rf="${esc(x.agent)}" data-rf-model="${esc(x.model)}" title="Sends the same prompt to ${esc(nameOf(x.agent))}${x.model ? ` on ${esc(x.model)}` : ''}, with this task's turns">${icon('agent')}Hand to ${esc(nameOf(x.agent))}</button>`).join('')}</div>` : ''}
      ${to.length ? '' : '<p class="lm-note">No agent on another company’s model is set up to take it. Add one in Settings → Agents, or rephrase it in the reply box.</p>'}
    </div>`);
  const lock = (on) => {
    node.classList.toggle('resolved', on);
    for (const b of $$('button', node)) b.disabled = on;
  };
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-rf]');
    if (!b || b.disabled) return;
    lock(true);
    const run = { agent: b.dataset.rf, model: b.dataset.rfModel || '' };
    const files = (t.attachments || []).filter((f) => f.id);
    const undo = startOptimistic(s.id, t.prompt, files, { run });
    try {
      await api(`/sessions/${s.id}/reply`, { method: 'POST', body: { text: t.prompt, attachments: files.map((f) => f.id), ...run } });
      if (undo) scheduleRefetch(s.id);
    } catch (err) {
      undo?.();
      lock(false);
      toastError(err);
    }
  });
  return node;
}

// The usage receipt (web/js/receipt.js): what the run took, quiet, in the trail bar; and Past your
// plan when it was billed beyond the plan (turn.overage). Nothing while it runs: the numbers come at the end.
function receiptHtml(t, s) {
  if (t.status === 'running') return '';
  const r = receiptOf(t);
  const parts = receiptParts(r);
  const o = r?.overage && OVERAGE[r.overage];
  // With several accounts on this harness, the tooltip also has each account's median turn on this
  // model this week (server/budget.js compareAccounts): numbers only, never which one to use.
  const a = S.agents.find((x) => x.id === t.agent);
  const vs = a?.compare ? compareTip(a.compare, t.model, t.account, (id) => a.accounts?.find((x) => x.id === id)?.label || (id === 'default' ? 'Default account' : id)) : '';
  const tip = [receiptTip(r), vs].filter(Boolean).join('. ');
  return (parts.length ? `<span class="tb tb-receipt" title="${esc(tip)}">${parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="tb-dot" aria-hidden="true">·</span>')}</span>` : '') +
    agentsHtml(t, t.agent || s?.agent) +
    (o ? `<span class="tb tb-over" title="${esc(`${o.tip}. Settings → Usage → Plan budget counts these runs`)}">${icon('warn')}${esc(o.label)}</span>` : '');
}

// Where the tokens went, beside the receipt: the subagent type that wrote most (3 web-fetch agents ·
// Opus 5.5 · 27k of 41k output); its tooltip has every type, the tokens per model, and when Claude
// Code ran page reads as an agent because the account had no WebFetch.
// When subagents on the task's model wrote 40% or more of the output, it offers to run them on Haiku
// (opens Settings → Usage → Subagents run on; wisp never changes it for you).
function agentsHtml(t, agent) {
  const parts = subagentParts(t);
  if (!parts.length) return '';
  const offer = offerSubagentModel(t, S.config?.defaults?.subagentModel || '', agent);
  return `<span class="tb tb-agents" title="${esc(subagentTip(t))}">${parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="tb-dot" aria-hidden="true">·</span>')}</span>` +
    (offer ? `<button class="link xs tb-sub-switch" data-a="subagent-model" title="Subagents on the task’s model wrote most of this turn. Pick the model they run on in Settings → Usage">${esc(SUBAGENT_OFFER)}</button>` : '');
}

// A crew member's job that came from another task (delegated, tagged, asked to check on it): its
// first message says which, and opens that task while it's still around.
const FROM_LABEL = { delegated: 'Delegated from', mention: 'Tagged in', event: 'Checking on' };
function fromTask(s) {
  const f = s.crew?.from;
  const label = FROM_LABEL[s.crew?.job];
  if (!label || !f?.id) return null;
  const parent = S.sessions.get(f.id);
  return { id: f.id, label, title: parent?.title || f.title || 'a task', open: !!parent };
}

// `fold` is set for older turns the user unfolded, so they can tuck them away again. `tx`: the card
// shows the full transcript.
function renderTurn(s, t, isLatest, fold, tx) {
  const node = el(`<article class="turn ${t.rolledBackAt ? 'is-rolled-back' : ''}" data-turn="${t.id}"></article>`);
  // Sent back for the goal: the band has the goal and the round, so it shows what's missing and
  // what's next; the whole message (what the agent read) is behind Show all.
  const missing = t.goal && /^What's missing: (.*)$/m.exec(t.prompt)?.[1];
  const next = t.goal && /^Next: (.*)$/m.exec(t.prompt)?.[1];
  // Comments on the last answer (features/comments.js) show as cards over what was typed with them.
  const sent = !t.goal && sentComments(t.prompt);
  const said = sent ? sent.rest : t.prompt;
  const long = !!missing || said.length > 360 || said.split('\n').length > 5;
  // A pasted prompt of hundreds of KB: folded, only its opening is laid out until Show all.
  const cut = !missing && said.length > PROMPT_CUT;
  const cp = t.checkpoint;
  // The task's worktree branch shows once, with the task: a turn names its branch only when it ran
  // on another one (a task in the project folder, where the branch can change between turns).
  const cpBranch = cp?.branch && cp.branch !== s.worktree?.branch ? cp.branch : '';
  const cpLabel = cp?.head ? `${cpBranch ? `${cpBranch}@` : ''}${cp.head.slice(0, 7)}${cp.dirty ? '*' : ''}` : '';
  const from = t.id === s.turns[0]?.id && fromTask(s);
  const shrink = t.by === 'compact';
  node.classList.toggle('compact-turn', shrink);
  // Compact now is a click, not something you said: one quiet line instead of a /compact bubble.
  const ask = shrink ? el(`
    <div class="ask">
      <div class="ask-text">${icon('minus')}Compact now</div>
      ${turnTime(t.startedAt)}
      ${fold ? `<button class="ghost xs t-unfold" title="Collapse this exchange">${icon('chevron', 'chev')}</button>` : ''}
    </div>`) : el(`
    <div class="ask${t.by === 'wisp' ? ' by-wisp' : ''}">
      ${from ? `<div class="ask-by ask-from">${icon('crew')}${from.label}${from.open ? `<button class="link" data-from="${esc(from.id)}">“${esc(from.title)}”</button>` : `<span>“${esc(from.title)}”</span>`}</div>` : ''}
      ${t.side ? `<div class="ask-by ask-from">${icon('discuss')}<span>Sent by wisp from side discussion&nbsp;</span>${S.sessions.has(t.side.id) ? `<button class="link" data-from="${esc(t.side.id)}">“${esc(t.side.title)}”</button>` : `<span>“${esc(t.side.title)}”</span>`}</div>` : t.by === 'wisp' ? `<div class="ask-by">${icon(t.goal ? 'target' : 'spark')}${t.reports ? 'Sent by wisp when your subagents finished' : t.goal ? 'Sent back by wisp: the goal isn’t met yet' : s.worktree?.foreign && t.id === s.turns[0]?.id ? 'Written by wisp, nothing ran' : 'Sent by wisp after its test run'}</div>` : ''}
      ${missing ? `<div class="ask-goal"><b>Still missing</b> ${esc(missing)}${next ? `<span>Next: ${esc(next)}</span>` : ''}</div>` : ''}
      ${sent ? sent.html : ''}
      <div class="ask-text ${long ? 'clamped' : ''}" ${missing || (sent && !said.trim()) ? 'hidden' : ''}>${mentionHtml(esc(cut ? said.slice(0, PROMPT_CUT) : said))}</div>
      ${long ? '<button class="link xs more-btn">Show all</button>' : ''}
      ${t.attachments?.length ? `<div class="ask-atts">${t.attachments.map((a) => (a.mime?.startsWith('image/') ? `<img src="/api/uploads/${a.id}" alt="${esc(a.name)}" title="${esc(a.name)}">` : `<a class="att-pill" href="/api/uploads/${a.id}" target="_blank">${icon('file')}${esc(a.name)}</a>`)).join('')}</div>` : ''}
      <div class="ask-foot">
        ${modelBadge(t.agent || s.agent, t.model ?? s.model, t.effort ?? s.effort, null, null, crewFace(s))}
        ${modeSwitch(s, t)}
        ${accountSwitch(s, t)}
        ${t.moved ? `<span class="t-moved" title="${esc(`Ran on ${t.moved}, before the task moved`)}">${icon('server')}${esc(t.moved)}</span>` : ''}
        ${turnTime(t.startedAt)}
        ${cpLabel ? `<span class="cp-sha" title="Git checkpoint before this turn${cp.branch ? ` on ${esc(cp.branch)}` : ''} (${esc(cp.head)}${cp.dirty ? ' + uncommitted changes' : ''})">${icon('branch')}${esc(cpLabel)}</span>` : ''}
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
      </div>
      ${fold ? `<button class="ghost xs t-unfold" title="Collapse this exchange">${icon('chevron', 'chev')}</button>` : ''}
    </div>`);
  if (fold) ask.querySelector('.t-unfold').onclick = fold;
  ask.querySelector('[data-from]')?.addEventListener('click', () => {
    revealTask(from.id);
  });
  ask.querySelector('.more-btn')?.addEventListener('click', (e) => {
    if (missing) {
      const full = ask.querySelector('.ask-text');
      full.hidden = !full.hidden;
      full.classList.remove('clamped');
      ask.querySelector('.ask-goal').hidden = !full.hidden;
      e.target.textContent = full.hidden ? 'Show all' : 'Show less';
      return;
    }
    const text = ask.querySelector('.ask-text');
    if (text.dataset.cut !== 'whole' && cut) (text.innerHTML = mentionHtml(esc(said))), (text.dataset.cut = 'whole');
    text.classList.toggle('clamped');
    e.target.textContent = ask.querySelector('.ask-text').classList.contains('clamped') ? 'Show all' : 'Show less';
  });
  const atts = [...ask.querySelectorAll('.ask-atts img')];
  atts.forEach((img, index) => img.addEventListener('click', () => viewImage(img.src, img.alt, { list: atts.map((i) => ({ src: i.src, alt: i.alt })), index })));
  node.append(ask);
  // Its harness's program changed since wisp pinned it (features/harness-watch.js), until trusted.
  const hw = t.status !== 'held' && t.harness && harnessNote(t.agent || s.agent, t.harness);
  if (hw) node.append(el(hw));
  // Ran without the repo's hooks and MCP servers (server/project-trust.js): say so, it explains a missing tool.
  if (t.untrusted && t.status !== 'held') node.append(el(`<div class="hw-note pt-without">${icon('info')}<span class="hw-say">Ran without this repo’s hooks and MCP servers (and without your own MCP servers). A new task in this repo asks again.</span></div>`));

  if (t.status === 'held') {
    // Held near the limit (features/hold.js): the card is all there is until it goes.
    const card = el('<div class="blk blk-limit blk-held"></div>');
    card.append(heldCard(s, t));
    node.append(card);
  } else if (t.status === 'running') {
    if (tx) node.append(renderLiveTranscript(s, t, ctxFor(s, t, isLatest)));
    node.append(renderWorking(s, t, tx));
  } else {
    const ctx = ctxFor(s, t, isLatest);
    // The trail under it carries the time, cost and files, so the hero doesn't repeat them.
    // answer: the turn a Compact now under it left open keeps its look, so nothing moves on the click.
    const answer = !isLatest && s.turns.at(-1)?.by === 'compact' && t === s.turns.findLast((x) => x.by !== 'compact');
    const out = tx ? renderTranscript(s, t, ctx) : renderPresentation(t.presentation, { ...ctx, trail: true, answer });
    if (isLatest && (t.limit || t.refusal || t.signedOut) && s.state !== 'running') {
      const card = el('<div class="blk blk-limit"></div>');
      card.style.setProperty('--d', '110ms'); // right after the hero
      card.append(t.limit ? limitCard(s, t) : t.signedOut ? signInCard(s, t) : refusalCard(s, t));
      const hero = $('.blk-hero', out);
      hero ? hero.after(card) : out.prepend(card);
    }
    node.append(out);
    const subs = renderSubs(s, t);
    if (subs) node.append(subs);
    node.append(el('<div class="t-offers"></div>')); // kit files proposed for a crew member (crew.js paintOffers)
    node.append(renderTrail(s, t, tx));
    if (isLatest && s.goal?.status === 'checking') node.append(renderGoalCheck(s));
  }
  node.append(el('<div class="btw-list"></div>')); // side questions asked during this turn (btw.js)
  return node;
}

// The goal's check after a round (server/goal.js): the task is still in Working, so the latest turn
// keeps a live panel, with Stop, while wisp reads the changes and runs the tests.
function renderGoalCheck(s) {
  const node = el(`
    <div class="w-panel goal-check">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status"><b>Checking the goal…</b><span class="elapsed" data-start="${s.turns.at(-1)?.endedAt || Date.now()}">0s</span></div>
        <p class="gc-what">Reading the changes and running the tests: wisp’s own look, not the agent’s word.</p>
        <div class="w-actions"><span class="grow"></span><button class="ghost sm danger stop">${icon('stop')}Stop</button></div>
      </div>
    </div>`);
  $('.stop', node).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.lastChild.textContent = 'Stopping…';
    await api(`/sessions/${s.id}/stop`, { method: 'POST', body: {} }).catch((err) => {
      btn.disabled = false;
      btn.lastChild.textContent = 'Stop';
      toastError(err);
    });
  };
  return node;
}

// The live panel. With the transcript on, the steps are already on the timeline above it, so it
// keeps only the status, the question, the team and Stop.
function renderWorking(s, t, tx) {
  const waiting = !!s.ask;
  const shrink = t.by === 'compact'; // one step, nothing to count or show
  const node = el(`
    <div class="w-panel ${waiting ? 'waiting' : ''} ${tx ? 'tx-panel' : ''}">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status">
          <b>${waiting ? `${esc(agentName(s.agent))} is waiting for you` : shrink ? 'Compacting' : `${esc(agentName(s.agent))} is working`}</b>
          <span class="elapsed" data-start="${t.startedAt}">${fmtDuration(Date.now() - t.startedAt)}</span>
          <span class="w-count"${shrink ? ' hidden' : ''}>${actionCount(t)}</span>
        </div>
        <div class="ask-slot"></div>
        ${teamLiveHtml(s, t)}
        ${tx ? '' : '<ul class="ticker"></ul>'}
        <div class="w-actions">
          ${tx ? '' : `<button class="link xs peek"${shrink ? ' hidden' : ''}>Show all activity</button>`}
          ${s.queue?.length ? `<span class="w-queued">${s.queue.length} follow-up${s.queue.length > 1 ? 's' : ''} queued</span>` : ''}
          <span class="grow"></span>
          ${S.sessions.get(s.id)?.watch ? `<button class="ghost sm w-watch">${icon('eye')}Watch</button>` : ''}
          <button class="ghost sm danger stop"${s.queue?.length ? ' title="Stop: your queued follow-ups stay, held until you send one"' : ''}>${icon('stop')}Stop</button>
        </div>
        <ul class="log" hidden></ul>
      </div>
    </div>`);
  if (waiting) $('.ask-slot', node).append(renderAskCard(s));
  // The /btw tip goes after Show all activity. The transcript's panel has none: it leads the row with Stop.
  const tip = btwTip(s.id);
  if (tip && tx) $('.w-actions', node).prepend(tip);
  else if (tip) $('.peek', node).after(tip);
  const quiet = el(`<span class="w-noout" data-turn="${esc(t.id)}" hidden></span>`);
  $('.w-status', node).append(quiet);
  if (stream.ok(s.id, Date.now())) paintQuiet(quiet, s, t, Date.now()); // past 12 min on a reload: there at once
  const ticker = $('.ticker', node);
  if (ticker)
    t.activity
      .filter((a) => a.kind !== 'text')
      .slice(-5)
      .forEach((a) => ticker.prepend(actItem(a)));
  // The page its agent keeps up to date (wisp_watch): the way in on a phone, where it doesn't open by itself.
  const watch = $('.w-watch', node);
  if (watch)
    watch.onclick = () => {
      openPanel(s.id, 'watch');
    };
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

function paintQuiet(n, s, t, now) {
  const text = noOutputLine(s, t, now);
  if (!text && !n.textContent) return;
  if (n.textContent !== text) {
    n.textContent = text;
    n.hidden = !text;
  }
  if (n.isConnected) fitQuiet(n);
  else beforePaint(() => fitQuiet(n)); // a panel still being built
}

// The row makes room for the line as wide as it shows now: none while a spell hides it, so the count
// and the time are back. Every tick, as a spell can come and go with the words unchanged.
function fitQuiet(n) {
  const w = n.offsetWidth;
  const row = n.parentElement;
  row.classList.toggle('w-quiet', w > 0);
  if (row.style.getPropertyValue('--w-noout') !== `${w}px`) row.style.setProperty('--w-noout', `${w}px`);
}

// The 1 s tick: from the task as it is now, not as it was rendered, so new activity or a question
// clears the line. A copy the stream can't vouch for keeps what's shown (no-output.js freshness).
export function paintNoOutput() {
  const now = Date.now();
  for (const n of $$('.w-noout')) {
    const id = n.closest('.item[data-id]')?.dataset.id;
    const s = id && S.full.get(id);
    const t = s?.turns.find((x) => x.id === n.dataset.turn);
    if (t && stream.ok(id, now)) paintQuiet(n, s, t, now);
  }
}

// A line in the ticker and the activity log. A message (kept whole for the transcript) shows its start.
function actItem(a) {
  const label = a.kind === 'text' && a.label?.length > 400 ? `${a.label.slice(0, 400)}…` : a.label || '';
  return el(`<li class="act k-${a.kind}">${icon(KIND_ICON[a.kind] || 'tool')}<span>${esc(label)}</span></li>`);
}

// wisp_connector_signin: the agent added a connector that needs the user's sign-in or keys. The
// values go from here straight to wisp, never through the agent; the card closes on its own once
// the connector works (the server answers it), or with Skip.
function renderConnectorCard(s) {
  const a = s.ask;
  const c = a.connector;
  const keys = c.kind === 'keys' ? c.keys : [];
  const node = el(`
    <div class="ask-card cx-ask">
      <div class="q-head">${icon('plug')}<span>${c.kind === 'signin' ? 'Sign-in needed' : 'A key is needed'}</span></div>
      <p class="q-text">${esc(a.question)}</p>
      ${a.context ? `<div class="prose q-context">${md(a.context)}</div>` : ''}
      ${keys.length ? `<form class="cx-ask-keys">${keys.map((k, i) => `<label><span>${esc(k.key)}</span><input class="input mono" type="password" data-i="${i}" autocomplete="new-password" spellcheck="false" placeholder="${k.set ? 'Saved · type to replace' : 'Paste it here'}"></label>`).join('')}<button hidden></button></form>` : ''}
      <div class="q-opts"><button class="opt go" data-a="go">${icon(c.kind === 'signin' ? 'lock' : 'check')}${c.kind === 'signin' ? 'Sign in' : 'Save'}</button><button class="opt" data-a="skip">Skip</button></div>
      <p class="cx-result" aria-live="polite">${c.kind === 'keys' ? 'Kept as secrets on this computer; the agent never sees them.' : ''}</p>
    </div>`);
  const result = $('.cx-result', node);
  const save = async () => {
    const vals = $$('input[data-i]', node).map((x) => x.value);
    if (!vals.some(Boolean)) return $('input[data-i]', node)?.focus();
    // Every key of a field goes back (one left out is deleted); an empty one keeps what's saved.
    const body = {};
    keys.forEach((k, i) => ((body[k.field] ||= {})[k.key] = vals[i]));
    const btn = $('[data-a="go"]', node);
    btn.disabled = true;
    result.className = 'cx-result muted';
    result.innerHTML = '<span class="orb tiny"></span>Checking it…';
    try {
      await api(`/connectors/${c.id}`, { method: 'PATCH', body });
      $$('input[data-i]', node).forEach((x) => (x.value = ''));
      const v = await api(`/connectors/${c.id}/test`, { method: 'POST', body: {} });
      const t = v.connectors.find((x) => x.id === c.id)?.test;
      // Working: wisp answers the card and the agent carries on.
      result.className = `cx-result ${t?.ok ? 'ok' : 'bad'}`;
      result.innerHTML = t?.ok ? `${icon('check')}<span>${t.count} tool${t.count === 1 ? '' : 's'}</span>` : `${icon('warn')}<span>${esc(t?.error || 'It didn’t answer')}</span>`;
    } catch (err) {
      result.className = 'cx-result bad';
      result.innerHTML = `${icon('warn')}<span>${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  };
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'go') {
      if (c.kind === 'signin') signIn({ id: c.id, name: c.name });
      else save();
      return;
    }
    node.classList.add('sent');
    try {
      await api(`/sessions/${s.id}/answer`, { method: 'POST', body: { text: 'Skip' } });
      scheduleRefetch(s.id);
    } catch (err) {
      node.classList.remove('sent');
      toastError(err);
    }
  });
  const f = $('form', node);
  if (f) {
    f.onsubmit = (e) => {
      e.preventDefault();
      save();
    };
  }
  return node;
}

// A side discussion's clash card (side.js). The first button applies, after the server's recheck: a
// card that no longer holds comes back redrawn, with a toast. Words go in the reply box (keeps main's
// version, composer.js).
function renderClashCard(s) {
  const a = s.ask;
  const node = el(clashCardHtml(a));
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('.opt');
    if (!b) return;
    node.classList.add('sent');
    const undo = startOptimistic(s.id, a.options[b.dataset.i], null, { answering: true });
    try {
      await api(`/sessions/${s.id}/clash`, { method: 'POST', body: { askId: a.id, action: b.dataset.i === '0' ? 'apply' : 'keep', sig: a.clash.sig } });
      if (undo) scheduleRefetch(s.id);
    } catch (err) {
      node.classList.remove('sent');
      undo?.();
      toastError(err);
      scheduleRefetch(s.id);
    }
  });
  return node;
}

function renderAskCard(s) {
  const a = s.ask;
  if (a.connector) return renderConnectorCard(s);
  if (a.clash) return renderClashCard(s);
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
  const canRollback = s.agent !== 'wisp' && !s.sideOf && s.state !== 'running' && (t.changes?.length || t.checkpoint?.commit);
  const rolledBack = !!t.rolledBackAt;
  const rated = t.feedback?.rating;
  // Forking from here needs the work as it was after this turn: the folder now for the latest
  // one, else the snapshot the next turn took when it started.
  const after = s.turns[s.turns.indexOf(t) + 1];
  const canFork = forkable(s) && t.status !== 'running' && (!after || !!after.checkpoint?.head);
  const node = el(`
    <div class="trail">
      <div class="trail-bar">
        ${acts.length && !tx ? `<button class="tb-acts" data-tab="activity" title="Show activity">${parts.length ? parts.map(([ic, l, n]) => `<span class="tb" title="${n} ${l}">${icon(ic)}${n}<span class="tb-l"> ${l}</span></span>`).join('') : 'Activity'}</button>` : ''}
        ${t.endedAt > t.startedAt ? `<span class="tb">${fmtDuration(t.endedAt - t.startedAt)}</span>` : ''}
        ${st.costUsd ? `<span class="tb">$${st.costUsd.toFixed(2)}</span>` : ''}
        ${receiptHtml(t, s)}
        <span class="grow"></span>
        ${t.changes?.length ? `<button class="link xs" data-tab="changes">${t.changes.length} file${t.changes.length > 1 ? 's' : ''} <span class="plus">+${totals.add}</span> <span class="minus">−${totals.del}</span></button>` : ''}
        <span class="tb-tools">
          ${t.presentation?.notes && !tx ? `<button class="tb-btn" data-tab="notes" title="Agent notes" aria-label="Agent notes">${icon('text')}</button>` : ''}
          ${canRollback ? (rolledBack
            ? `<button class="link xs cp-rollback rolled-back" data-a="rollback" title="Re-apply changes from this turn">${icon('rerun')}Re-apply</button>`
            : `<button class="tb-btn cp-rollback" data-a="rollback" title="Restore working tree to before this turn${t.checkpoint?.head ? ` (${t.checkpoint.head.slice(0, 7)})` : ''}" aria-label="Restore to before this turn">${icon('replay')}</button>`) : ''}
          ${canFork ? `<button class="tb-btn tb-fork" data-a="fork" title="Fork from this turn: a new task that carries on from here" aria-label="Fork from this turn">${icon('fork')}</button>` : ''}
          ${feedbackOn() ? `<span class="rate ${rated ? 'rated' : ''}">${['up', 'down'].map((r) => `<button class="rate-btn ${rated === r ? 'on' : ''}" data-rate="${r}" title="${r === 'up' ? 'Good result' : 'Bad result'}: tell the wisp team" aria-pressed="${rated === r}">${icon(`thumb-${r}`)}</button>`).join('')}</span>` : ''}
        </span>
      </div>
      <div class="trail-body" hidden></div>
    </div>`);
  const body = $('.trail-body', node);
  let open = null;
  node.addEventListener('click', (e) => {
    if (e.target.closest('.tr-all')) return openPanel(s.id, 'changes');
    if (e.target.closest('[data-a="rollback"]')) {
      return rollbackTurn(s.id, t.id, rolledBack);
    }
    if (e.target.closest('[data-a="fork"]')) {
      return forkTask(s.id, t.id);
    }
    if (e.target.closest('[data-a="subagent-model"]')) {
      import('./settings.js').then((m) => m.openSettings({ pane: 'usage', focus: 'subagentModel' }));
      return;
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
      // This turn's edits, with its own Revert; the whole task's are in the side panel.
      if (s.turns.length > 1) body.append(el(`<button class="link xs tr-all" data-a="changes">${icon('file')}All changes in this task</button>`));
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
  const box = S.open.has(sessionId) ? S.nodes.get(sessionId)?.body : null;
  const tail = !!box && atTail(box); // the ticker and the log grow too, before a render pins it
  if (node && turn) appendStep(node, item, turn, scrollByPx, box);
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
  if (c && turn) c.textContent = actionCount(turn);
  if (tail) toEnd(box);
}
