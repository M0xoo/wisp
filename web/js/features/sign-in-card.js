// A run that failed because its harness is signed out (turn.signedOut, server/runner.js #signedOut):
// the card under the hero signs in where you are, with the login Settings → Agents uses
// (features/agent-login.js), kept per harness and account, so a repaint keeps its link, code and box.
//
// Sign in tells the server first (POST …/turns/:id/sign-in), so the login landing sends the request
// again, once, in the same conversation. A sign-in from elsewhere leaves Signed in and Try again.
// Continue on <account> only ever comes from a click (design/accounts.md).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toastError } from '../ui/toast.js';
import { accKey, CAN, KEYED, loginAt, loginControl, loginPanel, loginState, seedSignIn, wireLogins } from './agent-login.js';
import { startOptimistic } from './composer.js';
import { scheduleRefetch } from './feed.js';
import { accountMark } from './runners.js';

const armed = new Map(); // turn id -> keys saved when it was armed (0 for a login): its sign-in here sends it again
const keysSet = (l) => (l.providers || []).filter((p) => p.set).length;
// The server can decline a rerun a sign-in was to send (the task was filed, a terminal opened). No
// new turn this long after: the card says Signed in and offers Try again.
const SENDING_MS = 8000;
const sendingFor = new Map(); // turn id -> { node, timer }: one per turn, and it ends by itself

