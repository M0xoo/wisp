// Settings → Cloud: sign in to a wisp Grid (yours, your team's, or a hosted one) and your cloud
// computer joins Machines. It keeps working while this computer sleeps, and sleeps itself when
// nothing's going on; anything you send it wakes it.
//
// Signing in is the device flow: the server asks the grid for a code (POST /api/cloud/signin), you
// open the grid's page and allow it there, and the 'cloud' event says when it's done.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toast, toastError } from '../ui/toast.js';
import { copy } from '../blocks.js';
import { loadMachines } from './machines.js';
import { MACHINE_STATE } from './places.js';

let flow = null; // the sign-in in progress: { id, grid, state, userCode, verifyUrl, … }
const LAST = 'wisp.cloud.grid';

const gridMachines = () => S.machines.filter((m) => m.kind === 'grid');
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export function cloudSummary() {
  const list = gridMachines();
  if (!list.length) return 'Not signed in';
  const m = list[0];
  return `${m.user?.handle || m.handle} on ${hostOf(m.grid)} · ${(MACHINE_STATE[m.state] || m.state).replace('…', '')}`;
}

export function cloudPane(box) {
  const card = (m) => {
    const st = m.state || 'off';
    const busy = st === 'connecting' || st === 'reconnecting';
    const who = m.user?.email || m.user?.handle || m.handle;
    return `<div class="cl-card st-${esc(st)}" data-id="${esc(m.id)}">
        <span class="cl-ico">${icon('server')}<i class="mc-dot"></i></span>
        <div class="cl-text"><b>${esc(m.name)}</b><small>${esc(who)} · <span class="mono">${esc(hostOf(m.url))}</span></small></div>
        <span class="cl-state">${esc(MACHINE_STATE[st] || st)}</span>
        <div class="cl-acts">
          <a class="ghost sm btn-link" href="${esc(m.grid)}/go" target="_blank" rel="noopener" title="Open your cloud wisp in the browser">${icon('external')}Open</a>
          ${st === 'online' ? `<button class="ghost sm" data-a="sleep" title="Stop it now; anything you send it wakes it">Put to sleep</button>` : busy ? '' : `<button class="ghost sm" data-a="wake">${st === 'error' ? 'Try again' : 'Wake'}</button>`}
          <button class="ghost sm danger" data-a="signout" title="Forget this cloud computer here (its tasks stay there)">Sign out</button>
        </div>
        ${st === 'error' && m.error ? `<p class="cl-err">${esc(m.hint?.title || m.error)}${m.hint?.text ? ` · ${esc(m.hint.text)}` : ''}</p>` : ''}
      </div>`;
  };

  const signin = () => {
    if (flow?.state === 'waiting')
      return `<div class="cl-signin cl-code">
          <p><b>Allow this computer in the browser</b><small>Open ${esc(hostOf(flow.grid))}, sign in with Google, GitHub or what it offers, and allow the device showing this code.</small></p>
          <div class="cl-codebox"><span class="mono">${esc(flow.userCode)}</span><button class="icon-btn" data-a="copy" title="Copy the code">${icon('copy')}</button></div>
          <div class="cl-row"><button class="primary sm" data-a="open">${icon('external')}Open the sign-in page</button><button class="ghost sm" data-a="cancel">Cancel</button><span class="cl-wait"><i class="spin"></i>Waiting for you to allow it…</span></div>
        </div>`;
    const failed = flow && ['denied', 'expired', 'failed'].includes(flow.state) ? `<p class="cl-err">${esc(flow.error || 'That didn’t work.')}</p>` : '';
    return `<form class="cl-signin cl-form">
        <p><b>${gridMachines().length ? 'Sign in to another grid' : 'Sign in to a wisp Grid'}</b><small>Your own wisp on a server: tasks keep going when this computer sleeps, and you reach them from any browser or the phone app. A grid is yours (<code>wisp grid serve</code>), your team’s, or a hosted one.</small></p>
        <div class="cl-row"><input class="input mono" name="grid" placeholder="wisp.example.com" value="${esc(localStorage.getItem(LAST) || '')}" spellcheck="false" autocapitalize="off" autocomplete="url" required>
        <button class="primary sm" type="submit">${icon('lock')}Sign in</button></div>${failed}
      </form>`;
  };

  const paint = () => {
    if (!box.isConnected) return;
    const list = gridMachines();
    const typing = document.activeElement?.closest?.('.cl-form') && box.contains(document.activeElement);
    box.innerHTML = `${list.length ? `<div class="sx-group cl-list">${list.map(card).join('')}</div>` : ''}${typing ? '' : `<div class="sx-group">${signin()}</div>`}
      <p class="hint">A cloud computer shows up under Machines and in Run on, like any other computer. It sleeps when nothing’s going on (watching it from here doesn’t keep it up), and wakes when you send it something or a schedule is due.</p>`;
  };

  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.closest('.cl-form');
    if (!f) return;
    const raw = f.grid.value.trim();
    if (!raw) return;
    // At once: the code card, waiting on the grid's answer. Back to the form if it refuses.
    localStorage.setItem(LAST, raw);
    flow = { id: '', grid: raw, state: 'waiting', userCode: '…', verifyUrl: '' };
    f.blur?.();
    document.activeElement?.blur();
    paint();
    try {
      flow = await api('/cloud/signin', { method: 'POST', body: { url: raw } });
      paint();
    } catch (err) {
      flow = null;
      paint();
      toastError(err);
    }
  });

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const m = gridMachines().find((x) => x.id === b.closest('.cl-card')?.dataset.id);
    try {
      if (a === 'copy') {
        copy(flow.userCode);
        toast('Code copied');
      }
      // Opening the page is the user's click; nothing opens by itself.
      if (a === 'open' && flow?.verifyUrl) window.open(flow.verifyUrl, '_blank', 'noopener');
      if (a === 'cancel' && flow) {
        const id = flow.id;
        flow = null;
        paint();
        if (id) await api(`/cloud/signin/${id}`, { method: 'DELETE' });
      }
      if (a === 'wake' && m) await api(`/machines/${m.id}/connect`, { method: 'POST', body: {} });
      if (a === 'sleep' && m) {
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: {} });
        toast(`<b>${esc(m.name)}</b> is asleep. Sending it a task wakes it.`);
      }
      if (a === 'signout' && m) {
        if (!confirm(`Sign out of ${m.name} here? Its tasks stay on the grid; sign in again to see them.`)) return;
        await api(`/machines/${m.id}`, { method: 'DELETE' });
        await loadMachines();
      }
    } catch (err) {
      toastError(err);
    }
  });

  bus.on(
    'cloud',
    (f) => {
      if (!flow || f.id !== flow.id) return;
      flow = f;
      if (f.state === 'done') {
        toast(`Signed in as <b>${esc(f.user?.handle || '')}</b> on ${esc(hostOf(f.grid))}. Your cloud computer is waking up.`);
        flow = null;
        loadMachines();
      }
      paint();
    },
    { node: box },
  );
  bus.on('machines', paint, { node: box });
  paint();
}
