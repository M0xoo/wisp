// The app's own screen: your computers. Tap one and the app opens that computer's wisp: the
// WispSsh plugin runs wisp's bootstrap script there (shared/machines/bootstrap.js, the same file
// desktop Machines sends; it installs Node.js and starts wisp when they're missing), forwards
// 127.0.0.1:<port> on this phone to it, and this page hands over to wisp's page. In there,
// Computers in the top bar comes back here (web/js/features/machines.js openComputers).
//
// Computers live in localStorage, keys in the native plugin (their public halves are cached here too,
// so the list paints before the plugin answers). A password is typed for one connect:
// the plugin then adds the phone's key there ("@@wisp keyed") and the password is dropped.
//
// A cloud computer (kind: 'grid') is a wisp on a wisp Grid: no SSH. The app signs in once with a
// code you allow in the browser (the device flow), keeps the device token, and each time asks the
// grid for a one-time link that opens that wisp's page here (Grid.java lets its pages load).
//
// Progress is wisp's `@@wisp …` line protocol. The plugin adds a few lines of its own:
//   @@wisp fail ssh <message>   SSH itself failed (unreachable, auth, host key)
//   @@wisp open <version>       the tunnel answers: load wisp
//   @@wisp lost <message>       the connection dropped after it was up; the plugin retries

import { bootstrapScript, STEPS } from './shared/machines/bootstrap.js';
// registerPlugin lives in @capacitor/core, not in the bridge Android injects (scripts/shared.mjs copies it).
import { Capacitor, registerPlugin } from './shared/capacitor-core.js';

const native = Capacitor.isNativePlatform();
const Ssh = native ? registerPlugin('WispSsh') : (await import('./mock.js')).WispSsh;

const DEFAULT_COMMAND = 'npx -y wisp-agents@latest';
const SAVED = 'wisp.machines';
const KEYS = 'wisp.keys'; // public keys only: the last list the plugin gave
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
// The tunnel step is the phone's; Find harnesses is left to wisp's own page.
const PHONE_STEPS = STEPS.filter(([id]) => id !== 'agents');

let machines = load(SAVED);
let keys = load(KEYS);
// The one live connection: which machine, its steps, and how it ended (if it did).
const live = { id: '', state: 'idle', steps: [], failure: null, opened: false };
let opening = ''; // the computer whose wisp is loading: its button says so until the page changes
let openOnReady = ''; // set by a Connect tap here, so a background reconnect never yanks the page
const passwords = new Map(); // typed for one connection, never saved

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}
const save = () => localStorage.setItem(SAVED, JSON.stringify(machines));
const saveKeys = () => localStorage.setItem(KEYS, JSON.stringify(keys.map(({ id, name, source, type, publicKey, fingerprint }) => ({ id, name, source, type, publicKey, fingerprint }))));
const newId = () => Math.random().toString(36).slice(2, 10);
const machine = (id) => machines.find((m) => m.id === id);
const keyOf = (m) => (m?.kind === 'grid' ? null : keys.find((k) => k.id === m?.keyId) || keys[0]);
const isGrid = (m) => m?.kind === 'grid';
const nameOf = (m) => m.name || (isGrid(m) ? m.handle : parseTarget(m.target).host);
// The one the app opens when it starts: the last one used.
const main = () => [...machines].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
const TAILSCALE_GUIDE = 'https://trywisp.dev/guides/connect-machines-with-tailscale.html';

// `you@host` or `you@host:2222`.
function parseTarget(t) {
  const s = String(t || '').trim();
  const at = s.lastIndexOf('@');
  const hostPort = at > 0 ? s.slice(at + 1) : s;
  const m = /^(.*?)(?::(\d+))?$/.exec(hostPort);
  return { user: at > 0 ? s.slice(0, at) : '', host: m[1], port: m[2] ? Number(m[2]) : null };
}

