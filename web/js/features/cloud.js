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
import { loadMachines, setMachines } from './machines.js';
import { MACHINE_STATE } from './places.js';
import { harnessLogo } from './runners.js';
import { CAN, loginControl, loginPanel, typingLogin, wireLogins } from './agent-login.js';
import { ask } from '../ui/confirm.js';

// The harnesses on a cloud computer wisp can sign in to (installed, signed in or not), and GitHub.
const signable = (m) => [...(m.remote?.agents || []).filter((a) => CAN.has(a.id) && (a.available || a.signedIn === false)).map((a) => a.id), 'gh'];
const agentName = (m, id) => (id === 'gh' ? 'GitHub' : m.remote?.agents?.find((a) => a.id === id)?.name || id);

let flow = null; // the sign-in in progress: { id, grid, state, userCode, verifyUrl, … }
const LAST = 'wisp.cloud.grid';
// The hosted grid; yours, or your team's, is one edit away.
export const DEFAULT_GRID = 'grid.trywisp.dev';

// Cloud computers only: your other computers on a grid (m.computer) are Machines' business.
const gridMachines = () => S.machines.filter((m) => m.kind === 'grid' && !m.computer);
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

// --- signing in: one flow at a time, shown wherever a sign-in box is (Settings → Cloud, Machines)

const setFlow = (f) => {
  flow = f;
  bus.emit('cloud-flow');
};

// The server says how the sign-in went (the 'cloud' event).
bus.on('cloud', (f) => {
  if (!flow || f.id !== flow.id) return;
  if (f.state !== 'done') return setFlow(f);
  toast(`Signed in as <b>${esc(f.user?.handle || '')}</b> on ${esc(hostOf(f.grid))}. Your cloud computer is waking up.`);
  // Not the empty form while its card is on the way: a spinner until Machines has it.
  setFlow({ ...f, state: 'joining' });
  loadMachines().finally(() => flow?.id === f.id && setFlow(null));
});

function signinHtml({ title, lede, button }) {
  if (flow?.state === 'waiting')
    return `<div class="cl-signin cl-code">
        <p><b>Allow this computer in the browser</b><small>Open ${esc(hostOf(flow.grid))}, sign in with Google, GitHub or what it offers, and allow the device showing this code.</small></p>
        <div class="cl-codebox"><span class="mono">${esc(flow.userCode)}</span><button class="icon-btn" type="button" data-cl="copy" title="Copy the code">${icon('copy')}</button></div>
        <div class="cl-row"><button class="primary sm" type="button" data-cl="open">${icon('external')}Open the sign-in page</button><button class="ghost sm" type="button" data-cl="cancel">Cancel</button><span class="cl-wait"><i class="spin"></i>Waiting for you to allow it…</span></div>
      </div>`;
  if (flow?.state === 'joining')
    return `<div class="cl-signin cl-code"><p><b>Signed in${flow.user?.handle ? ` as ${esc(flow.user.handle)}` : ''}</b><small>Adding your cloud computer from ${esc(hostOf(flow.grid))}.</small></p><span class="cl-wait"><i class="spin"></i>Adding it to Machines…</span></div>`;
  const failed = flow && ['denied', 'expired', 'failed'].includes(flow.state) ? `<p class="cl-err">${esc(flow.error || 'That didn’t work.')}</p>` : '';
  return `<form class="cl-signin cl-form">
      <p><b>${title || (gridMachines().length ? 'Sign in to another grid' : 'Sign in to a wisp Grid')}</b><small>${lede || 'Your own wisp on a server: tasks keep going when this computer sleeps, and you reach them from any browser or the phone app. A grid is yours (<code>wisp grid serve</code>), your team’s, or a hosted one.'}</small></p>
      <div class="cl-row"><input class="input mono" name="grid" placeholder="wisp.example.com" value="${esc(localStorage.getItem(LAST) || DEFAULT_GRID)}" spellcheck="false" autocapitalize="off" autocomplete="url" required>
      <button class="primary sm" type="submit">${icon('lock')}${button || 'Sign in'}</button></div>${failed}
    </form>`;
}