export function signInCard(s, t) {
  const o = t.signedOut;
  const agent = o.agent || t.agent || s.agent;
  const acc = accKey(o.account);
  const scope = o.scope || s.machine?.id || '';
  const keyed = KEYED.has(agent);
  const others = (o.others || []).filter((x) => x?.id);
  // A sandbox has no login of its own: it borrows the sign-ins set up for sandboxes.
  const flow = CAN.has(agent) && !S.sandboxes.some((m) => m.id === scope);
  if (flow) seedSignIn(scope, agent, acc, { turn: t.id, open: keyed });
  const node = el(`<div class="b-limit b-signin" data-acc-row>
      <div class="lm-acts">
        ${!flow ? `<button class="${o.stillIn ? 'ghost' : 'primary'} sm" data-si="settings">${o.stillIn ? 'Sign in again' : `${icon('lock')}Sign in`}</button>` : keyed ? '' : loginControl(agent, scope, acc, true)}
        <button class="${(flow && !keyed) || o.stillIn ? 'primary' : 'ghost'} sm" data-si="again"${flow && !keyed ? ' hidden' : ''}>Try again</button>
        ${others.map((x) => `<button class="ghost sm" data-si="again" data-acc="${esc(x.id)}" title="Continue on ${esc(x.label)}">${accountMark(x)}<span class="si-lbl">Continue on ${esc(x.label)}</span></button>`).join('')}
        ${flow && !keyed ? `<button class="ghost sm" data-si-again data-login ${loginAt(scope, agent, acc)} hidden>Sign in again</button>` : ''}
        <p class="si-said" role="status" hidden></p>
      </div>
      ${flow ? loginPanel(agent, scope, acc, true) : ''}
      ${o.oldCli ? '<p class="lm-note">Claude Code before 2.1.318 can stop other running tasks on this login when you sign in. Update it first if you have tasks running.</p>' : ''}
    </div>`);
  const said = $('.si-said', node);
  const lock = (on) => {
    node.classList.toggle('resolved', on);
    for (const b of $$('.lm-acts button', node)) b.disabled = on;
  };
  const stopSending = () => {
    clearTimeout(sendingFor.get(t.id)?.timer);
    sendingFor.delete(t.id);
  };
  // Started once per drawn card: a new one starts over, and a card that's gone just ends here.
  const sendingWatch = () => {
    if (sendingFor.get(t.id)?.node === node) return;
    stopSending();
    const timer = setTimeout(() => {
      sendingFor.delete(t.id);
      armed.delete(t.id);
      if (!node.isConnected || S.full.get(s.id)?.turns.at(-1)?.id !== t.id) return;
      lock(false);
      paint();
      scheduleRefetch(s.id);
    }, SENDING_MS);
    sendingFor.set(t.id, { node, timer });
  };
  const paint = () => {
    const l = flow ? loginState(agent, scope, acc) : {};
    if (l.state === 'failed' || l.state === 'cancelled') armed.delete(t.id);
    const going = l.state === 'running' || l.state === 'waiting';
    const signedIn = keyed ? armed.has(t.id) && keysSet(l) >= armed.get(t.id) : l.signedIn === true && !going && l.state !== 'failed';
    const sending = signedIn && armed.has(t.id);
    // The CLI says it's in (runner #askCli): the hero explains, and Sign in becomes Sign in again.
    const offerAgain = signedIn || (!!o.stillIn && !going && l.state !== 'failed');
    said.hidden = sending ? false : !signedIn || !!o.stillIn;
    // In the row of buttons, so saying it adds no line. Only when it changes: a redraw restarts the spinner.
    const word = sending ? 'sending' : signedIn ? 'in' : '';
    if (said.dataset.word !== word) {
      said.dataset.word = word;
      said.className = `si-said ${sending ? 'sx-login-wait' : 'sx-signed'}`;
      said.innerHTML = sending ? '<i class="spin"></i>Signed in. Sending your request again…' : `${icon('check')}Signed in`;
    }
    if (sending) sendingWatch();
    else if (sendingFor.get(t.id)?.node === node) stopSending();
    if (sending || o.rerun) lock(true);
    if (!flow || keyed) return;
    $('[data-login-ctl]', node).hidden = !!o.stillIn && !going;
    $('[data-si="again"]:not([data-acc])', node).hidden = !offerAgain || sending;
    $('[data-si-again]', node).hidden = !offerAgain || sending;
    // A failed sign-in with nothing else to press: its panel takes the card, Try again where Sign in was.
    node.classList.toggle('si-bare', said.hidden && $$('.lm-acts button', node).every((b) => b.hidden) && l.state === 'failed');
  };
  if (flow) {
    wireLogins(node, () => [[scope, [acc ? `${agent}@${acc}` : agent]]], {
      arm: async () => {
        const r = await api(`/sessions/${s.id}/turns/${t.id}/sign-in`, { method: 'POST', body: {} });
        if (r.armed) armed.set(t.id, keyed ? keysSet(loginState(agent, scope, acc)) : 0);
      },
    });
    bus.on(
      'agent-login-state',
      (v) => {
        if (v.scope === scope && v.id === agent && accKey(v.account) === acc) paint();
      },
      { node },
    );
  }
  paint();
  // The keyboard comes up over the lower half of a phone: the box rises to the middle of what's left.
  node.addEventListener('focusin', (e) => {
    if (!e.target.matches('input') || !matchMedia('(pointer: coarse)').matches) return;
    setTimeout(() => {
      if (document.activeElement === e.target) e.target.closest('form')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 300);
  });
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-si]');
    if (!b || b.disabled) return;
    if (b.dataset.si === 'settings') {
      import('./settings.js').then((m) => m.openSettings({ pane: S.config.grid ? 'machines' : 'cloud', focus: 'sandbox' }));
      return;
    }
    lock(true);
    const account = b.dataset.acc;
    const to = others.find((x) => x.id === account);
    const undo = startOptimistic(s.id, t.prompt, t.attachments, { run: account ? { account } : undefined, live: to ? `Continuing on ${to.label}` : undefined });
    try {
      const r = await api(`/sessions/${s.id}/turns/${t.id}/rerun`, { method: 'POST', body: account ? { account } : {} });
      if (!r.rerun) {
        undo?.(); // it already went, or something newer did: the refetch shows which
        lock(false);
      }
      scheduleRefetch(s.id);
    } catch (err) {
      undo?.();
      lock(false);
      toastError(err);
    }
  });
  return node;
}

// /login in a task's reply box: its card, in view, signing in. false: the task has no card.
export function startSignIn(card) {
  const node = card && $('.b-signin', card);
  if (!node) return false;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const go = [...$$('button[data-login], button[data-si="settings"]', node)].find((b) => !b.hidden && !b.disabled);
  if (go) go.click();
  else $('input', node)?.focus();
  return true;
}