function toast(text, { stay = false } = {}) {
  const t = $('#toast');
  // Above an open sheet (dialogs sit in the top layer), or on the page.
  (document.querySelector('dialog[open]') || document.body).append(t);
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (!stay) toast.timer = setTimeout(() => (t.hidden = true), 2400);
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`);
  } catch {
    toast('Couldn’t copy: long-press the text instead');
  }
}

const installCommand = (k) => `mkdir -p ~/.ssh && echo '${k.publicKey}' >> ~/.ssh/authorized_keys`;

// --- progress ----------------------------------------------------------------------------------

function resetSteps(id) {
  Object.assign(live, { id, state: 'connecting', failure: null, opened: false });
  live.steps = PHONE_STEPS.map(([sid, label], i) => ({ id: sid, label, status: i ? 'pending' : 'run', detail: '' }));
}

function setStep(id, status, detail = '') {
  const i = live.steps.findIndex((s) => s.id === id);
  if (i < 0) return;
  // A step that moves on means every step before it is done.
  live.steps.forEach((s, j) => {
    if (j < i) s.status = 'done';
  });
  Object.assign(live.steps[i], { status, detail: detail || live.steps[i].detail });
  if (status === 'done' && live.steps[i + 1]?.status === 'pending') live.steps[i + 1].status = 'run';
}

// Returns true when the line means "wisp is reachable".
function apply(line) {
  const m = /^@@wisp (\S+) ?(.*)$/.exec(line);
  if (!m) return false;
  const [, kind, rest] = m;
  if (kind === 'step') {
    const [, id, status, detail] = /^(\S+) (\S+) ?(.*)$/.exec(rest) || [];
    if (id === 'ssh' && status === 'run') resetSteps(live.id); // a (re)connect starts over
    setStep(id, status, detail);
  } else if (kind === 'fail') {
    const [, id, message] = /^(\S+) ?(.*)$/.exec(rest) || [];
    setStep(id, 'fail');
    Object.assign(live, { state: 'failed', failure: { id, message } });
  } else if (kind === 'ready') {
    setStep('wisp', 'done');
  } else if (kind === 'open') {
    setStep('tunnel', 'done');
    Object.assign(live, { state: 'ready', failure: null, opened: true });
    return true;
  } else if (kind === 'keyed') {
    passwords.delete(live.id);
    toast('This phone is allowed in now: no password next time');
  } else if (kind === 'lost') {
    Object.assign(live, { state: 'connecting', failure: { id: 'lost', message: rest || 'Connection lost.' } });
  }
  return false;
}

// In words for someone who has never used SSH, and what to tap next.
function hintFor(f) {
  const m = f.message;
  if (f.id === 'lost' && /wisp stopped/i.test(m)) return { text: 'The app starts it again over SSH and opens it here once it answers.' };
  if (f.id === 'lost') return { text: 'Reconnecting by itself. Your tasks keep running there.' };
  if (/host key/i.test(m)) return { text: 'That computer looks different from last time. If you reinstalled it, that’s expected: forget the saved one and connect again.', action: ['forget', 'Forget and reconnect'] };
  if (/auth/i.test(m)) return { title: 'This phone isn’t allowed in yet', text: 'Enter your password on that computer once. The app adds its own key there, so you won’t type it again.', action: ['password', 'Enter password'] };
  if (/resolve/i.test(m)) return { title: 'Computer not found', text: 'Check the address. Away from home? Install Tailscale on the computer and this phone, and use the name it shows.', link: [TAILSCALE_GUIDE, 'How to set up Tailscale'] };
  if (/unreachable|timed out/i.test(m)) return { title: 'No answer', text: 'Is the computer on and awake? Is this phone on the same Wi‑Fi, or are both on Tailscale?', link: [TAILSCALE_GUIDE, 'How to set up Tailscale'] };
  if (/refused/i.test(m)) return { title: 'SSH is off on that computer', text: 'On a Mac: System Settings → General → Sharing → Remote Login. On Linux: install openssh-server. Then Try again.' };
  if (/key is gone/i.test(m)) return { text: 'Edit the computer and pick a key, or enter its password.', action: ['password', 'Edit'] };
  if (f.id === 'node') return { text: 'wisp couldn’t install Node.js there by itself. Install the LTS version from nodejs.org on that computer, then Try again.', link: ['https://nodejs.org/en/download', 'Get Node.js'] };
  return {};
}

// --- paint -------------------------------------------------------------------------------------

function runHtml() {
  const f = live.failure;
  const steps = live.steps
    .map(
      (s) => `<li class="${s.status}"><span class="dot">${s.status === 'done' ? icon('check') : s.status === 'fail' ? icon('x') : ''}</span>
        <span class="label">${esc(s.label)}</span>${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ''}</li>`,
    )
    .join('');
  const h = f ? hintFor(f) : {};
  return `<div class="runbox">
      <ol class="steps">${steps}</ol>
      ${
        f
          ? `<div class="oops ${f.id === 'lost' ? 'lost' : ''}"><strong>${icon(f.id === 'lost' ? 'arrow' : 'warn')}<span>${esc(h.title || f.message)}</span></strong>${h.text ? `<span>${esc(h.text)}</span>` : ''}
        ${h.action || h.link ? `<div class="row">${h.action ? `<button class="primary sm" data-a="${h.action[0]}" type="button">${esc(h.action[1])}</button>` : ''}${h.link ? `<a class="ghost sm" href="${h.link[0]}">${esc(h.link[1])}</a>` : ''}</div>` : ''}
        ${h.title ? `<details class="why"><summary>Details</summary><code>${esc(f.message)}</code></details>` : ''}</div>`
          : ''
      }
      <div class="run-foot"><button class="ghost sm" data-a="disconnect" type="button">${live.state === 'failed' ? 'Dismiss' : 'Disconnect'}</button></div>
    </div>`;
}

// First run: what this is and the three steps. After that: your computers.
function paintIntro() {
  $('#intro').innerHTML = machines.length
    ? `<h1>Your computers</h1><p>Tap one to open its wisp. Your agents keep running there when the phone sleeps. <b>Computers</b> in wisp’s top bar brings you back here.</p>`
    : `<h1>wisp, on your phone</h1>
      <p>Start tasks and answer your agents from anywhere. They keep going when the phone sleeps.</p>
      <form class="card cloud-first" id="cloudFirst" autocomplete="off">
        <div class="cf-head"><span class="cf-ico">${icon('cloud')}</span><div><b>wisp Cloud</b><span>Fastest: nothing to set up</span></div></div>
        <p>Your own wisp on a server, signed in with GitHub or Google. Your agents keep working while every computer you own sleeps.</p>
        <div class="cf-row"><input id="cfUrl" value="${esc(localStorage.getItem('wisp.grid') || DEFAULT_GRID)}" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" aria-label="Grid"><button class="primary" type="submit">Sign in</button></div>
      </form>
      <p class="or"><span>Or use your own computer</span></p>
      <ol class="how">
        <li><span class="n">1</span><div><b>Get a computer ready</b><span>Turn on SSH: on a Mac, System Settings → General → Sharing → Remote Login; on Linux, install openssh-server. That’s all: the app installs Node.js and wisp there.</span></div></li>
        <li><span class="n">2</span><div><b>Add it here</b><span>Its address, and your password on it once.</span></div></li>
        <li><span class="n">3</span><div><b>Start working</b><span>wisp opens. Pick a coding agent there (opencode installs in one click) and give it a task. <b>Computers</b> in its top bar brings you back here.</span></div></li>
      </ol>
      <p class="tip">${icon('arrow')}<span>Away from home? Put the computer and this phone on <a href="${TAILSCALE_GUIDE}">Tailscale</a> (free).</span></p>`;
  $('#addMachine span').textContent = machines.length ? 'Add another computer' : 'Add your computer';
  // First run: wisp Cloud is the card at the top, so its button below would say it twice.
  $('#addCloud').hidden = !machines.length;
  const cf = $('#cloudFirst');
  if (cf)
    cf.onsubmit = (e) => {
      e.preventDefault();
      cloudSheet(null, { grid: $('#cfUrl').value.trim() });
    };
}

function paintMachines() {
  const box = $('#machines');
  paintIntro();
  if (!machines.length) {
    box.innerHTML = '';
    return;
  }
  const first = main();
  box.innerHTML = [first, ...machines.filter((m) => m !== first)]
    .map((m) => {
      const on = live.id === m.id && live.state !== 'idle';
      const state = on ? live.state : 'idle';
      if (isGrid(m)) {
        const go = opening === m.id ? `<button class="primary m-go" disabled type="button"><span class="spin"></span>Opening</button>` : `<button class="primary m-go" data-a="open" type="button">Open ${icon('arrow')}</button>`;
        return `<article class="card m cloud" data-id="${esc(m.id)}">
          <div class="m-row">
            <span class="m-ico">${icon('cloud')}<span class="st"></span></span>
            <button class="m-text" data-a="edit" type="button"><span class="m-name">${esc(nameOf(m))}</span><span class="m-sub">${esc(m.signedOut ? 'Signed out: tap to sign in again' : `${m.handle} · ${hostOf(m.grid)}`)}</span></button>
            ${go}
          </div>
        </article>`;
      }
      const go = opening === m.id ? `<button class="primary m-go" disabled type="button"><span class="spin"></span>Opening</button>` : state === 'ready' ? `<button class="primary m-go" data-a="open" type="button">Open ${icon('arrow')}</button>` : state === 'connecting' ? `<button class="ghost m-go" disabled type="button">Connecting…</button>` : `<button class="ghost m-go" data-a="connect" type="button">${state === 'failed' ? 'Try again' : 'Connect'}</button>`;
      return `<article class="card m ${state}" data-id="${esc(m.id)}">
          <div class="m-row">
            <span class="m-ico">${icon('server')}<span class="st"></span></span>
            <button class="m-text" data-a="edit" type="button"><span class="m-name">${esc(nameOf(m))}</span><span class="m-sub">${esc(m.target)}</span></button>
            ${go}
          </div>
          ${on ? runHtml() : ''}
        </article>`;
    })
    .join('');
}

function paintKeys() {
  saveKeys();
  $('#keys').innerHTML = keys
    .map((k) => {
      const used = machines.filter((m) => keyOf(m)?.id === k.id).length;
      return `<button class="card k" data-k="${esc(k.id)}" type="button">${icon('key')}
          <span class="k-text"><span class="k-name">${esc(k.name)}</span><span class="k-fp">${esc(k.type)} · ${esc(k.fingerprint)}</span></span>
          <span class="k-used">${used ? `${used} computer${used > 1 ? 's' : ''}` : k.source === 'imported' ? 'imported' : ''}</span></button>`;
    })
    .join('');
}

const paint = () => {
  paintMachines();
  paintKeys();
};

// Back here from wisp's page (Computers, Back): the page may come from the back/forward cache, with
// the Opening button still showing.
addEventListener('pageshow', () => {
  if (!opening) return;
  opening = '';
  paintMachines();
});

// --- actions -----------------------------------------------------------------------------------

const openWisp = (m) => {
  if (!native) return toast(`Opens wisp at 127.0.0.1:${m.port || 4477}`); // the preview has no tunnel
  // The tap shows at once. Once its wisp has opened here, its page and the tasks seen last are
  // cached on the phone (web/sw.js, web/js/features/cache.js): from then on it opens at once.
  opening = m.id;
  paintMachines();
  if (!m.seen && live.id === m.id && live.state === 'ready') {
    m.seen = true;
    save();
  }
  // ?m=: wisp's page names "here" after this computer (web/js/core/state.js HUB).
  location.href = `http://127.0.0.1:${m.port || 4477}/?m=${encodeURIComponent(nameOf(m))}`;
};

