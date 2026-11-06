// Signing in to a harness without a terminal: here (Settings → Agents) or on a machine, such as a
// cloud computer (Settings → Cloud). wisp runs the CLI's own login (server/agent-login.js), on that
// computer, and here it shows as a link to open, a code to enter there, and a box to paste a code
// back when the CLI asks for one.
//
// One sign-in state per place: '' is this computer, a machine id is that machine (its routes are
// /api/machines/<id>/agents/…, passed through to its wisp). This computer's sign-ins also arrive
// as 'agent-login' events; a machine's are polled while one is in progress.
//
// Claude and Codex can have several accounts: each signs in on its own (`?account=<id>`), so the
// state is kept per harness and account (`claude@k3f9`; the default account is the plain id).
//
// opencode has no sign-in page: its paid providers (Zen, Go) take an API key, pasted here and
// saved where opencode keeps it (/agents/opencode/keys). Its free models need none.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { S, setAgents } from '../core/state.js';
import { toast, toastError } from '../ui/toast.js';
import { copy } from '../blocks.js';

export const CAN = new Set(['claude', 'codex', 'cursor', 'grok', 'antigravity', 'gh', 'opencode']);
export const KEYED = new Set(['opencode']);
const NAMES = { claude: 'Claude', codex: 'ChatGPT', grok: 'xAI', antigravity: 'Google', gh: 'GitHub' };
const scopes = new Map(); // place -> { logins: Map(harness[@account] -> state), drafts: Map(harness[@account] -> pasted code) }
const of = (scope) => {
  if (!scopes.has(scope)) scopes.set(scope, { logins: new Map(), drafts: new Map() });
  return scopes.get(scope);
};
// The default account ('default' or none) is the harness's own login, as before accounts.
export const accKey = (acc) => (acc && acc !== 'default' ? acc : '');
const key = (id, acc) => (accKey(acc) ? `${id}@${accKey(acc)}` : id);
const path = (scope, id, rest = '', acc = '') => `${scope ? `/machines/${scope}` : ''}/agents/${id}/${rest || 'login'}${accKey(acc) ? `?account=${encodeURIComponent(accKey(acc))}` : ''}`;
const busy = (l) => l?.state === 'running' || l?.state === 'waiting';
const at = (scope, id, acc = '') => `data-scope="${esc(scope)}" data-agent="${esc(id)}" data-account="${esc(accKey(acc))}"`;
export const loginAt = at; // a button of your own that wireLogins answers (`data-login`)

// acc: one account's control, in its row of Settings → Agents. That row says "Signed out" itself
// and keeps Sign out in its ⋯ menu, so the control is only Sign in or Cancel.
// card: the one on a signed-out turn (features/sign-in-card.js), at the size of the buttons beside it.
export const loginControl = (id, scope = '', acc, card = false) => (CAN.has(id) ? `<span class="sx-login-ctl" ${at(scope, id, acc)} data-login-ctl${card ? '="card"' : ''}>${control(id, scope, acc, card)}</span>` : '');
export const loginState = (id, scope = '', acc = '') => of(scope).logins.get(key(id, acc)) || {};
// A failed run said it's signed out (turn: its id), so Sign in shows at first paint, before the
// look-up, and stays when the CLI can't say (signedIn: null). Once per turn: a repaint of the turn
// keeps what's known since, in the same state as the link, the code and the draft.
export function seedSignIn(scope, id, acc = '', { turn, open } = {}) {
  const { logins } = of(scope);
  const was = logins.get(key(id, acc)) || {};
  if (was.seeded === turn) return;
  const { signedIn, ...rest } = was; // eslint-disable-line no-unused-vars
  logins.set(key(id, acc), { ...rest, seeded: turn, ...(open && { open: true }) });
}

