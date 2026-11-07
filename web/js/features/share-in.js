// Something shared to wisp from a phone's share sheet. Not features/share.js, which shares a task
// out. It arrives one of two ways and ends the same: New task, with it in the box and attached,
// ready to send. Nothing here starts a task.
// - A home-screen app: the service worker keeps the form and redirects to /?shared=<id> (web/sw.js).
// - The Android app: MainActivity holds it and hands it over when wisp's page asks (wispAndroid).

import { api } from '../core/api.js';
import { MOBILE } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { keepPage } from './cache.js';
import { fillLauncher } from './launcher.js';
import { askHome, goHome, isStacked } from './split.js';
import '../share-form.js';

const { leftOut, promptOf, take } = globalThis.wispShareForm;
const say = (text) => toast(text, { tone: 'bad' });
const NO_WORKER = 'none'; // server/http/share.js: the form reached the server, so nothing was kept
const shareId = () => new URLSearchParams(location.search).get('shared');

// The box needs a prompt to start, and a picture alone doesn't come with one.
const aboutFiles = (n) => `Take a look at the attached file${n === 1 ? '' : 's'}.`;

// The server may not be up yet: a phone's page comes from its cache, ahead of the tunnel. The
// chips show now and the uploads wait for it, a minute at most, so a share doesn't fail on opening.
async function reachable() {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await api('/health', { timeout: 5000 }).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// The one way in. Whatever's in the box stays, with this below it.
export function receive({ title, text, url, files = [], count = files.length, left = 0 }) {
  keepPage();
  // Stacked it's a phone: Send in view, not the keyboard over it (boot may have focused the box).
  goHome({ focus: !isStacked() });
  if (isStacked()) document.activeElement?.blur();
  fillLauncher(promptOf({ title, text, url }), files, { when: files.length ? reachable() : null, fallback: count ? aboutFiles(count) : '' });
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

async function fromWorker() {
  const id = shareId();
  if (!id) return;
  const rest = new URLSearchParams(location.search);
  rest.delete('shared');
  history.replaceState(history.state, '', `${location.pathname}${rest.toString() ? `?${rest}` : ''}${location.hash}`);
  if (id === NO_WORKER) return say('Sharing to wisp needs the Home Screen app. Add wisp to your Home Screen, then share again.');
  const got = await take(id).catch(() => null);
  if (!got) return say('Couldn’t read what you shared. Share it again.');
  receive(got);
}

const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// One file through the bridge, a piece at a time, handing the page back between pieces.
async function androidFile(token, i, { name, type }) {
  const parts = [];
  for (let at = 0; ; ) {
    const bytes = toBytes(window.wispAndroid.shareChunk(token, i, at));
    if (!bytes.length) break;
    parts.push(bytes);
    at += bytes.length;
    await new Promise((r) => setTimeout(r));
  }
  return new File(parts, name, { type });
}

// MainActivity says a share is here, with its token. Only this frame can hear that: the bridge
// itself reaches every frame, a task's preview included, and answers no one without the token.
// Read the moment it's offered, then Android's copy goes: nothing shared stays on the phone.
async function fromAndroid(e) {
  const token = e.detail?.token;
  const raw = token && window.wispAndroid?.takeShare?.(token);
  if (!raw) return;
  const { files: list = [], ...words } = JSON.parse(raw);
  receive({ ...words, count: list.length }); // the words don't wait for the files
  try {
    const files = [];
    for (const [i, f] of list.entries()) files.push(await androidFile(token, i, f));
    if (files.length) fillLauncher('', files, { when: reachable() });
  } catch {
    say('Couldn’t read what you shared. Share it again.');
  } finally {
    window.wispAndroid.shareDone(token);
  }
}

// After boot's route(), and in the app whenever it's offered with wisp's page already up.
export function receiveShared() {
  fromWorker();
  if (!MOBILE) return;
  addEventListener('wisp-share', fromAndroid);
  window.wispAndroid?.askShare?.(); // one that came during boot: the answer is that same event
}