async function connect(m) {
  if (isGrid(m)) return openGrid(m);
  const { user, host, port } = parseTarget(m.target);
  if (!user || !host) return toast('Add your user name: you@its-name');
  const key = keyOf(m);
  if (!key) return toast('Couldn’t read this phone’s keys. Restart the app.');
  m.lastUsed = Date.now();
  save();
  resetSteps(m.id);
  openOnReady = m.id;
  paint(); // at once; the plugin's lines follow
  const script = bootstrapScript({ port: m.port || 4477, command: m.command || DEFAULT_COMMAND, apiVersion: 'any', installNode: true });
  try {
    await Ssh.connect({ machineId: m.id, name: nameOf(m), host, user, sshPort: port || m.sshPort || 22, port: m.port || 4477, keyId: key.id, password: passwords.get(m.id) || null, script });
  } catch (err) {
    setStep('ssh', 'fail');
    Object.assign(live, { state: 'failed', failure: { id: 'ssh', message: err.message || String(err) } });
    paint();
    return;
  }
  // Opened here before: go straight to its cached page, which catches up when the tunnel is up and
  // says so if it can't connect (web/js/features/live.js). Not with a password typed just now:
  // whether it worked shows here.
  if (m.seen && !passwords.has(m.id) && openOnReady === m.id) {
    openOnReady = '';
    openWisp(m);
  }
}