function control(id, scope, acc, card) {
  const l = of(scope).logins.get(key(id, acc)) || {};
  if (card) {
    if (busy(l)) return `<button class="ghost sm" data-login-cancel ${at(scope, id, acc)}>Cancel</button>`;
    // Failed: the panel has Try again, and two buttons would do the same thing.
    return l.signedIn === true || l.state === 'failed' ? '' : `<button class="primary sm" data-login ${at(scope, id, acc)}>${icon('lock')}Sign in</button>`;
  }
  if (acc !== undefined) {
    if (busy(l)) return `<button class="ghost xs" data-login-cancel ${at(scope, id, acc)}>Cancel</button>`;
    const out = l.signedIn === false || (l.signedIn !== true && (l.seeded || accountOut(scope, id, acc)));
    return out ? `<button class="primary xs" data-login ${at(scope, id, acc)}>Sign in</button>` : '';
  }
  if (KEYED.has(id)) {
    if (!l.providers) return '';
    const on = l.providers.filter((p) => p.set || l.env);
    return on.length
      ? `<span class="sx-signed" title="${esc(l.env ? `Signed in with ${l.env}` : 'API key saved')}">${icon('check')}${esc(on.map((p) => p.name).join(', '))}</span><button class="ghost xs" data-keys ${at(scope, id)}>Keys</button>`
      : `<button class="${l.open ? 'ghost' : 'primary'} sm" data-keys ${at(scope, id)}>${icon('lock')}Add key</button>`;
  }
  if (busy(l)) return `<button class="ghost sm" data-login-cancel ${at(scope, id)}>Cancel</button>`;
  if (l.signedIn === true) return `<span class="sx-signed" title="Signed in">${icon('check')}Signed in</span><button class="ghost xs" data-logout ${at(scope, id)}>Sign out</button>`;
  if (l.signedIn === false) return `<button class="primary sm" data-login ${at(scope, id)}>${icon('lock')}Sign in</button>`;
  return '';
}

// What comes after 'Starting the sign-in…' on the card, so the steps land in a box already that size.
const PASTES_BACK = new Set(['claude', 'antigravity']);
const SHOWS_CODE = new Set(['codex', 'grok', 'gh']);
const startingShape = (id) => {
  const step = '<span class="si-sk si-sk-line"></span>';
  const btn = '<span class="si-sk si-sk-btn"></span>';
  if (PASTES_BACK.has(id)) return `${btn}${step}<span class="si-sk si-sk-box"></span>`;
  if (SHOWS_CODE.has(id)) return `${btn}${step}<span class="si-sk si-sk-code"></span>${step}`;
  return btn;
};

