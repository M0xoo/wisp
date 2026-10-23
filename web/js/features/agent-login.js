// Signing in to a harness without a terminal: here (Settings → Agents) or on a machine, such as a
// cloud computer (Settings → Cloud). wisp runs the CLI's own login (server/agent-login.js), on that
// computer, and here it shows as a link to open, a code to enter there, and a box to paste a code
// back when the CLI asks for one.
//
// One sign-in state per place: '' is this computer, a machine id is that machine (its routes are
// /api/machines/<id>/agents/…, passed through to its wisp). This computer's sign-ins also arrive
// as 'agent-login' events; a machine's are polled while one is in progress.
//
// opencode has no sign-in page: its paid providers (Zen, Go) take an API key, pasted here and
// saved where opencode keeps it (/agents/opencode/keys). Its free models need none.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, icon } from '../core/dom.js';
import { S, setAgents } from '../core/state.js';
import { toast, toastError } from '../ui/toast.js';
import { copy } from '../blocks.js';

export const CAN = new Set(['claude', 'codex', 'cursor', 'grok', 'antigravity', 'gh', 'opencode']);
const KEYED = new Set(['opencode']);
const NAMES = { claude: 'Claude', codex: 'ChatGPT', grok: 'xAI', antigravity: 'Google', gh: 'GitHub' };
const scopes = new Map(); // place -> { logins: Map(harness -> state), drafts: Map(harness -> pasted code) }
const of = (scope) => {
  if (!scopes.has(scope)) scopes.set(scope, { logins: new Map(), drafts: new Map() });
  return scopes.get(scope);
};
const path = (scope, id, rest = '') => `${scope ? `/machines/${scope}` : ''}/agents/${id}/${rest || 'login'}`;
const busy = (l) => l?.state === 'running' || l?.state === 'waiting';
const at = (scope, id) => `data-scope="${esc(scope)}" data-agent="${esc(id)}"`;

export const loginControl = (id, scope = '') => (CAN.has(id) ? `<span class="sx-login-ctl" ${at(scope, id)} data-login-ctl>${control(id, scope)}</span>` : '');

