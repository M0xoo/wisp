// Notifications when a task finishes or asks: a toast, and a desktop notification when the window
// isn't focused. In the Android app the WebView has no Notification API: MainActivity adds
// window.wispAndroid, which posts Android notifications instead (a tap opens #/s/<id>).

import { esc } from '../md.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { reveal } from './feed.js';
import { watching } from './scroll.js';
import { avatarHtml, crewInView, memberById, openMember } from './crew.js';

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

// A reminder came due (server/later.js): it's in Needs you; this says so wherever you are.
export function notifyReminder(s) {
  const text = s.reminder?.text || s.title;
  toast(`${icon('bell')} <b>Reminder</b>: ${esc(text)}`, { action: { label: 'Open', run: () => reveal(s.id) }, timeout: 9000 });
  if (!notifyOn() || focused()) return;
  if (app) return app.notify(s.id, 'Reminder', text);
  const note = new Notification('Reminder', { body: text, icon: '/apple-touch-icon.png', tag: `r-${s.id}` });
  note.onclick = () => (window.focus(), reveal(s.id));
}

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
  // A crew member's job: their face and name say who's reporting. Not while their thread is on
  // screen: it shows there.
  const member = s.crew && memberById(s.crew.id);
  if (member && crewInView(member.id) && focused()) return;
  const head = member ? `${avatarHtml(member, { size: 18, dot: false })} <b>${esc(member.name)}</b>${s.state === 'waiting' ? ' has a question' : ' reported'}: ${esc(s.title)}` : `${icon(s.state === 'waiting' ? 'ask' : 'spark')} <b>${esc(s.title)}</b> ${verb}`;
  // A member's job opens in its thread, at that job: the question to answer, or the report.
  const open = () => (member ? openMember(member.id, { entry: s.id }) : reveal(s.id));
  toast(head, { action: { label: 'Open', run: open }, timeout: 7000 });
  if (!notifyOn() || focused()) return;
  const body = s.state === 'waiting' ? s.question : s.preview || 'Ready for review';
  const title = member ? `${member.name}: ${s.title}` : `${s.project}: ${s.title}`;
  if (app) return app.notify(s.id, title, body || '');
  const note = new Notification(title, { body, icon: '/apple-touch-icon.png', tag: s.id });
  note.onclick = () => (window.focus(), open());
}
