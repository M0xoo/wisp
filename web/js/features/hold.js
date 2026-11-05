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
import { compactNote, compactTip } from '../cold-cache.js';
import { renderFeed } from './feed.js';
import { aheadLabel, whenTip } from './later.js';
import { accountOf, agentName } from './runners.js';
import { changeText } from './harness-watch.js';
import { openInEditor } from './actions.js';

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
// compact: { offer, run } on a follow-up to a large warm task (compactable in actions.js): Compact
// now beside the rest, with both prices. The draft stays in the box.
export function showHold(row, ta, h, { kind = 'first', go, wait, compact }) {
  hideHold(row);
  const shrink = kind === 'followUp' && h.used < 1 ? compact : null;
  const send = kind === 'followUp' ? 'Send anyway' : 'Start anyway';
  const at = h.resetsAt && h.resetsAt > Date.now() + 60_000 ? h.resetsAt : null;
  row.innerHTML = `<p class="hd-say">${esc(`${whose(h)} ${lower(h.label)} window is at ${pct(h.used)}`)}${esc(landing(h, kind))}</p>
    <div class="hd-acts">
      <button type="button" class="primary sm" data-hd="go" title="${esc(send)} (Enter)">${esc(send)}</button>
      ${at ? `<button type="button" class="ghost sm" data-hd="wait" title="${esc(`${whenTip(at)} (⌥Enter)`)}">${icon('clock')}Wait until ${esc(aheadLabel(at))}</button>` : ''}
      ${shrink ? `<span class="hd-compact-wrap"><button type="button" class="ghost sm hd-compact" data-hd="compact" title="${esc(compactTip(shrink.offer))}">${icon('minus')}Compact now</button><span class="hd-compact-note" title="${esc(compactTip(shrink.offer))}">${esc(compactNote(shrink.offer))}</span></span>` : ''}
    </div>
    <button type="button" class="att-x hd-x" data-hd="keep" aria-label="Keep editing" title="Keep editing (Esc)">${icon('x')}</button>`;
  row.hidden = false;
  row.closest('.launcher, .composer')?.classList.add('hold-on');
  const shown = performance.now();
  const act = (what) => {
    hideHold(row);
    if (what === 'go') go();
    else if (what === 'wait') wait(at);
    else if (what === 'compact') shrink.run();
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
  if (h.project) return wire(s, projectCard(s, h));
  if (h.harness) return wire(s, harnessCard(h));
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
  return wire(s, node);
}

// Held for a changed harness (Settings → Agents → Ask before running a changed harness): it says
// what changed and waits for Trust and start, or Skip this run. Nothing to wait for by itself.
function harnessCard(h) {
  const c = h.harness;
  const say = c.checking ? `Checking ${agentName(h.agent)}’s program before it starts: it changed since wisp last ran it.` : `Held before it started: ${changeText(h.agent, c)}.${c.kind === 'update' ? '' : ' If you didn’t install this, skip it.'}`;
  return el(`<div class="b-limit b-held hw-held${c.kind === 'update' || c.checking ? '' : ' hw-warn'}">
      <p class="hd-say">${icon(c.kind === 'update' || c.checking ? 'info' : 'warn')}${esc(say)}</p>
      <div class="lm-acts">
        <button class="primary sm" data-held="start">${icon('play')}${HELD_LABEL.start({ held: h })}</button>
        <button class="ghost sm" data-held="skip">${icon('skip')}Skip this run</button>
      </div>
    </div>`);
}

// Held for a repo's hooks, MCP servers or worktree setup (server/project-trust.js, Settings →
// Privacy): what it would run, each with Open file, and Trust and start / Run without them / Skip.
// It says what the repo asks to run; it doesn't say whether that's safe.
const PT_KIND = { hook: 'Hook', mcp: 'MCP server', command: 'Command', plugin: 'Plugin', setup: 'Setup' };
const ptItem = (x) => `<li class="pt-item">
    <span class="pt-head"><span class="pt-kind">${esc(PT_KIND[x.kind] || x.kind)}</span><b class="pt-name">${esc(x.name)}</b><button type="button" class="ghost xs pt-open" data-file="${esc(x.file)}" title="${esc(x.file)}">${icon('external')}Open file</button></span>
    <code class="pt-cmd">${esc(x.command)}</code>
  </li>`;
function projectCard(s, h) {
  const p = h.project;
  const setup = p.setup === 'running';
  const say = setup
    ? 'Trusted. Running the repo’s worktree setup; the run starts when it’s done.'
    : `${p.changed ? 'This repo’s hooks, servers or setup changed since you trusted it.' : 'This repo asks to run its own programs.'} Held before it ${h.kind === 'followUp' ? 'was sent' : 'started'}: these would run on this computer, as you, whatever the mode.`;
  const node = el(`<div class="b-limit b-held pt-held">
      <p class="hd-say">${icon(setup ? 'info' : 'warn')}<span>${esc(say)}</span></p>
      <ul class="pt-list">${p.items.map(ptItem).join('')}</ul>
      <div class="lm-acts">
        <button class="primary sm" data-held="start"${setup ? ' disabled' : ''}>${icon('play')}${HELD_LABEL.start({ held: h })}</button>
        <button class="ghost sm" data-held="without"${setup ? ' disabled' : ''} title="Claude Code runs with your own settings only: not the repo’s hooks or its MCP servers (nor your own MCP servers, on this task), and a new worktree’s setup doesn’t run">${icon('skip')}${HELD_LABEL.without()}</button>
        <button class="ghost sm" data-held="skip"${setup ? ' disabled' : ''}>${icon('skip')}Skip this run</button>
      </div>
    </div>`);
  node.addEventListener('click', (e) => {
    const b = e.target.closest('.pt-open');
    if (b) openInEditor(s, b.dataset.file);
  });
  return node;
}

function wire(s, node) {
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
    if (action === 'start' || action === 'without') Object.assign(s, { state: 'running', status: 'running', unread: false, held: undefined, live: 'Starting up' });
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
export const HELD_LABEL = { start: (s) => (s.held?.harness || s.held?.project ? 'Trust and start' : s.held?.kind === 'followUp' ? 'Send now' : 'Start now'), wait: () => 'Wait', without: () => 'Run without them', skip: () => 'Skip this run' };
