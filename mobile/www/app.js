// The app's own screen: your computers. Tap one and the app opens that computer's wisp: the
// WispSsh plugin runs wisp's bootstrap script there (shared/machines/bootstrap.js, the same file
// desktop Machines sends; it installs Node.js and starts wisp when they're missing), forwards
// 127.0.0.1:<port> on this phone to it, and this page hands over to wisp's page. In there,
// Computers in the top bar comes back here (web/js/features/machines.js openComputers).
//
// Computers live in localStorage, keys in the native plugin. A password is typed for one connect:
// the plugin then adds the phone's key there ("@@wisp keyed") and the password is dropped.
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
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
// The tunnel step is the phone's; Find harnesses is left to wisp's own page.
const PHONE_STEPS = STEPS.filter(([id]) => id !== 'agents');

let machines = load();
let keys = [];
// The one live connection: which machine, its steps, and how it ended (if it did).
const live = { id: '', state: 'idle', steps: [], failure: null, opened: false };
let openOnReady = ''; // set by a Connect tap here, so a background reconnect never yanks the page
const passwords = new Map(); // typed for one connection, never saved

function load() {
  try {
    return JSON.parse(localStorage.getItem(SAVED)) || [];
  } catch {
    return [];
  }
}
const save = () => localStorage.setItem(SAVED, JSON.stringify(machines));
const newId = () => Math.random().toString(36).slice(2, 10);
const machine = (id) => machines.find((m) => m.id === id);
const keyOf = (m) => keys.find((k) => k.id === m?.keyId) || keys[0];
const nameOf = (m) => m.name || parseTarget(m.target).host;
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
      <p>Start tasks and answer your agents from anywhere. They run on your own computers and keep going when the phone sleeps.</p>
      <ol class="how">
        <li><span class="n">1</span><div><b>Get a computer ready</b><span>Turn on SSH: on a Mac, System Settings → General → Sharing → Remote Login; on Linux, install openssh-server. That’s all: the app installs Node.js and wisp there.</span></div></li>
        <li><span class="n">2</span><div><b>Add it here</b><span>Its address, and your password on it once.</span></div></li>
        <li><span class="n">3</span><div><b>Start working</b><span>wisp opens. Pick a coding agent there (opencode installs in one click) and give it a task. <b>Computers</b> in its top bar brings you back here.</span></div></li>
      </ol>
      <p class="tip">${icon('arrow')}<span>Away from home? Put the computer and this phone on <a href="${TAILSCALE_GUIDE}">Tailscale</a> (free).</span></p>`;
  $('#addMachine span').textContent = machines.length ? 'Add another computer' : 'Add your computer';
  $('#addMachine').classList.toggle('first', !machines.length);
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
      const go = state === 'ready' ? `<button class="primary m-go" data-a="open" type="button">Open ${icon('arrow')}</button>` : state === 'connecting' ? `<button class="ghost m-go" disabled type="button">Connecting…</button>` : `<button class="ghost m-go" data-a="connect" type="button">${state === 'failed' ? 'Try again' : 'Connect'}</button>`;
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

// --- actions -----------------------------------------------------------------------------------

const openWisp = (m) => {
  if (!native) return toast(`Opens wisp at 127.0.0.1:${m.port || 4477}`); // the preview has no tunnel
  // ?m=: wisp's page names "here" after this computer (web/js/core/state.js HUB).
  location.href = `http://127.0.0.1:${m.port || 4477}/?m=${encodeURIComponent(nameOf(m))}`;
};

async function connect(m) {
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
  }
}

async function disconnect() {
  Object.assign(live, { id: '', state: 'idle', failure: null });
  openOnReady = '';
  paint();
  await Ssh.disconnect();
}

// --- sheets ------------------------------------------------------------------------------------
// A sheet pushes a history entry, so Android's back button closes it instead of leaving the app.

function present(dialog) {
  dialog.showModal();
  history.pushState({ sheet: dialog.id }, '');
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.onclose = () => {
    if (history.state?.sheet === dialog.id) history.back();
  };
  dialog.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => {
      close();
    };
  });
  return close;
}
window.addEventListener('popstate', () => {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
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
  wire(); // first, so the buttons work even if the plugin below fails
  try {
    ({ keys } = await Ssh.listKeys());
  } catch (err) {
    toast(`Couldn’t read this phone’s keys: ${err.message}`, { stay: true });
  }

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
  const st = await Ssh.status();
  if (st.state !== 'idle' && machine(st.machineId)) {
    resetSteps(st.machineId);
    for (const line of st.lines) apply(line);
    live.state = st.state;
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
