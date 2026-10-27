// Ask near the limit (design/hold.md): a send that would take its account's 5-hour or weekly window
// past the line you set waits for you. The page decides before it sends (the rule in
// web/js/limit-hold.js, the numbers on the harness list as `budget`), so the hold is instant and the
// draft stays; the server checks the same rule and answers 409 { hold } when the page couldn't tell.
// Here: the hold row over the prompt and reply boxes, and the card under a run held for the reset.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toastError } from '../ui/toast.js';
import { holdFor, holdTo } from '../limit-hold.js';
import { renderFeed } from './feed.js';
import { aheadLabel, whenTip } from './later.js';
import { accountOf, agentName } from './runners.js';

const pct = (x) => `${Math.floor(x * 100)}%`;
// "Weekly" → "weekly"; "Weekly Opus" → "weekly Opus".
const lower = (label) => String(label || 'usage').replace(/^\w/, (c) => c.toLowerCase());

// The window a run of `agent` on `account` would take past its line, or null. list: a place's
// harness list (S.agents here). An account wisp would pick itself ('' with several) isn't known
// yet: the server checks that one.
export function holdNow(agent, account, kind = 'first', list = S.agents) {
  if (!agent || agent === 'auto') return null;
  const a = list?.find((x) => x.id === agent);
  if (!a?.budget?.length) return null;
  const many = a.accounts?.length > 1;
  if (many && !account) return null;
  const b = a.budget.find((x) => x.account === (many ? account : 'default'));
  return b ? holdFor(b.windows, kind) : null;
}

// The window of a harness (one account, or any) that's at or past its line, fullest first, for
// the harness picker: { label, used } or null.
export function nearLine(a, account) {
  let out = null;
  for (const b of a?.budget || []) {
    if (account !== undefined && b.account !== (account || 'default')) continue;
    for (const w of b.windows || []) if (w.line > 0 && w.used >= w.line && (!out || w.used > out.used)) out = { label: w.label, used: w.used };
  }
  return out;
}

// "Claude Code’s", "Claude Code (Work)’s": the account only when the harness has several.
function whose(h) {
  const acc = h.account && h.account !== 'default' ? accountOf(h.agent, h.account) : null;
  return `${agentName(h.agent)}${acc ? ` (${acc.label})` : ''}’s`;
}

// What ends the sentence: where it would likely end up, or that it's past your line already.
function landing(h, kind) {
  const to = holdTo(h);
  if (h.to[1] - h.used < 0.005) return `, past your ${pct(h.line)} line.`;
  const where = to === 'past the limit' ? to : `to ${to}`;
  return kind === 'followUp' ? `. A follow-up like this usually takes it ${where}.` : `. This task may take it ${where}.`;
}

// The hold row over a box: it says why, and offers Send anyway (Start anyway in the prompt box),
// Wait until the reset, and × Keep editing. The draft stays in the box all along. Keys while it's
// up: Enter goes anyway (not a held-down repeat, and not in its first 300 ms), Alt+Enter waits,
// Esc keeps editing.
// row: the row's element; ta: the box; h: holdNow() or the server's hold; kind: first | followUp.
// go(), wait(at), keep(): what each does (the row is gone by then).
export function showHold(row, ta, h, { kind = 'first', go, wait }) {
  hideHold(row);
  const send = kind === 'followUp' ? 'Send anyway' : 'Start anyway';
  const at = h.resetsAt && h.resetsAt > Date.now() + 60_000 ? h.resetsAt : null;
  row.innerHTML = `<p class="hd-say">${esc(`${whose(h)} ${lower(h.label)} window is at ${pct(h.used)}`)}${esc(landing(h, kind))}</p>
    <div class="hd-acts">
      <button type="button" class="primary sm" data-hd="go" title="${esc(send)} (Enter)">${esc(send)}</button>
      ${at ? `<button type="button" class="ghost sm" data-hd="wait" title="${esc(`${whenTip(at)} (⌥Enter)`)}">${icon('clock')}Wait until ${esc(aheadLabel(at))}</button>` : ''}
    </div>
    <button type="button" class="att-x hd-x" data-hd="keep" aria-label="Keep editing" title="Keep editing (Esc)">${icon('x')}</button>`;
  row.hidden = false;
  row.closest('.launcher, .composer')?.classList.add('hold-on');
  const shown = performance.now();
  const act = (what) => {
    hideHold(row);
    if (what === 'go') go();
    else if (what === 'wait') wait(at);
    ta?.focus();
  };
  row.onclick = (e) => {
    const b = e.target.closest('button[data-hd]');
    if (b) act(b.dataset.hd);
  };
  const keys = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return act('keep');
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.altKey) return at && act('wait');
    if (e.repeat || performance.now() - shown < 300) return; // a double Enter doesn't slip through
    act('go');
  };
  ta?.addEventListener('keydown', keys, true);
  row.unhold = () => ta?.removeEventListener('keydown', keys, true);
}