// A sign-in box in el: the grid's address, then the code to allow in the browser.
export function mountCloudSignin(el, text = {}) {
  const paint = () => {
    if (!el.isConnected) return;
    if (el.contains(document.activeElement) && document.activeElement.matches('input')) return; // keep what's being typed
    el.innerHTML = signinHtml(text);
  };
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopPropagation(); // the form is repainted at once; whatever holds this box shouldn't see it
    const f = e.target.closest('.cl-form');
    const raw = f?.grid.value.trim();
    if (!raw) return;
    // At once: the code card, waiting on the grid's answer. Back to the form if it refuses.
    localStorage.setItem(LAST, raw);
    document.activeElement?.blur();
    setFlow({ id: '', grid: raw, state: 'waiting', userCode: '…', verifyUrl: '' });
    try {
      setFlow(await api('/cloud/signin', { method: 'POST', body: { url: raw, addComputer: !!text.addComputer } }));
    } catch (err) {
      setFlow(null);
      toastError(err);
    }
  });
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-cl]')?.dataset.cl;
    if (a === 'copy' && flow) {
      copy(flow.userCode);
      toast('Code copied');
    }
    // Opening the page is the user's click; nothing opens by itself.
    if (a === 'open' && flow?.verifyUrl) window.open(flow.verifyUrl, '_blank', 'noopener');
    if (a === 'cancel' && flow) {
      const id = flow.id;
      setFlow(null);
      if (id) await api(`/cloud/signin/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  });
  bus.on('cloud-flow', paint, { node: el });
  paint();
}

// Settings → Connect, on a cloud computer itself: you reach it through its grid (the browser, wisp on
// a desktop, the phone app), never over SSH. grid: { url, address } from GET /config.
export function connectHtml(grid, row) {
  const g = esc(hostOf(grid.url));
  return `<div class="sx-group sx-connect">
      ${row('In a browser', `<a href="${esc(grid.address)}" target="_blank" rel="noopener" class="mono">${esc(hostOf(grid.address))}</a> · sign in with the account you use on ${g}.`, `<button class="ghost sm" id="copyAddress">${icon('copy')}Copy link</button>`)}
      ${row('wisp on your computer', `Settings → Cloud → Sign in, with <code>${g}</code>. This cloud computer joins Machines and Run on there, next to that computer’s own tasks.`, '')}
      ${row('wisp phone app', `On its first screen, <i>Sign in to wisp Cloud</i> with <code>${g}</code>. No SSH and no Tailscale.`, '')}
      ${row('Devices you let in', `Desktops and phones signed in to it. Sign one out on your ${g} account page.`, `<a class="ghost sm btn-link" href="${esc(grid.url)}/account" target="_blank" rel="noopener">${icon('external')}Account</a>`)}
    </div>
    <p class="hint">It sleeps when nothing’s going on, and wakes when you open it, send it a task, or a schedule is due. Your tasks, files and sign-ins stay on it.</p>`;
}

// Machines → this computer on your wisp Grid: your phone and your other computers, signed in to the
// same account, open it through the grid. Not signed in yet: the sign-in, which adds it as well.
let here = null; // GET /computer: { on, state, error, name, url, account }
const HERE_TEXT = {
  off: () => 'Only this computer and SSH reach it. Add it and your phone and other computers open it through the grid: no SSH, no open ports.',
  connecting: (h) => `Connecting to ${esc(hostOf(h.grid))}…`,
  retrying: (h) => `Reconnecting to ${esc(hostOf(h.grid))}…${h.error ? ` ${esc(h.error)}` : ''}`,
  online: (h) => `Online at <span class="mono">${esc(hostOf(h.url))}</span>. Open it from the phone app or wisp on another computer.`,
};

// Where this computer's local pages show through the grid, for the preview block (preview-frame.js).
// A box's own (grid.preview) wins: a cloud computer isn't a computer added to the grid.
bus.on('computer', (v) => {
  if (S.config && !S.config.grid?.preview) S.config.preview = v?.previewUrl || '';
});

export function mountGridHere(box) {
  let signin = false;
  const paint = () => {
    if (!box.isConnected) return;
    if (!here) return;
    if (!here.account) {
      // Mounted once: it keeps its own state (the code, the address being typed).
      if (signin) return;
      signin = true;
      box.innerHTML = '<div class="gh-signin"></div>';
      mountCloudSignin($s('.gh-signin'), {
        title: 'Reach this computer from anywhere',
        lede: 'Sign in to a wisp Grid with GitHub or Google, here and on your phone or other computers: they find each other through it. No SSH, no Tailscale, no open ports. You get a cloud computer there too, which works while this one sleeps.',
        button: 'Sign in and add it',
        addComputer: true,
      });
      return;
    }
    signin = false;
    const h = here;
    const st = h.on ? h.state : 'off';
    const text = (HERE_TEXT[st] || HERE_TEXT.off)(h);
    box.innerHTML = `<div class="gh-row st-${esc(st === 'retrying' ? 'reconnecting' : st)}">
        <span class="mc-icon">${icon('laptop')}<i class="mc-dot"></i></span>
        <div class="gh-text"><b>This computer <span class="mc-kind grid">${h.on ? 'On your grid' : 'Not on the grid'}</span></b><small>${text}</small>${!h.on && h.error ? `<small class="bad">${esc(h.error)}</small>` : ''}</div>
        <button class="${h.on ? 'ghost' : 'primary'} sm" type="button" data-gh="toggle">${h.on ? 'Remove from grid' : `${icon('cloud')}Add to grid`}</button>
      </div>
      ${
        h.on
          ? `<div class="gh-pv">
        <div class="gh-text"><b>Show local pages in previews</b><small>When an agent here shows a page it runs on localhost, you see it from your phone or any browser too, through the grid. Only you, signed in, can open it, but that reaches anything listening on this computer’s localhost.</small></div>
        <button class="switch" type="button" role="switch" data-gh="previews" aria-checked="${!!h.previews}" aria-label="Show local pages in previews"></button>
      </div>`
          : ''
      }
      <p class="hint">Signed in as <b>${esc(h.account.handle)}</b> on ${esc(hostOf(h.account.grid))}. Your cloud computer and other computers on it are listed below.</p>`;
  };
  const $s = (sel) => box.querySelector(sel);
  box.addEventListener('click', async (e) => {
    const gh = e.target.closest('[data-gh]')?.dataset.gh;
    if (gh === 'previews' && here) {
      // At once, rolled back if the server refuses.
      const was = here;
      here = { ...was, previews: !was.previews };
      paint();
      try {
        here = await api('/computer', { method: 'POST', body: { previews: here.previews } });
        paint();
      } catch (err) {
        here = was;
        paint();
        toastError(err);
      }
      return;
    }
    if (gh !== 'toggle' || !here) return;
    // At once; the server's answer (and the 'computer' event) puts it right.
    const was = here;
    const on = !was.on;
    here = { ...was, on, state: on ? 'connecting' : 'off', error: '' };
    paint();
    try {
      here = await api('/computer', { method: 'POST', body: { on } });
      paint();
      if (on) toast(`<b>${esc(here.name)}</b> is on your grid. Open it from your phone or another computer.`);
    } catch (err) {
      here = was;
      paint();
      toastError(err);
    }
  });
  const load = () =>
    api('/computer')
      .then((v) => {
        here = v;
        paint();
      })
      .catch(() => {});
  bus.on('computer', (v) => {
    here = v;
    paint();
  }, { node: box });
  // Signed in or out (the cloud computer comes or goes): whether there's an account changed.
  bus.on('machines', () => {
    if (!!here?.account !== gridMachines().length > 0) load();
  }, { node: box });
  paint();
  load();
}

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
        ${agents(m)}
      </div>`;
  };

  // Its agents, signed in to from here: the login runs on the cloud computer and stays there.
  const agents = (m) => {
    if (m.state === 'asleep') return `<p class="cl-ah cl-agents">Wake it to sign in to Claude Code, Codex or GitHub on it.</p>`;
    if (m.state !== 'online') return '';
    return `<div class="cl-agents"><p class="cl-ah">Agents on it <span>sign in once; the login stays on the cloud computer</span></p>${signable(m)
      .map((id) => `<div class="cl-agent"><span class="model-logo">${id === 'gh' ? icon('github') : harnessLogo(id)}</span><span class="cl-an">${esc(agentName(m, id))}</span>${loginControl(id, m.id)}</div>${loginPanel(id, m.id)}`)
      .join('')}</div>`;
  };

  const paint = () => {
    if (!box.isConnected || typingLogin(box)) return;
    const list = gridMachines();
    if (document.activeElement?.closest?.('.cl-form') && box.contains(document.activeElement)) return; // an address being typed
    box.innerHTML = `${list.length ? `<div class="sx-group cl-list">${list.map(card).join('')}</div>` : ''}<div class="sx-group cl-slot"></div>
      <p class="hint">A cloud computer shows up under Machines and in Run on, like any other computer. It sleeps when nothing’s going on (watching it from here doesn’t keep it up), and wakes when you send it something or a schedule is due.</p>`;
    mountCloudSignin(box.querySelector('.cl-slot'));
  };

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const m = gridMachines().find((x) => x.id === b.closest('.cl-card')?.dataset.id);
    if (!m) return;
    // At once: the card says what's happening; the server's list puts it right if it refuses.
    const show = (list) => setMachines(list, { quiet: true });
    try {
      if (a === 'wake') {
        show(S.machines.map((x) => (x.id === m.id ? { ...x, state: 'connecting', error: '' } : x)));
        await api(`/machines/${m.id}/connect`, { method: 'POST', body: {} });
      }
      if (a === 'sleep') {
        b.disabled = true;
        b.textContent = 'Going to sleep…';
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: {} });
        toast(`<b>${esc(m.name)}</b> is asleep. Sending it a task wakes it.`);
      }
      if (a === 'signout') {
        if (!(await ask(`Sign out of ${m.name} here?\n\nIts tasks stay on the grid; sign in again to see them.`, { ok: 'Sign out', anchor: b }))) return;
        setMachines(S.machines.filter((x) => x.id !== m.id));
        await api(`/machines/${m.id}`, { method: 'DELETE' });
        toast(`Signed out of <b>${esc(m.name)}</b>`);
      }
    } catch (err) {
      toastError(err);
    } finally {
      loadMachines();
    }
  });

  // Sign-ins on each cloud computer that's up; looked up again when one comes up.
  const online = () => gridMachines().filter((m) => m.state === 'online');
  let up = '';
  const logins = wireLogins(box, () => online().map((m) => [m.id, signable(m)]));
  bus.on(
    'machines',
    () => {
      paint();
      const now = online().map((m) => `${m.id}:${signable(m).join(',')}`).join('|');
      if (now !== up) logins.reload();
      up = now;
    },
    { node: box },
  );
  paint();
  up = online().map((m) => `${m.id}:${signable(m).join(',')}`).join('|');
}
