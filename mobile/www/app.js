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
// Your computers on that grid (wisp on a desktop: Machines → Add to grid) are listed under it,
// opened the same way through the grid: no SSH, no Tailscale.
//
// Progress is wisp's `@@wisp …` line protocol. The plugin adds a few lines of its own:
//   @@wisp fail ssh <message>   SSH itself failed (unreachable, auth, host key)
//   @@wisp open <version>       the tunnel answers: load wisp
//   @@wisp lost <message>       the connection dropped after it was up; the plugin retries

import { bootstrapScript, STEPS } from './shared/machines/bootstrap.js';
// registerPlugin lives in @capacitor/core, not in the bridge Android injects (scripts/shared.mjs copies it).
import { Capacitor, registerPlugin } from './shared/capacitor-core.js';
import { PHONE_TIPS } from './shared/js/tips-data.js';

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
// The list's order: the last one used first, as it was when the screen opened. A tap doesn't
// reorder it (the row would jump away from under the finger); one added since goes on top.
let order = [];
const sortOrder = () => (order = [...machines].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).map((m) => m.id));
const inOrder = () => [...machines.filter((m) => !order.includes(m.id)).reverse(), ...order.map(machine).filter(Boolean)];
const TAILSCALE_GUIDE = 'https://trywisp.dev/guides/connect-machines-with-tailscale.html';
const ADD_GUIDE = 'https://trywisp.dev/guides/reach-your-computer-from-your-phone.html#add';

// `you@host` or `you@host:2222`.
function parseTarget(t) {
  const s = String(t || '').trim();
  const at = s.lastIndexOf('@');
  const hostPort = at > 0 ? s.slice(at + 1) : s;
  const m = /^(.*?)(?::(\d+))?$/.exec(hostPort);
  return { user: at > 0 ? s.slice(0, at) : '', host: m[1], port: m[2] ? Number(m[2]) : null };
}