async function disconnect() {
  Object.assign(live, { id: '', state: 'idle', failure: null });
  openOnReady = '';
  paint();
  await Ssh.disconnect();
}

// --- wisp Cloud ----------------------------------------------------------------------------------

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const LOCAL = /(^|\.)localhost$/i;
const DEFAULT_GRID = 'grid.trywisp.dev'; // the hosted grid; yours is one edit away
// "wisp.example.com" → https://wisp.example.com (http only for a grid on this phone's loopback).
function gridUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('The address of your wisp Grid, like wisp.example.com.');
  if (!/^https?:\/\//i.test(s)) s = `${LOCAL.test(s.split(/[:/]/)[0]) ? 'http' : 'https'}://${s}`;
  const u = new URL(s);
  if (u.protocol === 'http:' && !LOCAL.test(u.hostname)) throw new Error('Use https:// for a grid: your sign-in goes over it.');
  return u.origin;
}
async function gridPost(url, body, token) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// Into a cloud computer's wisp: a fresh one-time link each time (the grid starts it if it sleeps).
async function openGrid(m) {
  opening = m.id;
  m.lastUsed = Date.now();
  save();
  paintMachines();
  try {
    if (live.state !== 'idle') await disconnect(); // one computer at a time
    await Ssh.allowGrid({ domain: new URL(m.grid).hostname });
    const r = await gridPost(`${m.grid}/api/device/link`, { path: `/?m=${encodeURIComponent(nameOf(m))}` }, m.token);
    if (r.status === 401) {
      m.signedOut = true;
      save();
      throw new Error('This phone was signed out of it. Tap it to sign in again.');
    }
    if (r.status >= 400 || !r.body.url) throw new Error(r.body.error || `The grid said ${r.status}.`);
    if (!native) return toast(`Opens ${r.body.url.split('/_grid')[0]}`);
    location.href = r.body.url;
  } catch (err) {
    opening = '';
    paintMachines();
    toast(err.message === 'Failed to fetch' ? `Can’t reach ${hostOf(m.grid)}` : err.message);
  }
}

