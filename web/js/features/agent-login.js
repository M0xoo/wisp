// Signing in to a harness without a terminal: here (Settings → Agents) or on a machine, such as a
// cloud computer (Settings → Cloud). wisp runs the CLI's own login (server/agent-login.js), on that
// computer, and here it shows as a link to open, a code to enter there, and a box to paste a code
// back when the CLI asks for one.
//
// One sign-in state per place: '' is this computer, a machine id is that machine (its routes are
// /api/machines/<id>/agents/…, passed through to its wisp). This computer's sign-ins also arrive
// as 'agent-login' events; a machine's are polled while one is in progress.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, icon } from '../core/dom.js';
import { toast, toastError } from '../ui/toast.js';
import { copy } from '../blocks.js';

export const CAN = new Set(['claude', 'codex', 'cursor', 'grok', 'antigravity', 'gh']);
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
  if (!busy(l) && l.state !== 'failed') return `<div class="sx-login" ${attrs} hidden></div>`;
  if (l.state === 'failed') return `<div class="sx-login bad" ${attrs}><p>${esc(l.error || 'Sign-in didn’t finish.')}</p><button class="ghost sm" data-login ${at(scope, id)}>Try again</button></div>`;
  // Claude shows a code on its page to paste back here; Codex and GitHub show one to type there.
  const paste = id === 'claude' || l.needsInput;
  return `<div class="sx-login" ${attrs}>
      ${l.url ? '' : '<p class="sx-login-wait"><i class="spin"></i>Starting the sign-in…</p>'}
      ${l.url ? `<p><b>1.</b> Open the sign-in page and sign in${NAMES[id] ? ` with your ${NAMES[id]} account` : ''}.</p><div class="sx-login-row"><a class="primary sm btn-link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')}Open the sign-in page</a></div>` : ''}
      ${l.code ? `<p><b>2.</b> Enter this code there:</p><div class="sx-login-code"><span class="mono">${esc(l.code)}</span><button class="icon-btn" data-login-copy="${esc(l.code)}" title="Copy the code">${icon('copy')}</button></div><p class="sx-login-wait"><i class="spin"></i>Waiting for you to finish there…</p>` : ''}
      ${l.url && paste && !l.code ? `<form class="sx-login-row" data-login-form ${at(scope, id)}><input class="input mono" name="code" placeholder="Paste the code the page shows" autocomplete="off" spellcheck="false" value="${esc(drafts.get(id) || '')}"><button class="primary sm" type="submit">Continue</button></form>` : ''}
    </div>`;
}

// Whether a code is being pasted in this box: a repaint of the whole list would wipe it.
export const typingLogin = (box) => !!document.activeElement?.closest?.('[data-login-form]') && box.contains(document.activeElement);

// Buttons, the paste box and updates for every place shown in box. places(): [[scope, [ids]]].
export function wireLogins(box, places) {
  const repaint = (scope, id) => {
    const sel = `[data-scope="${CSS.escape(scope)}"][data-agent="${CSS.escape(id)}"]`;
    const panel = $(`${sel}[data-login-panel]`, box);
    if (panel && !panel.querySelector('form')?.contains(document.activeElement)) panel.outerHTML = loginPanel(id, scope);
    const ctl = $(`${sel}[data-login-ctl]`, box);
    if (ctl) ctl.innerHTML = control(id, scope);
  };
  const set = (scope, id, v) => {
    const { logins } = of(scope);
    const was = logins.get(id) || {};
    logins.set(id, { ...was, ...v, ...(v.state === 'done' && { signedIn: true }) });
    if (v.state === 'done' && was.state !== 'done') toast(`Signed in to <b>${esc(NAMES[id] || id)}</b>`);
    repaint(scope, id);
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
    api(path(scope, id))
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
    const b = e.target.closest('[data-login], [data-login-cancel], [data-logout]');
    if (!b) return;
    const { scope, id } = target(b);
    try {
      if (b.matches('[data-login]')) {
        // At once: the panel, filled in as the CLI talks.
        set(scope, id, { state: 'running', url: '', code: '', error: '' });
        set(scope, id, await api(path(scope, id), { method: 'POST', body: {} }));
        follow(scope, id);
      } else if (b.matches('[data-login-cancel]')) {
        set(scope, id, { state: 'cancelled' });
        await api(path(scope, id), { method: 'DELETE' });
      } else {
        await api(path(scope, id, 'logout'), { method: 'POST', body: {} });
        of(scope).logins.set(id, { state: 'idle', signedIn: false });
        repaint(scope, id);
        toast('Signed out');
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
    const f = e.target.closest('[data-login-form]');
    if (!f) return;
    e.preventDefault();
    const { scope, id } = target(f);
    const code = f.code.value.trim();
    if (!code) return;
    of(scope).drafts.delete(id);
    f.querySelector('button').disabled = true;
    try {
      await api(path(scope, id, 'login/input'), { method: 'POST', body: { code } });
      document.activeElement?.blur();
      follow(scope, id);
    } catch (err) {
      of(scope).drafts.set(id, code);
      f.querySelector('button').disabled = false;
      toastError(err);
    }
  });
  bus.on('agent-login', (v) => set('', v.agent, v), { node: box });
  return { reload: loadAll };
}