export function hideHold(row) {
  if (!row || row.hidden) return;
  row.unhold?.();
  row.unhold = null;
  row.hidden = true;
  row.innerHTML = '';
  row.closest('.launcher, .composer')?.classList.remove('hold-on');
}

// The card under a run held for the reset (turn.status 'held', server/guard.js): it says what it
// would have taken, and offers Start now / Send now, Wait until the reset, Skip this run. Each
// button locks the card at once; a refusal unlocks it with a red toast.
export function heldCard(s, t) {
  const h = { ...t.held, agent: t.held.agent || s.agent };
  const first = h.kind !== 'followUp';
  const at = h.until;
  const why = h.to[1] - h.used >= 0.005 ? `this run may take ${whose(h)} ${lower(h.label)} window from ${pct(h.used)} ${holdTo(h) === 'past the limit' ? 'past the limit' : `to ${holdTo(h)}`}` : `${whose(h)} ${lower(h.label)} window was at ${pct(h.used)}, past your ${pct(h.line)} line`;
  const say = h.waiting
    ? `Waiting for the reset: it ${first ? 'starts' : 'goes'} by itself ${aheadLabel(at)}.`
    : `Held before it ${first ? 'started' : 'was sent'}: ${why}. It ${first ? 'starts' : 'goes'} by itself ${aheadLabel(at)}.`;
  const node = el(`<div class="b-limit b-held${h.waiting ? ' waiting' : ''}">
      <p class="hd-say">${esc(say)}</p>
      <div class="lm-acts">
        <button class="primary sm" data-held="start">${icon('play')}${first ? 'Start now' : 'Send now'}</button>
        ${h.waiting ? '' : `<button class="ghost sm" data-held="wait" title="${esc(`Out of Needs you until then: ${whenTip(at)}`)}">${icon('clock')}Wait</button>`}
        <button class="ghost sm" data-held="skip">${icon('skip')}Skip this run</button>
      </div>
    </div>`);
  const lock = (on) => {
    node.classList.toggle('resolved', on);
    for (const b of $$('button', node)) b.disabled = on;
  };
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-held]');
    if (!b || b.disabled) return;
    lock(true);
    const ok = await heldAction(s.id, b.dataset.held);
    if (!ok) lock(false);
  });
  return node;
}

// Start / wait / skip a held run, from the card, a row's menu or ⌘K. The row moves at once (Working,
// Scheduled or Done); the server's summary follows. false when it refused (the toast says why).
export async function heldAction(id, action) {
  const s = S.sessions.get(id);
  const was = s && { state: s.state, status: s.status, unread: s.unread, held: s.held, live: s.live };
  if (s) {
    if (action === 'start') Object.assign(s, { state: 'running', status: 'running', unread: false, held: undefined, live: 'Starting up' });
    else if (action === 'wait') Object.assign(s, { state: 'done', unread: false, held: { ...s.held, waiting: true } });
    else Object.assign(s, { state: 'done', status: 'info', unread: false, held: undefined });
    renderFeed();
  }
  try {
    const next = await api(`/sessions/${id}/held`, { method: 'POST', body: { action } });
    if (next?.id) S.sessions.set(next.id, { ...S.sessions.get(next.id), ...next });
    return true;
  } catch (err) {
    if (s && was) Object.assign(s, was);
    renderFeed();
    toastError(err);
    return false;
  }
}

// The words wisp uses for each, so every surface (card, row menu, ⌘K) says the same.
export const HELD_LABEL = { start: (s) => (s.held?.kind === 'followUp' ? 'Send now' : 'Start now'), wait: () => 'Wait', skip: () => 'Skip this run' };