// card: on a signed-out turn. It sits in the card rather than in a row, so it holds its shape
// through the states: placeholders while starting, a numbered step for the paste, and one primary.
export function loginPanel(id, scope = '', acc = '', card = false) {
  if (!CAN.has(id)) return '';
  const { logins, drafts } = of(scope);
  const l = logins.get(key(id, acc)) || {};
  const attrs = `${at(scope, id, acc)} data-login-panel${card ? ' data-card' : ''}`;
  if (KEYED.has(id)) return keysPanel(id, scope, l, attrs, card);
  if (!busy(l) && l.state !== 'failed') return `<div class="sx-login" ${attrs} hidden></div>`;
  if (l.state === 'failed') return `<div class="sx-login bad" ${attrs}><p>${esc(l.error || 'Sign-in didn’t finish.')}</p><button class="${card ? 'primary' : 'ghost'} sm" data-login ${at(scope, id, acc)}>Try again</button></div>`;
  // Claude shows a code on its page to paste back here; Codex and GitHub show one to type there.
  const paste = (id === 'claude' && !l.checking) || l.needsInput;
  const draft = drafts.get(key(id, acc)) || '';
  // On the card the step keeps its line through Checking the code, so the panel doesn't shrink.
  const pasteStep = card && l.url && !l.code && (paste || l.checking) ? '<p><b>2.</b> Paste the code it shows you:</p>' : '';
  return `<div class="sx-login" ${attrs}>
      ${l.url ? '' : `<p class="sx-login-wait si-start"><i class="spin"></i>Starting the sign-in…</p>${card ? startingShape(id) : ''}`}
      ${l.url ? `<p><b>1.</b> Open the sign-in page and sign in${NAMES[id] ? ` with your ${NAMES[id]} account` : ''}.</p><div class="sx-login-row"><a class="primary sm btn-link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')}Open the sign-in page</a></div>` : ''}
      ${l.code ? `<p><b>2.</b> Enter this code there:</p><div class="sx-login-code"><span class="mono">${esc(l.code)}</span><button class="icon-btn" data-login-copy="${esc(l.code)}" title="Copy the code">${icon('copy')}</button></div><p class="sx-login-wait"><i class="spin"></i>Waiting for you to finish there…</p>` : ''}
      ${pasteStep}
      ${l.url && l.checking && !l.needsInput ? '<p class="sx-login-wait si-check"><i class="spin"></i>Checking the code…</p>' : ''}
      ${l.url && paste && !l.code ? `<form class="sx-login-row" data-login-form ${at(scope, id, acc)}><input class="input mono" name="code" placeholder="${card ? 'Paste the code here' : 'Paste the code the page shows'}" aria-label="Code from the sign-in page" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(draft)}"><button class="primary sm" type="submit"${card && !draft.trim() ? ' disabled' : ''}>Continue</button></form>` : ''}
    </div>`;
}

// A key per provider: saved ones can be removed, the rest have a box to paste one into.
function keysPanel(id, scope, l, attrs, card) {
  // On the card it's open from the start: its shape until the look-up answers.
  if (card && l.open && !l.providers) return `<div class="sx-login" ${attrs}><span class="si-sk si-sk-para"></span><span class="si-sk si-sk-key"></span><span class="si-sk si-sk-key"></span></div>`;
  if (!l.open || !l.providers) return `<div class="sx-login" ${attrs} hidden></div>`;
  const site = String(l.url || '').replace(/^https?:\/\//, '');
  return `<div class="sx-login" ${attrs}>
      <p>Paste an API key from <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(site)}</a> to use your ${esc(l.providers.map((p) => p.name).join(' or '))} subscription. The free models need none.</p>
      ${l.env ? `<p class="sx-login-wait">${esc(l.env)} is set where wisp runs: every provider uses it.</p>` : ''}
      ${l.providers
        .map((p) =>
          p.set
            ? `<div class="sx-login-row sx-key"><b>${esc(p.name)}</b><span class="sx-signed">${icon('check')}Key saved</span><button class="ghost xs" data-key-remove="${esc(p.id)}" ${at(scope, id)}>Remove</button></div>`
            : `<form class="sx-login-row sx-key" data-key-form data-provider="${esc(p.id)}" ${at(scope, id)}><b>${esc(p.name)}</b><input class="input mono" type="password" name="key" placeholder="${esc(p.name)} API key" autocomplete="off" spellcheck="false"><button class="primary sm" type="submit">Save</button></form>`,
        )
        .join('')}
    </div>`;
}

// Signed in (or out): the harness lists say so at once, here or for that machine, without waiting
// for the server to look them up again (seconds on a busy cloud computer). The 'agents' event
// brings the checked list right after.
function markSignedIn(scope, id, on) {
  if (on) justIn.set(`${scope}|${id}`, Date.now() + JUST_IN_MS);
  else justIn.delete(`${scope}|${id}`);
  const list = scope ? S.machines.find((m) => m.id === scope)?.remote?.agents : S.agents;
  const a = list?.find((x) => x.id === id);
  if (!a || (on ? a.available : a.signedIn === false)) return;
  if (on) {
    a.available = true;
    delete a.signedIn;
    delete a.error;
  } else Object.assign(a, { available: false, signedIn: false });
  if (!scope) setAgents([...S.agents]);
  $('#launcher')?.placesChanged?.();
  bus.emit('agents');
}

// A list from before the server looked again (any 'machines' update while a cloud computer is
// still checking) would sign it out again, and the launcher would drop it for another harness
// right after "Use …" picked it: it stays signed in until the server agrees, or a while passes.
const JUST_IN_MS = 120_000;
const justIn = new Map(); // `${scope}|${id}` -> until when
export function keepSignIns(scope, list) {
  for (const a of list || []) {
    const k = `${scope}|${a.id}`;
    if (!justIn.has(k)) continue;
    if (a.available || Date.now() > justIn.get(k)) justIn.delete(k);
    else if (a.signedIn === false) {
      a.available = true;
      delete a.signedIn;
      delete a.error;
    }
  }
  return list;
}

// Whether the harness list says that account is signed out (before its own state is looked up).
const accountOut = (scope, id, acc) => {
  const list = scope ? S.machines.find((m) => m.id === scope)?.remote?.agents : S.agents;
  return list?.find((a) => a.id === id)?.accounts?.find((x) => accKey(x.id) === accKey(acc))?.state === 'signedOut';
};

// An account's label for toasts ('' for the default account: the harness's name says it).
const accountName = (id, acc) => (accKey(acc) && S.agents.find((a) => a.id === id)?.accounts?.find((x) => x.id === accKey(acc))?.label) || '';

// After an account change: the lists (Settings, the picker, the launcher) from the server again.
// The server also broadcasts 'agents'; this is for when that event comes late or not at all.
export async function refreshAgents() {
  setAgents(keepSignIns('', await api('/agents').catch(() => S.agents)));
  $('#launcher')?.placesChanged?.();
  bus.emit('agents');
}
const accountChanged = (scope) => !scope && refreshAgents();

// Whether a code is being pasted in this box: a repaint of the whole list would wipe it.
export const typingLogin = (box) => !!document.activeElement?.closest?.('[data-login-form], [data-key-form]') && box.contains(document.activeElement);

// Buttons, the paste box and updates for every place shown in box. places(): [[scope, [ids]]]; an
// id may be `harness@account` for one account's sign-in. arm(scope, id, acc): awaited before a login
// or a key goes to the server; if it throws, neither does.
export function wireLogins(box, places, { arm } = {}) {
  const repaint = (scope, id, acc = '') => {
    const sel = `[data-scope="${CSS.escape(scope)}"][data-agent="${CSS.escape(id)}"][data-account="${CSS.escape(accKey(acc))}"]`;
    const panel = $(`${sel}[data-login-panel]`, box);
    if (panel && ![...panel.querySelectorAll('form')].some((f) => f.contains(document.activeElement))) {
      // Only when it changed: the CLI's output moves on between steps, and a redraw restarts the spinner.
      const next = el(loginPanel(id, scope, acc, panel.hasAttribute('data-card')));
      if (!next.isEqualNode(panel)) panel.replaceWith(next);
    }
    const ctl = $(`${sel}[data-login-ctl]`, box);
    if (ctl) {
      const had = ctl.contains(document.activeElement);
      // An account's row has its own control (only Sign in / Cancel); the harness row the full one.
      ctl.innerHTML = control(id, scope, ctl.closest('[data-acc-row]') ? acc : undefined, ctl.dataset.loginCtl === 'card');
      if (had) $('button', ctl)?.focus({ preventScroll: true }); // Sign in became Cancel: the keys stay on it
    }
  };
  const set = (scope, id, v, acc = '') => {
    const { logins } = of(scope);
    const k = key(id, acc);
    const was = logins.get(k) || {};
    // A wisp from before `checking` keeps saying needsInput after a paste: the spinner stays.
    const old = was.checking && v.checking === undefined && { needsInput: false };
    logins.set(k, { ...was, ...v, ...old, ...(v.state === 'done' && v.signedIn === undefined && { signedIn: true }) });
    const name = accountName(id, acc);
    if (v.state === 'done' && was.state !== 'done') toast(`Signed in to <b>${esc(name || NAMES[id] || id)}</b>`);
    repaint(scope, id, acc);
    if (v.state === 'done' && was.state !== 'done') accKey(acc) ? accountChanged(scope) : markSignedIn(scope, id, true);
    bus.emit('agent-login-state', { scope, id, account: accKey(acc), ...logins.get(k) });
  };
  // A machine's sign-in: ask how it's going until it's over.
  const polls = new Map();
  const follow = (scope, id, acc = '') => {
    const k = `${scope}|${key(id, acc)}`;
    if (!scope || polls.has(k)) return;
    const tick = async () => {
      const v = await api(path(scope, id, '', acc)).catch(() => null);
      if (v) set(scope, id, v, acc);
      if (v && busy(v) && box.isConnected) polls.set(k, setTimeout(tick, 1500));
      else polls.delete(k);
    };
    polls.set(k, setTimeout(tick, 1200));
  };
  // A look-up that started before Sign in or Cancel may land after it, and would say 'idle' over a
  // login that's running: the click's own answer has the news.
  let moves = 0;
  const load = (scope, id, acc = '', seen = moves) =>
    api(path(scope, id, KEYED.has(id) ? 'keys' : '', acc))
      .then((v) => {
        if (seen !== moves) return;
        set(scope, id, v, acc);
        if (busy(v)) follow(scope, id, acc);
      })
      .catch(() => {});
  const loadAll = () => {
    for (const [scope, ids] of places())
      for (const k of ids) {
        const [id, acc = ''] = k.split('@');
        if (CAN.has(id)) load(scope, id, acc);
      }
  };
  loadAll();

  const target = (el) => ({ scope: el.dataset.scope || '', id: el.dataset.agent, acc: el.dataset.account || '' });
  box.addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-login-copy]');
    if (cp) {
      copy(cp.dataset.loginCopy);
      toast('Code copied');
      return;
    }
    const b = e.target.closest('[data-login], [data-login-cancel], [data-logout], [data-keys], [data-key-remove]');
    if (!b) return;
    const { scope, id, acc } = target(b);
    if (b.matches('[data-keys]')) {
      set(scope, id, { open: !of(scope).logins.get(id)?.open });
      if (of(scope).logins.get(id).open) $(`[data-login-panel][data-agent="${CSS.escape(id)}"][data-scope="${CSS.escape(scope)}"] input`, box)?.focus();
      return;
    }
    try {
      if (b.matches('[data-key-remove]')) {
        // At once: the key's gone here; back if the server refuses (the catch looks it up).
        const pid = b.dataset.keyRemove;
        const l = of(scope).logins.get(id);
        set(scope, id, { providers: l.providers.map((p) => (p.id === pid ? { ...p, set: false } : p)) });
        set(scope, id, await api(path(scope, id, `keys/${encodeURIComponent(pid)}`), { method: 'DELETE' }));
        toast(`Removed the opencode ${esc(l.providers.find((p) => p.id === pid)?.name || pid)} key`);
        return;
      }
      if (b.matches('[data-login]')) {
        // At once: the panel, filled in as the CLI talks.
        moves++;
        set(scope, id, { state: 'running', url: '', code: '', error: '', needsInput: false, checking: false }, acc);
        await arm?.(scope, id, acc);
        set(scope, id, await api(path(scope, id, '', acc), { method: 'POST', body: {} }), acc);
        follow(scope, id, acc);
      } else if (b.matches('[data-login-cancel]')) {
        // At once: 'Starting the sign-in…' and Cancel go. The view back (and the 'agent-login' event,
        // for a sign-in cancelled elsewhere) says 'cancelled' too.
        moves++;
        set(scope, id, { state: 'cancelled', url: '', code: '', needsInput: false, checking: false }, acc);
        set(scope, id, await api(path(scope, id, '', acc), { method: 'DELETE' }), acc);
      } else {
        // At once: signed out here; signed in again if the CLI refuses (the catch looks it up).
        of(scope).logins.set(id, { state: 'idle', signedIn: false });
        repaint(scope, id);
        markSignedIn(scope, id, false);
        bus.emit('agent-login-state', { scope, id, account: '', signedIn: false });
        try {
          await api(path(scope, id, 'logout'), { method: 'POST', body: {} });
        } catch (err) {
          markSignedIn(scope, id, true);
          bus.emit('agent-login-state', { scope, id, account: '', signedIn: true });
          throw err;
        }
        toast(`Signed out of <b>${esc(NAMES[id] || id)}</b>`);
      }
    } catch (err) {
      toastError(err);
      load(scope, id, acc);
    }
  });
  box.addEventListener('input', (e) => {
    const f = e.target.closest('[data-login-form]');
    if (!f) return;
    of(f.dataset.scope || '').drafts.set(key(f.dataset.agent, f.dataset.account), e.target.value);
    // On the card one button is the next step: Open the sign-in page, then this once there's a code.
    if (f.closest('[data-card]')) $('button[type="submit"]', f).disabled = !e.target.value.trim();
  });
  box.addEventListener('submit', async (e) => {
    const k = e.target.closest('[data-key-form]');
    if (k) {
      e.preventDefault();
      const { scope, id } = target(k);
      const pid = k.dataset.provider;
      const key = k.key.value.trim();
      if (!key) return;
      // At once: the box clears and the key shows as saved; back with the key in it if refused.
      k.key.value = '';
      document.activeElement?.blur();
      const l = of(scope).logins.get(id);
      const name = l.providers.find((p) => p.id === pid)?.name || pid;
      set(scope, id, { providers: l.providers.map((p) => (p.id === pid ? { ...p, set: true } : p)) });
      try {
        await arm?.(scope, id, '');
        set(scope, id, await api(path(scope, id, 'keys'), { method: 'POST', body: { provider: pid, key } }));
        toast(`Saved your opencode <b>${esc(name)}</b> key. Its models show up in a moment`);
      } catch (err) {
        set(scope, id, { providers: of(scope).logins.get(id).providers.map((p) => (p.id === pid ? { ...p, set: false } : p)) });
        const input = $(`[data-key-form][data-provider="${CSS.escape(pid)}"][data-scope="${CSS.escape(scope)}"] input`, box);
        if (input) input.value = key;
        toastError(err);
      }
      return;
    }
    const f = e.target.closest('[data-login-form]');
    if (!f) return;
    e.preventDefault();
    const { scope, id, acc } = target(f);
    const code = f.code.value.trim();
    if (!code) return;
    of(scope).drafts.delete(key(id, acc));
    // At once: the paste box gives way to a spinner while the CLI checks the code (seconds).
    document.activeElement?.blur();
    set(scope, id, { checking: true, needsInput: false }, acc);
    try {
      set(scope, id, await api(path(scope, id, 'login/input', acc), { method: 'POST', body: { code } }), acc);
      follow(scope, id, acc);
    } catch (err) {
      of(scope).drafts.set(key(id, acc), code);
      set(scope, id, { checking: false }, acc);
      toastError(err);
    }
  });
  bus.on('agent-login', (v) => set('', v.agent, v, v.account || ''), { node: box });
  // A sign-in that started elsewhere (Add another account): show and follow it here.
  return { reload: loadAll, start: (scope, id, acc, v) => (set(scope, id, v, acc), busy(v) && follow(scope, id, acc)) };
}