// action: [label, fn], a button on the toast (Undo), which then stays a little longer.
function toast(text, { stay = false, action = null } = {}) {
  const t = $('#toast');
  // Above an open sheet (dialogs sit in the top layer), or on the page; not in one sliding away.
  (document.querySelector('dialog[open]:not(.closing)') || document.body).append(t);
  t.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action[0];
    b.onclick = () => {
      t.hidden = true;
      action[1]();
    };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  if (!stay) toast.timer = setTimeout(() => (t.hidden = true), action ? 5000 : 2400);
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

// First run: a glimpse of what this is, and one tap into wisp Cloud with GitHub or Google (the
// hosted grid; another one is behind Use your own wisp Grid). After that: your computers, and
// Tips under them.
const HELLO = `<div class="hello">
    <div class="hello-art" aria-hidden="true">
      <div class="ha-row"><span class="ha-dot run"></span><span class="ha-t"><b>Fix the flaky login test</b><small>Claude Code · working</small></span></div>
      <div class="ha-row"><span class="ha-dot ask"></span><span class="ha-t"><b>Add dark mode to settings</b><small>Codex · asks you something</small></span><span class="ha-pill">Answer</span></div>
      <div class="ha-row"><span class="ha-dot done">${icon('check')}</span><span class="ha-t"><b>Bump deps and open the PR</b><small>Shipped · PR #128</small></span></div>
    </div>
    <h1>Your agents, in your pocket</h1>
    <p>Start tasks, answer their questions and ship from your phone. They keep working while it sleeps.</p>
    <div class="hello-go">
      <button class="primary prov" data-p="github" type="button">${icon('github')}<span>Continue with GitHub</span></button>
      <button class="ghost prov" data-p="google" type="button">${icon('google')}<span>Continue with Google</span></button>
    </div>
    <p class="hello-fine">Free during the preview. You get wisp Cloud, your own wisp on a server, and every computer you add to it.</p>
    <button class="hello-alt" data-p="other" type="button">Use your own wisp Grid</button>
  </div>`;

function paintIntro() {
  const out = machines.length ? '<h1>Your computers</h1>' : HELLO;
  // Only when it changed: the list repaints often, and the first screen's entry would replay.
  if ($('#intro').dataset.h !== out) ($('#intro').innerHTML = out), ($('#intro').dataset.h = out);
  document.body.classList.toggle('first', !machines.length);
  // First run: wisp Cloud is the buttons at the top, so its button below would say it twice.
  // Signed in: your computers come from there, so no second sign-in button.
  $('#addCloud').hidden = !machines.length || machines.some(isGrid);
  // Signed in, SSH is one more way, not the way "instead" of something.
  $('#sshBox > summary span').firstChild.textContent = machines.some(isGrid) ? 'Connect over SSH ' : 'Connect over SSH instead ';
}

function paintMachines() {
  const box = $('#machines');
  paintIntro();
  paintTips();
  if (!machines.length) {
    box.innerHTML = '';
    return;
  }
  // The whole row opens it (data-row: what a tap does); its settings are behind ⋯. "Open" is quiet:
  // the solid button is kept for the one row that needs a step from you (Connect, Try again).
  const opening_ = `<button class="ghost m-go" disabled type="button"><span class="spin"></span>Opening</button>`;
  const openBtn = `<button class="ghost m-go go" data-a="open" type="button">Open ${icon('arrow')}</button>`;
  const more = (m) => `<button class="icon m-more" data-a="edit" type="button" aria-label="${esc(`${nameOf(m)}: settings`)}">${icon('dots')}</button>`;
  box.innerHTML = inOrder()
    .map((m) => {
      const on = live.id === m.id && live.state !== 'idle';
      const state = on ? live.state : 'idle';
      if (isGrid(m)) {
        const go = opening === m.id ? opening_ : m.signedOut ? `<button class="primary m-go" data-a="edit" type="button">Sign in</button>` : openBtn;
        // Its computers: open when online, the button greyed (same width) when not.
        const comps = m.signedOut
          ? ''
          : (m.computers || [])
              .map((c) => {
                const key = `${m.id}:${c.id}`;
                const cgo = opening === key ? opening_ : c.online ? openBtn : `<button class="ghost m-go" disabled type="button">Offline</button>`;
                return `<article class="card m comp ${c.online ? 'ready' : 'off'}" data-id="${esc(m.id)}" data-c="${esc(c.id)}" ${c.online ? 'data-row="open"' : ''}>
          <div class="m-row">
            <span class="m-ico">${icon('laptop')}<span class="st"></span></span>
            <div class="m-text"><span class="m-name">${esc(c.name)}</span><span class="m-sub"><span class="kind grid">Your computer</span></span></div>
            ${cgo}<span class="m-more-gap"></span>
          </div>
        </article>`;
              })
              .join('');
        return `<article class="card m cloud ${m.signedOut ? 'failed' : 'ready'}" data-id="${esc(m.id)}" data-row="${m.signedOut ? 'edit' : 'open'}">
          <div class="m-row">
            <span class="m-ico">${icon('cloud')}<span class="st"></span></span>
            <div class="m-text"><span class="m-name">${esc(nameOf(m))}</span><span class="m-sub">${m.signedOut ? 'Signed out' : `<span class="kind cloud">Cloud</span><span class="m-at">${esc(hostOf(m.grid))}</span>`}</span></div>
            ${go}${more(m)}
          </div>
        </article>${comps}`;
      }
      const go = opening === m.id ? opening_ : state === 'ready' ? openBtn : state === 'connecting' ? `<button class="ghost m-go" disabled type="button">Connecting…</button>` : `<button class="primary m-go" data-a="connect" type="button">${state === 'failed' ? 'Try again' : 'Connect'}</button>`;
      const row = state === 'ready' ? 'open' : state === 'connecting' ? '' : 'connect';
      return `<article class="card m ${state}" data-id="${esc(m.id)}" ${row ? `data-row="${row}"` : ''}>
          <div class="m-row">
            <span class="m-ico">${icon('server')}<span class="st"></span></span>
            <div class="m-text"><span class="m-name">${esc(nameOf(m))}</span><span class="m-sub"><span class="kind">Over SSH</span><span class="m-at">${esc(m.target)}</span></span></div>
            ${go}${more(m)}
          </div>
          ${on ? runHtml() : ''}
        </article>`;
    })
    .join('');
}

// --- tips --------------------------------------------------------------------------------------
// Under the list, as on wisp's own home (web/js/features/tips.js): cards pinned on top for the next
// thing to do, each gone once it's done (open a computer, allow notifications, add your own
// computer), then a few lines on what the phone can do, a new set each start and on More tips,
// each opening its guide on trywisp.dev.

const TIPS_AT = 'wisp.phoneTipsAt';
const TIPS_N = 3;
const NOTIFY_ASKED = 'wisp.tipNotifyAsked'; // asked once from here: the card's done, whatever the answer
let tipsAt = (() => {
  const v = localStorage.getItem(TIPS_AT);
  const at = v === null ? 0 : (Number(v) + TIPS_N) % PHONE_TIPS.length; // first start: from the top
  localStorage.setItem(TIPS_AT, String(at));
  return at;
})();

// What Start opens: the first computer in the list that opens with a tap.
const firstOpen = () => inOrder().find((m) => !isGrid(m) || !m.signedOut);

const notifyAsk = () => window.wispAndroid?.permission?.() === 'default' && !localStorage.getItem(NOTIFY_ASKED);

const pinnedTip = (t, ico, title, line, cta) => `<button type="button" class="tp-card" data-t="${t}">
    <span class="tp-badge">${icon(ico)}</span>
    <span class="tp-text"><b>${title}</b><small>${line}</small></span>
    <span class="tp-cta"><span>${cta}</span>${icon('arrow')}</span>
  </button>`;

function tipsHtml() {
  if (!machines.length) return ''; // the first screen explains itself
  const fresh = !machines.some((m) => m.seen || m.opened);
  const first = fresh && firstOpen();
  const lonely = machines.some((m) => isGrid(m) && !m.signedOut && !m.computers?.length);
  const pinned = [
    first && pinnedTip('start', 'arrow', 'Step in to start', 'Tap a computer and its wisp opens here: start tasks, answer your agents, read their reports', `Start in ${esc(nameOf(first))}`),
    notifyAsk() && pinnedTip('notify', 'bell', 'Hear when an agent needs you', 'A nudge on this phone when a task asks you something or finishes, so you can put it away', 'Allow'),
    lonely && pinnedTip('add', 'laptop', 'Bring your own computer', 'In wisp on it: <b>Machines</b> → <i>Reach this computer from anywhere</i> → <b>Add to grid</b>. It lands here, no SSH', 'How'),
  ].filter(Boolean);
  const lines = Array.from({ length: Math.min(TIPS_N, PHONE_TIPS.length) }, (_, i) => PHONE_TIPS[(tipsAt + i) % PHONE_TIPS.length])
    .map(([text, href]) => `<button type="button" class="tp" data-href="${esc(href)}">${icon('spark')}<span>${text}</span>${icon('external')}</button>`)
    .join('');
  // The first card is the next step: it alone gets the ring and the solid button.
  return `<h4><span>Tips</span><button class="tp-more" type="button" data-t="more">More tips</button></h4>${pinned.join('').replace('class="tp-card"', 'class="tp-card next"')}${lines}`;
}

function paintTips() {
  const box = $('#tips');
  const out = tipsHtml();
  // Only when they changed: the list repaints often (spinners, refreshes), and a new node replays its press state.
  if (box.dataset.h !== out) (box.innerHTML = out), (box.dataset.h = out);
  box.hidden = !out;
}

function wireTips() {
  $('#tips').addEventListener('click', (e) => {
    const line = e.target.closest('[data-href]');
    if (line) {
      Ssh.openExternal({ url: line.dataset.href }).catch((err) => toast(err.message));
      return;
    }
    const t = e.target.closest('[data-t]')?.dataset.t;
    if (t === 'more') {
      tipsAt = (tipsAt + TIPS_N) % PHONE_TIPS.length;
      localStorage.setItem(TIPS_AT, String(tipsAt));
      paintTips();
    }
    if (t === 'start') {
      const m = firstOpen();
      if (m) connect(m);
    }
    if (t === 'add') Ssh.openExternal({ url: ADD_GUIDE }).catch((err) => toast(err.message));
    if (t === 'notify') {
      // At once: the card goes, Android's own question takes over.
      localStorage.setItem(NOTIFY_ASKED, '1');
      paintTips();
      window.wispAndroid.requestPermission();
    }
  });
  window.addEventListener('wisp-notify-permission', (e) => {
    toast(e.detail === 'granted' ? 'Notifications on: your agents can reach you now' : 'No notifications. Turn them on any time in Android’s settings for wisp');
    paintTips();
  });
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

// Opened from wisp's page (Computers in its top bar, its logo): no Back button here; the phone's
// Back (MainActivity) still returns to it as it was.
const paint = () => {
  paintMachines();
  paintKeys();
};


// Back here from wisp's page (Back): the page may come from the back/forward cache, with
// the Opening button still showing.
addEventListener('pageshow', () => {
  sortOrder(); // back on the list: the one just used goes first
  if (opening) {
    opening = '';
    paintMachines();
  }
  refreshComputers();
});

// --- actions -----------------------------------------------------------------------------------

const openWisp = (m) => {
  if (!native) return toast(`Opens wisp at 127.0.0.1:${m.port || 4477}`); // the preview has no tunnel
  // The tap shows at once. Once its wisp has opened here, its page and the tasks seen last are
  // cached on the phone (web/sw.js, web/js/features/cache.js): from then on it opens at once.
  opening = m.id;
  m.opened = true; // the first-run explanation goes (paintIntro)
  if (!m.seen && live.id === m.id && live.state === 'ready') m.seen = true;
  save();
  paintMachines();
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

// Your computers on each grid you're signed in to. The last list stays (the screen paints from it
// at once); this asks again: at start, coming back to the app, and after signing in.
async function refreshComputers() {
  const grids = machines.filter((m) => isGrid(m) && !m.signedOut);
  if (opening || !grids.length) return; // on its way out, a repaint would only flicker
  const was = JSON.stringify(grids.map((m) => [m.signedOut, m.computers]));
  await Promise.all(
    grids
      .map(async (m) => {
        try {
          const r = await fetch(`${m.grid}/api/computers`, { headers: { authorization: `Bearer ${m.token}` }, signal: AbortSignal.timeout(8000) });
          if (r.status === 401) m.signedOut = true;
          if (!r.ok) return;
          m.computers = ((await r.json()).computers || []).map(({ id, name, online }) => ({ id, name, online }));
        } catch {} // offline: keep the last list
      }),
  );
  // Only what changed repaints: a repaint restarts the spinners of a computer connecting.
  if (JSON.stringify(grids.map((m) => [m.signedOut, m.computers])) === was) return;
  save();
  paintMachines();
}

// The list keeps up while it's on screen: a computer coming online (or going away) shows by itself.
const REFRESH_MS = 10000;
let refreshTimer = null;
function watchComputers() {
  clearInterval(refreshTimer);
  refreshTimer = document.visibilityState === 'visible' ? setInterval(refreshComputers, REFRESH_MS) : null;
}

// Into a cloud computer's wisp, or one of your computers on its grid (cid): a fresh one-time link
// each time (the grid starts the cloud one if it sleeps).
async function openGrid(m, cid = '') {
  const c = cid ? m.computers?.find((x) => x.id === cid) : null;
  opening = c ? `${m.id}:${c.id}` : m.id;
  m.lastUsed = Date.now();
  m.opened = true;
  save();
  paintMachines();
  try {
    if (live.state !== 'idle') await disconnect(); // one computer at a time
    await Ssh.allowGrid({ domain: new URL(m.grid).hostname });
    const r = await gridPost(`${m.grid}/api/device/link`, { path: `/?m=${encodeURIComponent(c ? c.name : nameOf(m))}`, ...(c && { computer: c.id }) }, m.token);
    if (r.status === 401) {
      m.signedOut = true;
      save();
      throw new Error('This phone was signed out of it. Tap it to sign in again.');
    }
    if (r.status === 404 && c) refreshComputers(); // removed meanwhile
    if (r.status >= 400 || !r.body.url) throw new Error(r.body.error || `The grid said ${r.status}.`);
    if (!native) {
      opening = '';
      paintMachines();
      return toast(`Opens ${r.body.url.split('/_grid')[0]}`);
    }
    location.href = r.body.url;
  } catch (err) {
    opening = '';
    paintMachines();
    toast(err.message === 'Failed to fetch' ? `Can’t reach ${hostOf(m.grid)}` : err.message);
  }
}

// Sign in to a grid: a code to allow in the browser, then this phone is a device there.
// start.grid: sign in to that grid right away, straight to the code. start.provider (the first
// screen's GitHub and Google buttons): the browser goes straight to that provider, then to Allow
// for this code (/activate), with no grid page or code to type in between.
function cloudSheet(m = null, start = null) {
  const d = $('#gSheet');
  let via = start?.provider || '';
  let VIA = { github: 'GitHub', google: 'Google' }[via] || '';
  const body = $('#gBody');
  let flow = null; // { grid, code, url, interval, timer }
  let closed = false;
  const stop = () => {
    clearTimeout(flow?.timer);
    if (flow) flow.timer = null;
  };
  // Signing in from the list: the same one tap as the first screen (GitHub, Google), never a grid
  // address to type; another grid is behind Use your own wisp Grid.
  const pick = () => {
    $('#gTitle').textContent = 'wisp Cloud';
    body.innerHTML = `<p class="muted">Your own wisp on a server: agents keep working when your computers sleep, and every computer you add to it shows here.</p>
      <input id="gUrl" type="hidden" value="${esc(DEFAULT_GRID)}">
      <div class="hello-go">
        <button class="primary prov" data-g="github" type="button">${icon('github')}<span>Continue with GitHub</span></button>
        <button class="ghost prov" data-g="google" type="button">${icon('google')}<span>Continue with Google</span></button>
      </div>
      <button class="hello-alt" data-g="other" type="button">Use your own wisp Grid</button>`;
  };
  const ask = (error = '') => {
    stop();
    $('#gTitle').textContent = m ? nameOf(m) : 'wisp Cloud';
    body.innerHTML = `${m ? `<p class="muted">${esc(m.handle)} on <b>${esc(hostOf(m.grid))}</b>${m.signedOut ? ' · signed out' : ''}</p>` : '<p class="muted">Your own wisp on a server: agents keep working when your computers sleep. Sign in to a wisp Grid (yours, your team’s, or a hosted one) with Google, GitHub or what it offers.</p>'}
      <label class="field"><span>Grid</span><input id="gUrl" placeholder="wisp.example.com" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" value="${esc(m ? m.grid.replace(/^https:\/\//, '') : start?.own ? '' : localStorage.getItem('wisp.grid') || DEFAULT_GRID)}" required></label>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <div class="sheet-actions">${m ? '<button class="ghost danger" data-g="signout" type="button">Sign out</button>' : ''}<span class="grow"></span><button class="primary" type="submit">${m ? 'Sign in again' : 'Sign in'}</button></div>
      ${m ? '<button class="sheet-del" data-g="delete" type="button">Delete your account</button>' : ''}`;
  };
  // app=android: once allowed, the grid's page links back here instead of to the account page,
  // which would open your wisp in the browser.
  const signInUrl = () =>
    via
      ? `${flow.grid}/auth/${via}/start?return=${encodeURIComponent(`/activate?code=${encodeURIComponent(flow.code)}&app=android`)}`
      : `${flow.url}${flow.url.includes('?') ? '&' : '?'}app=android`;
  const openSignIn = () => Ssh.openExternal({ url: signInUrl() }).catch((err) => toast(err.message));
  const waiting = () => {
    if (VIA) $('#gTitle').textContent = `Continue with ${VIA}`;
    body.innerHTML = VIA
      ? `<p><b>Finish in your browser</b></p><p class="muted">Sign in with ${VIA}, then tap <b>Allow</b> for this phone. The code there matches this one.</p>
      <div class="code">${esc(flow.code)}</div>
      <div class="row"><button class="primary" data-g="open" type="button">Open ${VIA} again</button></div>
      <p class="wait"><span class="spin"></span>Waiting for you to allow it…</p>`
      : `<p><b>Allow this phone</b></p><p class="muted">Open ${esc(hostOf(flow.grid))} in your browser, sign in, and allow the device showing this code.</p>
      <div class="code">${esc(flow.code)}</div>
      <div class="row"><button class="primary" data-g="open" type="button">Open the sign-in page</button><button class="ghost" data-g="copy" type="button">Copy code</button></div>
      <p class="wait"><span class="spin"></span>Waiting for you to allow it…</p>`;
  };
  const poll = async () => {
    const f = flow;
    f.timer = null; // one poll at a time: back() only asks while one is scheduled
    const r = await gridPost(`${f.grid}/api/device/token`, { device_code: f.deviceCode }).catch(() => null);
    // Closed, or signed in again with a new code meanwhile: this answer is for nobody.
    if (closed || f !== flow) return;
    const e = r?.body.error;
    // Offline, or not the grid's answer (a 502 while it restarts, a rate limit): ask again later.
    const busy = !r || r.status === 429 || r.status >= 500 || (!e && !r.body.token);
    if (busy || e === 'authorization_pending' || e === 'slow_down') {
      if (e === 'slow_down') f.interval += 5;
      f.timer = setTimeout(poll, f.interval * 1000);
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
    // Computers on it already: here they are, to pick one. None: straight into the cloud one.
    await refreshComputers();
    if (c.computers?.length) toast(`Signed in as ${user.handle}: your cloud wisp and ${c.computers.length} computer${c.computers.length > 1 ? 's' : ''}`);
    else {
      toast(`Signed in as ${user.handle}`);
      openGrid(c);
    }
  };
  // Back from the browser: ask now rather than at the next poll, so your wisp opens at once.
  const back = () => {
    if (document.visibilityState !== 'visible' || !flow?.deviceCode || !flow.timer) return;
    clearTimeout(flow.timer);
    const w = $('.wait', body);
    if (w) w.innerHTML = `<span class="spin"></span>Checking with ${esc(hostOf(flow.grid))}…`;
    poll();
  };
  document.addEventListener('visibilitychange', back);
  // A listener, not onclose: present() sets that one (it pops the sheet's history entry).
  d.addEventListener(
    'close',
    () => {
      closed = true;
      stop();
      document.removeEventListener('visibilitychange', back);
    },
    { once: true },
  );
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
      if (via) openSignIn(); // the tap was the choice: no second one
      flow.timer = setTimeout(poll, flow.interval * 1000);
    } catch (err) {
      ask(err.message === 'Failed to fetch' ? `Can’t reach ${hostOf(grid)}` : err.message);
    }
  };
  body.onclick = async (e) => {
    const a = e.target.closest('[data-g]')?.dataset.g;
    if (a === 'github' || a === 'google') {
      via = a;
      VIA = { github: 'GitHub', google: 'Google' }[a];
      $('#gForm').requestSubmit();
    }
    if (a === 'other') {
      ask();
      $('#gUrl').value = '';
      $('#gUrl').focus();
    }
    if (a === 'open' && flow?.deviceCode) await openSignIn();
    if (a === 'copy' && flow) copy(flow.code, 'code');
    // Deleting lives on the grid's account page (typed handle to confirm): the browser that
    // allowed this phone is still signed in there.
    if (a === 'delete' && m) Ssh.openExternal({ url: `${m.grid}/account#delete` }).catch((err) => toast(err.message));
    if (a === 'signout' && m) {
      gridPost(`${m.grid}/api/device/revoke`, {}, m.token).catch(() => {});
      machines = machines.filter((x) => x.id !== m.id);
      save();
      paint();
      dismiss(d);
      toast(`Signed out of ${nameOf(m)}`);
    }
  };
  if (start?.pick) pick();
  else ask();
  present(d);
  if (start?.pick) return;
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
    const at = machines.indexOf(m);
    machines = machines.filter((x) => x.id !== m.id);
    save();
    paint();
    close();
    toast(`Removed ${nameOf(m)}`, {
      action: [
        'Undo',
        () => {
          machines.splice(at, 0, m);
          save();
          paint();
        },
      ],
    });
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
  // A damaged key file is skipped (Keys.list), not the whole list: say which one.
  if (listed?.unreadable?.length) toast(`Couldn’t read the key ${listed.unreadable.join(', ')}, so it’s left out.${keys[0] ? ` Computers that used it now try ${keys[0].name}.` : ''}`, { stay: true });

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
  }
  // App start shows this list: you pick the computer (the one used last is at the top).
  paint();
  refreshComputers();
  watchComputers();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshComputers();
    watchComputers();
  });
}

function wire() {
  sortOrder();
  wireTips();
  paint();
  $('#machines').addEventListener('click', (e) => {
    // A tap on the row itself (not one of its buttons, nor the steps under it) does what its button does.
    const card = e.target.closest('[data-id]');
    const b = e.target.closest('[data-a]') || (e.target.closest('.m-row') && !e.target.closest('button') && card?.dataset.row ? { dataset: { a: card.dataset.row } } : null);
    const m = machine(card?.dataset.id);
    if (!b || !m) return;
    const a = b.dataset.a;
    if (isGrid(m)) {
      if (a === 'open') openGrid(m, e.target.closest('[data-c]')?.dataset.c || '');
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
  // The first screen: GitHub or Google on the hosted grid, or another grid's address.
  $('#intro').addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]')?.dataset.p;
    if (p === 'other') cloudSheet(null, { own: true });
    else if (p) cloudSheet(null, { grid: DEFAULT_GRID, provider: p });
  });
  $('#addCloud').onclick = () => {
    cloudSheet(null, { pick: true });
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
