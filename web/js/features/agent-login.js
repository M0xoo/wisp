// Settings → Agents: sign in to a harness without a terminal. wisp runs the CLI's own login
// (server/agent-login.js); here it shows as a link to open, a code to enter there, and a box to
// paste a code back when the CLI asks for one. Useful wherever there's no terminal handy: a cloud
// computer (wisp Grid), a machine over SSH, the phone.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, icon } from '../core/dom.js';
import { toast, toastError } from '../ui/toast.js';
import { copy } from '../blocks.js';

const CAN = new Set(['claude', 'codex', 'cursor', 'grok', 'gh']);
const logins = new Map(); // harness id -> { state, url, code, needsInput, error, signedIn }
const drafts = new Map(); // harness id -> a code half pasted, kept across repaints

export const loginControl = (id) => (CAN.has(id) ? `<span class="sx-login-ctl" data-login-ctl="${id}">${control(id)}</span>` : '');

function control(id) {
  const l = logins.get(id) || {};
  const busy = l.state === 'running' || l.state === 'waiting';
  if (busy) return `<button class="ghost sm" data-login-cancel="${id}">Cancel</button>`;
  if (l.signedIn === true) return `<span class="sx-signed" title="Signed in">${icon('check')}Signed in</span><button class="ghost xs" data-logout="${id}">Sign out</button>`;
  if (l.signedIn === false) return `<button class="primary sm" data-login="${id}">${icon('lock')}Sign in</button>`;
  return '';
}

export function loginPanel(id) {
  if (!CAN.has(id)) return '';
  const l = logins.get(id) || {};
  const busy = l.state === 'running' || l.state === 'waiting';
  if (!busy && l.state !== 'failed') return `<div class="sx-login" data-login-panel="${id}" hidden></div>`;
  if (l.state === 'failed')
    return `<div class="sx-login bad" data-login-panel="${id}"><p>${esc(l.error || 'Sign-in didn’t finish.')}</p><button class="ghost sm" data-login="${id}">Try again</button></div>`;
  // Claude shows a code on its page to paste back here; Codex, Grok show one to type there.
  const paste = id === 'claude' || l.needsInput;
  return `<div class="sx-login" data-login-panel="${id}">
      ${l.url ? '' : '<p class="sx-login-wait"><i class="spin"></i>Starting the sign-in…</p>'}
      ${l.url ? `<p><b>1.</b> Open the sign-in page and sign in with your ${id === 'claude' ? 'Claude' : id === 'codex' ? 'ChatGPT' : ''} account.</p><div class="sx-login-row"><a class="primary sm btn-link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')}Open the sign-in page</a></div>` : ''}
      ${l.code ? `<p><b>2.</b> Enter this code there:</p><div class="sx-login-code"><span class="mono">${esc(l.code)}</span><button class="icon-btn" data-login-copy="${esc(l.code)}" title="Copy the code">${icon('copy')}</button></div><p class="sx-login-wait"><i class="spin"></i>Waiting for you to finish there…</p>` : ''}
      ${l.url && paste && !l.code ? `<form class="sx-login-row" data-login-form="${id}"><input class="input mono" name="code" placeholder="Paste the code the page shows" autocomplete="off" spellcheck="false" value="${esc(drafts.get(id) || '')}"><button class="primary sm" type="submit">Continue</button></form>` : ''}
    </div>`;
}

// One container for every harness's row: buttons, the paste box, live updates.
export function wireLogins(box, ids) {
  const repaint = (id) => {
    const row = $(`[data-login-panel="${id}"]`, box);
    if (!row) return;
    const form = $('form', row);
    if (form?.contains(document.activeElement)) return; // don't wipe a code being pasted
    row.outerHTML = loginPanel(id);
    const ctl = $(`[data-login-ctl="${id}"]`, box);
    if (ctl) ctl.innerHTML = control(id);
  };
  const load = (id) =>
    api(`/agents/${id}/login`)
      .then((v) => {
        logins.set(id, v);
        repaint(id);
      })
      .catch(() => {});
  for (const id of ids()) if (CAN.has(id)) load(id);

  box.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-login]');
    const stop = e.target.closest('[data-login-cancel]');
    const out = e.target.closest('[data-logout]');
    const cp = e.target.closest('[data-login-copy]');
    try {
      if (cp) {
        copy(cp.dataset.loginCopy);
        toast('Code copied');
      }
      if (go) {
        const id = go.dataset.login;
        // At once: the panel, filled in as the CLI talks.
        logins.set(id, { ...logins.get(id), state: 'running', url: '', code: '', error: '' });
        repaint(id);
        logins.set(id, { ...logins.get(id), ...(await api(`/agents/${id}/login`, { method: 'POST', body: {} })) });
        repaint(id);
      }
      if (stop) {
        const id = stop.dataset.loginCancel;
        logins.set(id, { ...logins.get(id), state: 'cancelled' });
        repaint(id);
        await api(`/agents/${id}/login`, { method: 'DELETE' });
      }
      if (out) {
        const id = out.dataset.logout;
        await api(`/agents/${id}/logout`, { method: 'POST', body: {} });
        logins.set(id, { state: 'idle', signedIn: false });
        repaint(id);
        toast('Signed out');
      }
    } catch (err) {
      toastError(err);
      for (const id of ids()) if (CAN.has(id)) load(id);
    }
  });
  box.addEventListener('input', (e) => {
    const f = e.target.closest('[data-login-form]');
    if (f) drafts.set(f.dataset.loginForm, e.target.value);
  });
  box.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-login-form]');
    if (!f) return;
    e.preventDefault();
    const id = f.dataset.loginForm;
    const code = f.code.value.trim();
    if (!code) return;
    drafts.delete(id);
    f.querySelector('button').disabled = true;
    try {
      await api(`/agents/${id}/login/input`, { method: 'POST', body: { code } });
      document.activeElement?.blur();
    } catch (err) {
      drafts.set(id, code);
      f.querySelector('button').disabled = false;
      toastError(err);
    }
  });
  bus.on(
    'agent-login',
    (v) => {
      const was = logins.get(v.agent) || {};
      logins.set(v.agent, { ...was, ...v, ...(v.state === 'done' && { signedIn: true }) });
      if (v.state === 'done') toast(`Signed in to <b>${esc(v.agent)}</b>`);
      repaint(v.agent);
    },
    { node: box },
  );
}
