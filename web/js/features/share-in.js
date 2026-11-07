// Something shared to wisp from a phone's share sheet. Not features/share.js, which shares a task
// out. It arrives one of two ways and ends the same: New task, with it in the box and attached,
// ready to send. Nothing here starts a task.
// - A home-screen app: the service worker keeps the form and redirects to /?shared=<id> (web/sw.js).
// - The Android app: MainActivity holds it and hands it over when wisp's page asks (wispAndroid).

import { api } from '../core/api.js';
import { MOBILE } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { keepPage, signInAgain } from './cache.js';
import { fillLauncher } from './launcher.js';
import { askHome, goHome, isStacked } from './split.js';
import '../share-form.js';

const { leftOut, promptOf, take } = globalThis.wispShareForm;
const say = (text) => toast(text, { tone: 'bad' });
const NO_WORKER = 'none'; // server/http/share.js: the form reached the server, so nothing was kept
const shareId = () => new URLSearchParams(location.search).get('shared');

// The box needs a prompt to start, and a picture alone doesn't come with one.
const aboutFiles = (n) => `Take a look at the attached file${n === 1 ? '' : 's'}.`;

// Whether the server's there and takes us: 'ok', 'out' (signed out of the Grid) or 'gone'. It may
// not be up yet: a phone's page comes from its cache, ahead of the tunnel. A minute at most.
async function reachable() {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const r = await api('/health', { timeout: 5000 }).then(
      () => 'ok',
      (err) => (err.status === 401 ? 'out' : err.status < 500 ? 'ok' : ''),
    );
    if (r) return r;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 'gone';
}

// The one way in. Whatever's in the box stays, with this below it. files: for tray.hold: chips now,
// nothing leaves the phone until Send.
export function receive({ title, text, url, files = [], left = 0 }) {
  keepPage();
  // Stacked it's a phone: Send in view, not the keyboard over it (boot may have focused the box).
  goHome({ focus: !isStacked() });
  if (isStacked()) document.activeElement?.blur();
  fillLauncher(promptOf({ title, text, url }), files, { when: reachable, fallback: files.length ? aboutFiles(files.length) : '' });
  if (left) say(leftOut(left));
}

// Decided before the first paint, so the page doesn't show the list and then jump to New task.
export function sharedWaiting() {
  const waiting = !!shareId() || (MOBILE && !!window.wispAndroid?.hasShare?.());
  if (waiting) {
    keepPage();
    askHome();
  }
  return waiting;
}

const dropId = () => {
  const rest = new URLSearchParams(location.search);
  rest.delete('shared');
  history.replaceState(history.state, '', `${location.pathname}${rest.toString() ? `?${rest}` : ''}${location.hash}`);
};

// Reading it deletes it, so not before the server's taken us: signed out, the page reloads into the
// sign-in, and with ?shared= kept the same share is here after it.
async function fromWorker() {
  const id = shareId();
  if (!id) return;
  if (id === NO_WORKER) return dropId(), say('Sharing to wisp needs the Home Screen app. Add wisp to your Home Screen, then share again.');
  const state = await reachable();
  if (state === 'out') return navigator.serviceWorker?.controller ? signInAgain() : say('Sign in to wisp again, then open what you shared.');
  if (state === 'gone') return say('Can’t reach wisp. Check the connection, then open what you shared again.');
  dropId();
  const got = await take(id).catch(() => null);
  if (!got) return say('Couldn’t read what you shared. Share it again.');
  receive({ ...got, files: got.files.map((f) => ({ name: f.name, size: f.size, type: f.type, file: f })) });
}

const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// One file through the bridge, a piece at a time, handing the page back between pieces. Short of
// its size is a failure, not the end: a newer share took over, or the phone couldn't read it.
async function androidFile(token, i, { name, type, size }) {
  const parts = [];
  for (let at = 0; at < size; ) {
    const bytes = toBytes(window.wispAndroid.shareChunk(token, i, at));
    if (!bytes.length) throw new Error('Couldn’t read what you shared. Share it again.');
    parts.push(bytes);
    at += bytes.length;
    await new Promise((r) => setTimeout(r));
  }
  return new File(parts, name, { type });
}

// MainActivity says a share is here, with its token. Only this frame can hear that: the bridge
// itself reaches every frame, a task's preview included, and answers no one without the token.
// Read the moment it's offered, then Android's copy goes: nothing shared stays on the phone. The
// sizes are known, so the words and the chips show now and Send waits for the bytes (attachments.js).
async function fromAndroid(e) {
  const token = e.detail?.token;
  const raw = token && window.wispAndroid?.takeShare?.(token);
  if (!raw) return;
  const { files: list = [], ...words } = JSON.parse(raw);
  let turn = Promise.resolve();
  const files = list.map((f, i) => {
    const file = turn.then(() => androidFile(token, i, f));
    turn = file.catch(() => {});
    return { ...f, file };
  });
  receive({ ...words, files });
  const read = await Promise.allSettled(files.map((f) => f.file));
  if (read.some((r) => r.status === 'rejected')) say('Couldn’t read what you shared. Share it again.');
  window.wispAndroid.shareDone(token);
}

// After boot's route(), and in the app whenever it's offered with wisp's page already up.
export function receiveShared() {
  fromWorker();
  if (!MOBILE) return;
  addEventListener('wisp-share', fromAndroid);
  window.wispAndroid?.askShare?.(); // one that came during boot: the answer is that same event
}