function control(id, scope) {
  const l = of(scope).logins.get(id) || {};
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

export function loginPanel(id, scope = '') {
  if (!CAN.has(id)) return '';
  const { logins, drafts } = of(scope);
  const l = logins.get(id) || {};
  const attrs = `${at(scope, id)} data-login-panel`;
  if (KEYED.has(id)) return keysPanel(id, scope, l, attrs);
  if (!busy(l) && l.state !== 'failed') return `<div class="sx-login" ${attrs} hidden></div>`;
  if (l.state === 'failed') return `<div class="sx-login bad" ${attrs}><p>${esc(l.error || 'Sign-in didn’t finish.')}</p><button class="ghost sm" data-login ${at(scope, id)}>Try again</button></div>`;
  // Claude shows a code on its page to paste back here; Codex and GitHub show one to type there.
  const paste = (id === 'claude' && !l.checking) || l.needsInput;
  return `<div class="sx-login" ${attrs}>
      ${l.url ? '' : '<p class="sx-login-wait"><i class="spin"></i>Starting the sign-in…</p>'}
      ${l.url ? `<p><b>1.</b> Open the sign-in page and sign in${NAMES[id] ? ` with your ${NAMES[id]} account` : ''}.</p><div class="sx-login-row"><a class="primary sm btn-link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')}Open the sign-in page</a></div>` : ''}
      ${l.code ? `<p><b>2.</b> Enter this code there:</p><div class="sx-login-code"><span class="mono">${esc(l.code)}</span><button class="icon-btn" data-login-copy="${esc(l.code)}" title="Copy the code">${icon('copy')}</button></div><p class="sx-login-wait"><i class="spin"></i>Waiting for you to finish there…</p>` : ''}
      ${l.url && l.checking && !l.needsInput ? '<p class="sx-login-wait"><i class="spin"></i>Checking the code…</p>' : ''}
      ${l.url && paste && !l.code ? `<form class="sx-login-row" data-login-form ${at(scope, id)}><input class="input mono" name="code" placeholder="Paste the code the page shows" autocomplete="off" spellcheck="false" value="${esc(drafts.get(id) || '')}"><button class="primary sm" type="submit">Continue</button></form>` : ''}
    </div>`;
}

// A key per provider: saved ones can be removed, the rest have a box to paste one into.
function keysPanel(id, scope, l, attrs) {
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

// Whether a code is being pasted in this box: a repaint of the whole list would wipe it.
export const typingLogin = (box) => !!document.activeElement?.closest?.('[data-login-form], [data-key-form]') && box.contains(document.activeElement);

// Buttons, the paste box and updates for every place shown in box. places(): [[scope, [ids]]].
export function wireLogins(box, places) {
  const repaint = (scope, id) => {
    const sel = `[data-scope="${CSS.escape(scope)}"][data-agent="${CSS.escape(id)}"]`;
    const panel = $(`${sel}[data-login-panel]`, box);
    if (panel && ![...panel.querySelectorAll('form')].some((f) => f.contains(document.activeElement))) panel.outerHTML = loginPanel(id, scope);
    const ctl = $(`${sel}[data-login-ctl]`, box);
    if (ctl) ctl.innerHTML = control(id, scope);
  };
  const set = (scope, id, v) => {
    const { logins } = of(scope);
    const was = logins.get(id) || {};
    // A wisp from before `checking` keeps saying needsInput after a paste: the spinner stays.
    const old = was.checking && v.checking === undefined && { needsInput: false };
    logins.set(id, { ...was, ...v, ...old, ...(v.state === 'done' && v.signedIn === undefined && { signedIn: true }) });
    if (v.state === 'done' && was.state !== 'done') toast(`Signed in to <b>${esc(NAMES[id] || id)}</b>`);
    repaint(scope, id);
    if (v.state === 'done' && was.state !== 'done') markSignedIn(scope, id, true);
    bus.emit('agent-login-state', { scope, id, ...logins.get(id) });
  };
  // A machine's sign-in: ask how it's going until it's over.
  const polls = new Map();
  const follow = (scope, id) => {
    if (!scope || polls.has(`${scope}|${id}`)) return;
    const tick = async () => {
      const v = await api(path(scope, id)).catch(() => null);
      if (v) set(scope, id, v);
      if (v && busy(v) && box.isConnected) polls.set(`${scope}|${id}`, setTimeout(tick, 1500));
      else polls.delete(`${scope}|${id}`);
    };
    polls.set(`${scope}|${id}`, setTimeout(tick, 1200));
  };
  const load = (scope, id) =>
    api(path(scope, id, KEYED.has(id) ? 'keys' : ''))
      .then((v) => {
        set(scope, id, v);
        if (busy(v)) follow(scope, id);
      })
      .catch(() => {});
  const loadAll = () => {
    for (const [scope, ids] of places()) for (const id of ids) if (CAN.has(id)) load(scope, id);
  };
  loadAll();

  const target = (el) => ({ scope: el.dataset.scope || '', id: el.dataset.agent });
  box.addEventListener('click', async (e) => {
    const cp = e.target.closest('[data-login-copy]');
    if (cp) {
      copy(cp.dataset.loginCopy);
      toast('Code copied');
      return;
    }
    const b = e.target.closest('[data-login], [data-login-cancel], [data-logout], [data-keys], [data-key-remove]');
    if (!b) return;
    const { scope, id } = target(b);
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
        set(scope, id, { state: 'running', url: '', code: '', error: '', needsInput: false, checking: false });
        set(scope, id, await api(path(scope, id), { method: 'POST', body: {} }));
        follow(scope, id);
      } else if (b.matches('[data-login-cancel]')) {
        set(scope, id, { state: 'cancelled' });
        await api(path(scope, id), { method: 'DELETE' });
      } else {
        // At once: signed out here; signed in again if the CLI refuses (the catch looks it up).
        of(scope).logins.set(id, { state: 'idle', signedIn: false });
        repaint(scope, id);
        markSignedIn(scope, id, false);
        try {
          await api(path(scope, id, 'logout'), { method: 'POST', body: {} });
        } catch (err) {
          markSignedIn(scope, id, true);
          throw err;
        }
        toast(`Signed out of <b>${esc(NAMES[id] || id)}</b>`);
      }
    } catch (err) {
      toastError(err);
      load(scope, id);
    }
  });
  box.addEventListener('input', (e) => {
    const f = e.target.closest('[data-login-form]');
    if (f) of(f.dataset.scope || '').drafts.set(f.dataset.agent, e.target.value);
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
    const { scope, id } = target(f);
    const code = f.code.value.trim();
    if (!code) return;
    of(scope).drafts.delete(id);
    // At once: the paste box gives way to a spinner while the CLI checks the code (seconds).
    document.activeElement?.blur();
    set(scope, id, { checking: true, needsInput: false });
    try {
      set(scope, id, await api(path(scope, id, 'login/input'), { method: 'POST', body: { code } }));
      follow(scope, id);
    } catch (err) {
      of(scope).drafts.set(id, code);
      set(scope, id, { checking: false });
      toastError(err);
    }
  });
  bus.on('agent-login', (v) => set('', v.agent, v), { node: box });
  return { reload: loadAll };
}