// Sign in to a grid: a code to allow in the browser, then this phone is a device there.
// start.grid: sign in to that grid right away (the first screen's card), straight to the code.
function cloudSheet(m = null, start = null) {
  const d = $('#gSheet');
  const body = $('#gBody');
  let flow = null; // { grid, code, url, interval, timer }
  const stop = () => clearTimeout(flow?.timer);
  const ask = (error = '') => {
    stop();
    $('#gTitle').textContent = m ? nameOf(m) : 'wisp Cloud';
    body.innerHTML = `${m ? `<p class="muted">${esc(m.handle)} on <b>${esc(hostOf(m.grid))}</b>${m.signedOut ? ' · signed out' : ''}</p>` : '<p class="muted">Your own wisp on a server: agents keep working when your computers sleep. Sign in to a wisp Grid (yours, your team’s, or a hosted one) with Google, GitHub or what it offers.</p>'}
      <label class="field"><span>Grid</span><input id="gUrl" placeholder="wisp.example.com" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" value="${esc(m ? m.grid.replace(/^https:\/\//, '') : localStorage.getItem('wisp.grid') || DEFAULT_GRID)}" required></label>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <div class="sheet-actions">${m ? '<button class="ghost danger" data-g="signout" type="button">Sign out</button>' : ''}<span class="grow"></span><button class="primary" type="submit">${m ? 'Sign in again' : 'Sign in'}</button></div>`;
  };
  const waiting = () => {
    body.innerHTML = `<p><b>Allow this phone</b></p><p class="muted">Open ${esc(hostOf(flow.grid))} in your browser, sign in, and allow the device showing this code.</p>
      <div class="code">${esc(flow.code)}</div>
      <div class="row"><button class="primary" data-g="open" type="button">Open the sign-in page</button><button class="ghost" data-g="copy" type="button">Copy code</button></div>
      <p class="wait"><span class="spin"></span>Waiting for you to allow it…</p>`;
  };
  const poll = async () => {
    const r = await gridPost(`${flow.grid}/api/device/token`, { device_code: flow.deviceCode }).catch(() => ({ body: { error: 'authorization_pending' } }));
    const e = r.body.error;
    if (e === 'authorization_pending' || e === 'slow_down') {
      if (e === 'slow_down') flow.interval += 5;
      flow.timer = setTimeout(poll, flow.interval * 1000);
      return;
    }
    if (e) return ask(e === 'access_denied' ? 'Sign-in was declined in the browser.' : e === 'expired_token' ? 'The code expired. Sign in again.' : r.body.error_description || e);
    const { token, user, instance } = r.body;
    const c = m || { id: newId(), kind: 'grid' };
    Object.assign(c, { kind: 'grid', grid: flow.grid, url: instance.url, handle: user.handle, name: m?.name || instance.name || 'wisp Cloud', token, signedOut: false });
    if (!m) machines.push(c);
    save();
    paint();
    dismiss(d);
    toast(`Signed in as ${user.handle}`);
    openGrid(c);
  };
  d.onclose = stop;
  $('#gForm').onsubmit = async (e) => {
    e.preventDefault();
    let grid;
    try {
      grid = gridUrl($('#gUrl').value);
    } catch (err) {
      return ask(err.message);
    }
    localStorage.setItem('wisp.grid', grid.replace(/^https:\/\//, ''));
    // At once: the code card, filled in when the grid answers.
    flow = { grid, code: '…', interval: 5 };
    waiting();
    try {
      const r = await gridPost(`${grid}/api/device/code`, { name: 'Phone (wisp app)' });
      if (r.status >= 400 || !r.body.device_code) throw new Error(r.body.error || `${hostOf(grid)} isn’t a wisp Grid.`);
      Object.assign(flow, { code: r.body.user_code, url: r.body.verification_uri_complete || r.body.verification_uri, deviceCode: r.body.device_code, interval: Number(r.body.interval) || 5 });
      waiting();
      flow.timer = setTimeout(poll, flow.interval * 1000);
    } catch (err) {
      ask(err.message === 'Failed to fetch' ? `Can’t reach ${hostOf(grid)}` : err.message);
    }
  };
  body.onclick = async (e) => {
    const a = e.target.closest('[data-g]')?.dataset.g;
    if (a === 'open' && flow?.url) await Ssh.openExternal({ url: flow.url }).catch((err) => toast(err.message));
    if (a === 'copy' && flow) copy(flow.code, 'code');
    if (a === 'signout' && m) {
      gridPost(`${m.grid}/api/device/revoke`, {}, m.token).catch(() => {});
      machines = machines.filter((x) => x.id !== m.id);
      save();
      paint();
      dismiss(d);
      toast(`Signed out of ${nameOf(m)}`);
    }
  };
  ask();
  present(d);
  if (start?.grid) {
    $('#gUrl').value = start.grid;
    $('#gForm').requestSubmit();
  } else setTimeout(() => !m && $('#gUrl')?.focus(), 80);
}

// --- sheets ------------------------------------------------------------------------------------
// A sheet pushes a history entry, so Android's back button closes it instead of leaving the app.
// Like a native one, it slides away: on Back, a tap outside it, or a drag down from its header.

function present(dialog) {
  dialog.classList.remove('closing');
  dialog.style.transform = '';
  dialog.showModal();
  history.pushState({ sheet: dialog.id }, '');
  const close = () => {
    dismiss(dialog);
  };
  dialog.onclose = () => {
    if (history.state?.sheet === dialog.id) history.back();
  };
  dialog.oncancel = (e) => {
    e.preventDefault();
    dismiss(dialog);
  };
  dialog.onclick = (e) => {
    // The backdrop is the dialog itself, outside its box.
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) dismiss(dialog);
  };
  dialog.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => {
      close();
    };
  });
  dragToClose(dialog);
  return close;
}

