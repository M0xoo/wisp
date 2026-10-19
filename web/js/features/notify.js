// Notifications when a task finishes or asks: a toast, and a desktop notification when the window
// isn't focused.

import { esc } from '../md.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { reveal } from './feed.js';
import { watching } from './scroll.js';

// On unless turned off in settings, and only if the browser lets us.
export function notifyOn() {
  return S.config.defaults.notify !== 'off' && 'Notification' in window && Notification.permission === 'granted';
}

export function askNotify() {
  if (S.config.defaults.notify !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

export function notifyFinished(s) {
  const viewing = S.open.has(s.id) && watching(s.id) && document.hasFocus();
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
  if (notifyOn() && !document.hasFocus()) {
    const note = new Notification(`${s.project}: ${s.title}`, { body: s.state === 'waiting' ? s.question : s.preview || 'Ready for review', icon: '/apple-touch-icon.png', tag: s.id });
    note.onclick = () => (window.focus(), reveal(s.id));
  }
}
