// Notifications when a task finishes or asks: a toast, and a desktop notification when the window
// isn't focused. In the Android app the WebView has no Notification API: MainActivity adds
// window.wispAndroid, which posts Android notifications instead (a tap opens #/s/<id>).

import { esc } from '../md.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { reveal } from './feed.js';
import { watching } from './scroll.js';

const app = typeof window !== 'undefined' ? window.wispAndroid : null;

// 'granted' | 'denied' | 'default' | 'unsupported', from the browser or the Android app.
export function notifyPermission() {
  if (app) return app.permission();
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

// Resolves to the new permission. The app answers with a wisp-notify-permission event.
export function requestNotify() {
  if (!app) return Notification.requestPermission();
  return new Promise((done) => {
    window.addEventListener('wisp-notify-permission', (e) => done(e.detail), { once: true });
    app.requestPermission();
  });
}

// On unless turned off in settings, and only if the browser lets us.
export function notifyOn() {
  return S.config.defaults.notify !== 'off' && notifyPermission() === 'granted';
}

export function askNotify() {
  if (S.config.defaults.notify !== 'off' && notifyPermission() === 'default') requestNotify();
}

// The app's WebView can keep focus while the app sits in the background: ask the app.
const focused = () => (app ? app.foreground() : document.hasFocus());

export function notifyFinished(s) {
  const viewing = S.open.has(s.id) && watching(s.id) && focused();
  if (viewing) return;
  let verb = s.state === 'waiting' ? (s.approval ? 'needs your approval' : 'has a question') : 'is ready';
  // A task run in several places (or compared) says so once, when its last run finishes.
  const runs = s.groupId ? [...S.sessions.values()].filter((x) => x.groupId === s.groupId && !x.archived) : [];
  if (runs.length > 1 && s.state !== 'waiting') {
    if (runs.some((x) => x.id !== s.id && x.state === 'running')) return;
    const places = new Set(runs.map((x) => x.machine?.id || '')).size;
    verb = places > 1 ? `is ready on ${places} machines` : `is ready (${runs.length} runs)`;
  }
  toast(`${icon(s.state === 'waiting' ? 'ask' : 'spark')} <b>${esc(s.title)}</b> ${verb}`, { action: { label: 'Open', run: () => reveal(s.id) }, timeout: 7000 });
  if (!notifyOn() || focused()) return;
  const body = s.state === 'waiting' ? s.question : s.preview || 'Ready for review';
  if (app) return app.notify(s.id, `${s.project}: ${s.title}`, body || '');
  const note = new Notification(`${s.project}: ${s.title}`, { body, icon: '/apple-touch-icon.png', tag: s.id });
  note.onclick = () => (window.focus(), reveal(s.id));
}