function dismiss(dialog) {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  dialog.classList.add('closing');
  setTimeout(() => {
    dialog.classList.remove('closing');
    dialog.style.transform = '';
    dialog.close();
  }, 180);
}

function dragToClose(dialog) {
  const head = dialog.querySelector('header');
  let y0 = null;
  let dy = 0;
  head.onpointerdown = (e) => {
    if (e.target.closest('button')) return;
    y0 = e.clientY;
    dy = 0;
    head.setPointerCapture(e.pointerId);
    dialog.classList.add('dragging');
  };
  head.onpointermove = (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    dialog.style.transform = `translateY(${dy}px)`;
  };
  head.onpointerup = head.onpointercancel = () => {
    if (y0 === null) return;
    y0 = null;
    dialog.classList.remove('dragging');
    if (dy > 70) dismiss(dialog);
    else dialog.style.transform = '';
  };
}
window.addEventListener('popstate', () => {
  document.querySelectorAll('dialog[open]').forEach((d) => dismiss(d));
});

function editMachine(m, { focusPassword = false } = {}) {
  const d = $('#mSheet');
  const isNew = !m;
  m ||= { id: newId(), target: '', name: '', keyId: keys[0]?.id, sshPort: null, port: null, command: '' };
  $('#mTitle').textContent = isNew ? 'Add a computer' : nameOf(m);
  // A computer that let the phone in before only needs the password if it asks again.
  $('#mPwLabel').textContent = isNew || focusPassword ? 'Your password on that computer' : 'Password (only if it asks again)';
  $('#mPwHint').hidden = !(isNew || focusPassword);
  $('#mTarget').value = m.target;
  $('#mName').value = m.name || '';
  $('#mSshPort').value = m.sshPort || '';
  $('#mPort').value = m.port || '';
  $('#mPassword').value = passwords.get(m.id) || '';
  $('#mCommand').value = m.command || '';
  $('#mAdv').open = !!(m.sshPort || m.port || m.command);
  $('#mKeyBox').open = !!m.keyId && m.keyId !== keys[0]?.id;
  $('#mDelete').hidden = isNew;
  const paintKey = () => {
    if ($('#mKey').value === '+new') return;
    const k = keys.find((x) => x.id === $('#mKey').value);
    $('#mCmd').textContent = k ? installCommand(k) : '';
  };
  const fillKeys = (sel) => {
    $('#mKey').innerHTML = keys.map((k) => `<option value="${esc(k.id)}">${esc(k.name)} · ${esc(k.type)}</option>`).join('') + '<option value="+new">New key…</option>';
    $('#mKey').value = sel || keys[0]?.id;
    paintKey();
  };
  fillKeys(keyOf(m)?.id);
  $('#mKey').onchange = async () => {
    if ($('#mKey').value !== '+new') return paintKey();
    const k = await newKey(`Key for ${parseTarget($('#mTarget').value).host || 'a computer'}`);
    fillKeys(k?.id || keys[0]?.id);
  };
  $('#mCopy').onclick = () => {
    copy($('#mCmd').textContent, 'command');
  };
  const close = present(d);
  setTimeout(() => (focusPassword ? $('#mPassword') : isNew ? $('#mTarget') : null)?.focus(), 80);
  const commit = () => {
    const target = $('#mTarget').value.trim();
    if (!parseTarget(target).user || !parseTarget(target).host) {
      toast('Add your user name: you@its-name');
      $('#mTarget').focus();
      return null;
    }
    Object.assign(m, { target, name: $('#mName').value.trim(), keyId: $('#mKey').value, sshPort: Number($('#mSshPort').value) || null, port: Number($('#mPort').value) || null, command: $('#mCommand').value.trim() });
    if ($('#mPassword').value) passwords.set(m.id, $('#mPassword').value);
    else passwords.delete(m.id);
    if (isNew) machines.push(m);
    save();
    paint();
    close();
    return m;
  };
  $('#mSave').onclick = () => {
    commit();
  };
  $('#mForm').onsubmit = (e) => {
    e.preventDefault();
    const saved = commit();
    if (saved) connect(saved);
  };
  $('#mDelete').onclick = () => {
    if (live.id === m.id) disconnect();
    machines = machines.filter((x) => x.id !== m.id);
    save();
    paint();
    close();
    toast(`Removed ${nameOf(m)}`);
  };
}

