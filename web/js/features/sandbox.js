// Settings → Cloud → Sandboxes (and Connect, in a cloud computer): what /sandbox <task> needs.
// A sandbox is a fresh box of its own on your wisp Grid, so nothing is signed in there; you sign
// in to Claude once here for all of them (server/services/sandbox.js runs `claude setup-token`),
// and the token goes to the grid, never kept on this computer.
//
// The sign-in looks like a harness's (agent-login.js): a link to open, then a box for the code
// that page shows. The 'sandbox' event says how it's going.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { icon } from '../core/dom.js';
import { cloudAccounts } from './places.js';
import { toast, toastError } from '../ui/toast.js';

const busy = (l) => l?.state === 'running' || l?.state === 'waiting';

export function mountSandboxes(box) {
  if (!box) return;
  let v = null; // GET /sandbox
  let draft = '';

  const panel = (l) => {
    if (l.state === 'failed') return `<div class="sx-login bad"><p>${esc(l.error || 'Sign-in didn’t finish.')}</p><button class="ghost sm" data-sb="login">Try again</button></div>`;
    if (!busy(l)) return '';
    return `<div class="sx-login">
        ${l.url ? '' : '<p class="sx-login-wait"><i class="spin"></i>Starting the sign-in…</p>'}
        ${l.url ? `<p><b>1.</b> Open the sign-in page and sign in with your Claude account.</p><div class="sx-login-row"><a class="primary sm btn-link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')}Open the sign-in page</a></div>` : ''}
        ${l.url && l.checking ? '<p class="sx-login-wait"><i class="spin"></i>Checking the code…</p>' : ''}
        ${l.url && !l.checking ? `<p>${l.retry ? '<span class="bad">That code didn’t work.</span> Paste the newest one the page shows:' : '<b>2.</b> Paste the code it shows:'}</p><form class="sx-login-row" data-sb-form><input class="input mono" name="code" placeholder="Paste the code the page shows" autocomplete="off" spellcheck="false" value="${esc(draft)}"><button class="primary sm" type="submit">Continue</button></form>` : ''}
      </div>`;
  };

  // Every sandbox on the grid and what it's for: its owner opens from here (it goes with it);
  // one nothing here owns can be deleted.
  const OWNER = { task: () => 'A /sandbox task', job: (o) => `${o.crew || 'A crew member'}’s job`, delegate: () => 'A subagent of a task', crew: (o) => `${o.name}’s own`, starting: () => 'Starting…' };
  const list = () => {
    const rows = v.list || [];
    if (!rows.length) return '';
    return `<div class="sbx-list"><div class="sbx-list-h">In use</div>${rows
      .map((x) => {
        const o = x.owner;
        const what = o ? OWNER[o.kind](o) : 'Nothing here owns it';
        const open = o && o.id && o.kind !== 'starting' ? `<button class="ghost xs" data-sb-open="${esc(o.kind === 'crew' ? `crew:${o.id}` : o.id)}">Open</button>` : '';
        const del = !o ? `<button class="ghost xs danger" data-sb-del="${esc(x.id)}">Delete</button>` : '';
        return `<div class="sbx-row" data-id="${esc(x.id)}"><span class="sbx-ico">${icon('box')}<i class="mc-dot st-${esc(x.state)}"></i></span><span class="sbx-name"><b>${esc(x.name)}</b><small>${esc(what)}</small></span>${open}${del}</div>`;
      })
      .join('')}</div>`;
  };

  // Env vars every sandbox starts with: names here, values only ever on the grid, sealed.
  const envHtml = () => {
    if (!v.logins) return '';
    const keys = v.env || [];
    return `<div class="sbx-env"><div class="sbx-env-h"><b>Env vars</b><small>Every sandbox starts with these: API keys, a database URL. Kept sealed on your grid.</small></div>
      ${keys.length ? `<div class="sbx-keys">${keys.map((k) => `<span class="sbx-key mono">${esc(k)}<button class="icon-btn" data-sb-unset="${esc(k)}" title="Remove ${esc(k)}" aria-label="Remove ${esc(k)}">${icon('x')}</button></span>`).join('')}</div>` : ''}
      <form class="sbx-env-add" data-sb-env><input class="input mono" name="key" placeholder="NAME" autocomplete="off" spellcheck="false" maxlength="64"><input class="input mono" name="value" type="password" placeholder="value" autocomplete="off"><button class="ghost sm" type="submit">${icon('plus')}Add</button></form></div>`;
  };

  const paint = () => {
    if (!box.isConnected) return;
    if (box.contains(document.activeElement) && document.activeElement.matches('input')) return; // a code being pasted
    // Not signed in to a grid: Cloud's own sign-in comes first, nothing to say here yet.
    if (!v?.grid) {
      box.innerHTML = '';
      return;
    }
    const l = v.login || { state: 'idle' };
    const on = !!v.logins?.claude;
    // One control per state: a failed sign-in's Try again is in its panel; no answer from the grid: Try again.
    const ctl = busy(l)
      ? '<button class="ghost sm" data-sb="cancel">Cancel</button>'
      : l.state === 'failed'
        ? ''
        : on
          ? `<span class="sx-signed" title="Every sandbox starts signed in to it">${icon('check')}Claude</span><button class="ghost xs" data-sb="logout">Sign out</button>`
          : v.logins
            ? `<button class="primary sm" data-sb="login">${icon('lock')}Sign in with Claude</button>`
            : '<button class="ghost sm" data-sb="reload">Try again</button>';
    const count = v.sandboxes ? `<span class="sx-state">${v.sandboxes} in use</span>` : '';
    box.innerHTML = `<div class="sx-group sbx-card">
        <div class="sx-row"><div class="sx-text"><b>Sandboxes ${count}</b><small>Start a task with <code>/sandbox</code> to run it in a fresh box on ${esc(v.grid.host)}. It’s deleted with the task.</small>${v.error ? `<small class="bad">${esc(v.error)}</small>` : ''}</div><div class="sx-ctl">${ctl}</div></div>
        ${panel(l)}
        ${envHtml()}
        ${list()}
      </div>
      ${v.logins && !on && !busy(l) ? '<p class="hint">A sandbox starts with nothing signed in. Sign in once and every sandbox uses your Claude subscription. The token is kept sealed on your grid, and it’s in each sandbox’s environment, where the agent’s code runs: revoke it at claude.ai if one goes wrong.</p>' : ''}`;
  };

  const load = () =>
    api('/sandbox')
      .then((x) => {
        v = x;
        paint();
      })
      .catch(() => {});

  box.addEventListener('input', (e) => {
    if (e.target.name === 'code' && e.target.closest('[data-sb-form]')) draft = e.target.value;
  });
  box.addEventListener('submit', async (e) => {
    const envForm = e.target.closest('[data-sb-env]');
    if (envForm) {
      e.preventDefault();
      const key = envForm.key.value.trim();
      const value = envForm.value.value;
      if (!key || !value) return;
      // At once, the form emptied; back with what was typed if the grid refuses.
      const was = v;
      v = { ...v, env: [...new Set([...(v.env || []), key])].sort() };
      envForm.reset();
      document.activeElement?.blur?.();
      paint();
      try {
        v = { ...v, ...(await api('/sandbox/env', { method: 'PUT', body: { key, value } })) };
        paint();
      } catch (err) {
        v = was;
        paint();
        const f = box.querySelector('[data-sb-env]');
        if (f) (f.key.value = key), (f.value.value = value);
        toastError(err);
      }
      return;
    }
    if (!e.target.closest('[data-sb-form]')) return;
    e.preventDefault();
    const code = draft.trim();
    if (!code) return;
    // At once: checking; the event brings what claude said.
    const was = v.login;
    const checking = { ...was, checking: true, retry: false };
    v = { ...v, login: checking };
    draft = '';
    document.activeElement?.blur?.();
    paint();
    try {
      const out = await api('/sandbox/login/input', { method: 'POST', body: { code } });
      // The 'sandbox' event may already have said what claude answered: never paint over it.
      if (v.login === checking) v = { ...v, login: out };
      paint();
    } catch (err) {
      v = { ...v, login: was };
      draft = code;
      paint();
      toastError(err);
    }
  });
  box.addEventListener('click', async (e) => {
    const opener = e.target.closest('[data-sb-open]')?.dataset.sbOpen;
    if (opener) {
      document.querySelector('.settings-modal .close')?.click();
      if (opener.startsWith('crew:')) return void import('./crew.js').then((m) => m.openCrew(opener.slice(5)));
      return void import('./feed.js').then((m) => m.expand(opener));
    }
    const unset = e.target.closest('[data-sb-unset]')?.dataset.sbUnset;
    if (unset) {
      const was = v;
      v = { ...v, env: (v.env || []).filter((k) => k !== unset) };
      paint();
      try {
        v = { ...v, ...(await api(`/sandbox/env/${encodeURIComponent(unset)}`, { method: 'DELETE' })) };
        paint();
      } catch (err) {
        v = was;
        paint();
        toastError(err);
      }
      return;
    }
    const gone = e.target.closest('[data-sb-del]')?.dataset.sbDel;
    if (gone) {
      // At once; back if the grid refuses.
      const was = v;
      v = { ...v, list: v.list.filter((x) => x.id !== gone), sandboxes: Math.max(0, (v.sandboxes || 1) - 1) };
      paint();
      try {
        v = { ...v, ...(await api(`/sandbox/${encodeURIComponent(gone)}`, { method: 'DELETE' })) };
        paint();
      } catch (err) {
        v = was;
        paint();
        toastError(err);
      }
      return;
    }
    const a = e.target.closest('[data-sb]')?.dataset.sb;
    if (a === 'reload') return void load();
    if (!a || !v) return;
    const was = v;
    try {
      if (a === 'login') {
        const starting = { state: 'running' };
        v = { ...v, login: starting };
        paint();
        const out = await api('/sandbox/login', { method: 'POST' });
        if (v.login === starting) v = { ...v, login: out }; // unless the event brought the link first
      } else if (a === 'cancel') {
        v = { ...v, login: { state: 'idle' } };
        paint();
        await api('/sandbox/login', { method: 'DELETE' });
      } else if (a === 'logout') {
        v = { ...v, logins: { ...v.logins, claude: false } };
        paint();
        const out = await api('/sandbox/logins/claude', { method: 'DELETE' });
        v = { ...v, logins: out.logins };
        toast('Sandboxes no longer start signed in to Claude.');
      }
      paint();
    } catch (err) {
      v = was;
      paint();
      toastError(err);
    }
  });
  bus.on(
    'sandbox',
    (x) => {
      const done = x.login?.state === 'done' && v?.login?.state !== 'done';
      v = { ...(v || {}), ...x };
      paint();
      if (done) toast('Signed in to Claude for your sandboxes. Start a task with <b>/sandbox</b>.');
    },
    { node: box },
  );
  // Signed in to a grid (or out of one): whether there's a grid to make sandboxes on changed.
  const accounts = () => cloudAccounts().length;
  let seen = accounts();
  bus.on(
    'machines',
    () => {
      if (accounts() !== seen) (seen = accounts()), load();
    },
    { node: box },
  );
  // Opened from /sandbox's "Sign in" (openSettings({ focus: 'sandbox' })): in view, and the sign-in started.
  box.focusSignIn = async () => {
    box.scrollIntoView({ block: 'nearest' });
    if (!v) await load();
    if (v?.logins && !v.logins.claude && !busy(v.login)) box.querySelector('[data-sb="login"]')?.click();
  };
  paint();
  load();
}