function showKey(k) {
  $('#kTitle').textContent = k.name;
  $('#kMeta').textContent = `${k.type} · ${k.fingerprint}${k.source === 'imported' ? ' · imported' : ''}`;
  $('#kCmd').textContent = installCommand(k);
  const close = present($('#kSheet'));
  $('#kCopyCmd').onclick = () => {
    copy(installCommand(k), 'command');
  };
  $('#kCopyKey').onclick = () => {
    copy(k.publicKey, 'public key');
  };
  const users = machines.filter((m) => keyOf(m)?.id === k.id);
  $('#kDelete').hidden = keys.length < 2; // there is always one key to pick
  $('#kDelete').onclick = async () => {
    // Optimistic: gone from the list at once, back if the plugin refuses.
    const before = keys;
    keys = keys.filter((x) => x.id !== k.id);
    for (const m of users) m.keyId = keys[0].id;
    save();
    paint();
    close();
    try {
      await Ssh.deleteKey({ id: k.id });
      toast(users.length ? `Deleted ${k.name}; ${users.length} computer${users.length > 1 ? 's' : ''} now use ${keys[0].name}` : `Deleted ${k.name}`);
    } catch (err) {
      keys = before;
      paint();
      toast(`Couldn’t delete: ${err.message}`);
    }
  };
}

async function newKey(name = 'New key') {
  try {
    const k = await Ssh.createKey({ name });
    keys.push(k);
    paint();
    toast(`Made ${k.name}`);
    return k;
  } catch (err) {
    toast(err.message);
    return null;
  }
}

function importKey() {
  $('#iForm').reset();
  const close = present($('#iSheet'));
  $('#iForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#iGo').disabled = true;
    try {
      const k = await Ssh.importKey({ name: $('#iName').value.trim() || 'Imported key', privateKey: $('#iKey').value.trim() + '\n', passphrase: $('#iPass').value || null });
      keys.push(k);
      paint();
      close();
      toast(`Imported ${k.name}`);
    } catch (err) {
      toast(err.message);
    } finally {
      $('#iGo').disabled = false;
    }
  };
}

// --- boot --------------------------------------------------------------------------------------

async function boot() {
  wire(); // first, so the buttons work even if the plugin below fails; painted from the caches
  // Both at once: the plugin answers each on its own thread.
  const [listed, st] = await Promise.all([
    Ssh.listKeys().catch((err) => {
      toast(`Couldn’t read this phone’s keys: ${err.message}`, { stay: true });
      return null;
    }),
    Ssh.status(),
  ]);
  if (listed) keys = listed.keys;

  Ssh.addListener('line', ({ text }) => {
    const opens = apply(text);
    paint();
    if (opens && openOnReady === live.id) {
      openOnReady = '';
      const m = machine(live.id);
      if (m) openWisp(m);
    }
  });

  // The plugin keeps the tunnel while this page is left for wisp's: replay where it got to.
  if (st.state !== 'idle' && machine(st.machineId)) {
    resetSteps(st.machineId);
    for (const line of st.lines) apply(line);
    live.state = st.state;
    // ?reopen: wisp's page didn't load (wisp stopped there, or the tunnel is down), so the app came
    // back here (MainActivity) and the tunnel is checking. Its next `open` goes back in; one that
    // is already up doesn't, or a page that keeps failing would bounce between the two.
    if (new URLSearchParams(location.search).has('reopen')) {
      openOnReady = st.machineId;
      history.replaceState(null, '', location.pathname);
    }
  } else if (main() && !sessionStorage.getItem('wisp.started')) {
    // App start: straight into the wisp of the computer used last. Coming back here (Computers,
    // Back) shows the list instead.
    connect(main());
  }
  sessionStorage.setItem('wisp.started', '1');
  paint();
}

function wire() {
  paint();
  $('#machines').addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    const m = machine(e.target.closest('[data-id]')?.dataset.id);
    if (!b || !m) return;
    const a = b.dataset.a;
    if (isGrid(m)) {
      if (a === 'open') openGrid(m);
      if (a === 'edit') cloudSheet(m);
      return;
    }
    if (a === 'connect') connect(m);
    if (a === 'open') openWisp(m);
    if (a === 'edit') editMachine(m);
    if (a === 'password') editMachine(m, { focusPassword: true });
    if (a === 'disconnect') disconnect();
    if (a === 'forget') {
      const { host, port } = parseTarget(m.target);
      Ssh.forgetHost({ host, sshPort: port || m.sshPort || 22 }).then(() => {
        toast('Forgot the saved key');
        connect(m);
      });
    }
  });
  $('#keys').addEventListener('click', (e) => {
    const k = keys.find((x) => x.id === e.target.closest('[data-k]')?.dataset.k);
    if (k) showKey(k);
  });
  $('#addMachine').onclick = () => {
    editMachine(null);
  };
  $('#addCloud').onclick = () => {
    cloudSheet();
  };
  $('#newKey').onclick = () => {
    newKey(`Key ${keys.length + 1}`);
  };
  $('#importKey').onclick = () => {
    importKey();
  };
}

boot().catch((err) => {
  toast(`Something went wrong: ${err.message}`, { stay: true });
});
