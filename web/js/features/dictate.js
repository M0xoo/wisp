// The composer's mic, in the phone app only: Android's speech recognizer
// (mobile/…/Dictation.java, through MainActivity's wispAndroid) types what you say into the box,
// its partial results as they come. Tap again to stop. One box listens at a time.
// Browsers and the desktop app never see the button.

import { icon } from '../core/dom.js';
import { MOBILE } from '../core/state.js';
import { toast } from '../ui/toast.js';

const app = typeof window !== 'undefined' ? window.wispAndroid : null;
// An app without Dictation.java (older) or a phone without a speech service: no button.
export const CAN_DICTATE = MOBILE && typeof app?.dictate === 'function' && !!app.dictation?.();

const WHY = {
  denied: 'wisp needs the microphone to dictate. Tap the mic again to allow it.',
  blocked: 'The microphone is off for wisp. Allow it in Android Settings → Apps → wisp → Permissions, then tap the mic again.',
  silence: 'Didn’t hear anything. Tap the mic and speak.',
  network: 'Dictation needs a connection on this phone. Try again once you’re online.',
  busy: 'The phone’s speech service is busy. Try again in a moment.',
  audio: 'The phone couldn’t use its microphone.',
  failed: 'Dictation stopped. Try again.',
};

// The box listening now: { ta, btn, before, after } (what was around the cursor when it started).
let cur = null;

export const micHtml = (cls, id = '') => (CAN_DICTATE ? `<button class="icon-btn ${cls}"${id ? ` id="${id}"` : ''} type="button" aria-label="Dictate" title="Dictate" aria-pressed="false">${icon('mic')}</button>` : '');

// Wires a mic button (from micHtml) to its textarea. No button (not the app): nothing to do.
// onStart: the reply box opens up (as typing would), so the words show as they come.
export function micFor(btn, ta, { onStart } = {}) {
  if (!btn) return;
  btn.onclick = (e) => {
    e.preventDefault();
    if (cur?.btn === btn) return stop();
    if (cur) stop();
    start(btn, ta);
    onStart?.();
  };
}

function start(btn, ta) {
  const at = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? at;
  cur = { ta, btn, before: ta.value.slice(0, at), after: ta.value.slice(end), last: ta.value };
  paint(btn, true); // at once: the recognizer takes a moment to open
  app.dictate();
}

function stop() {
  if (!cur) return;
  app.dictateStop(); // the final result still comes, then `end`
}

function paint(btn, on) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Stop dictating' : 'Dictate');
  btn.title = on ? 'Stop dictating' : 'Dictate';
}

// What was said goes where the cursor was, a space from the words around it.
// The box changed under it (sent, cleared, typed in): stop, and leave the box as it is.
function put(text) {
  const { ta, before, after } = cur;
  if (ta.value !== cur.last || !ta.isConnected) return void stop();
  const t = text.trim();
  const lead = t && before && !/\s$/.test(before) ? ' ' : '';
  const tail = t && after && !/^\s/.test(after) ? ' ' : '';
  ta.value = before + lead + t + tail + after;
  const pos = (before + lead + t).length;
  cur.last = ta.value;
  ta.setSelectionRange?.(pos, pos);
  ta.dispatchEvent(new Event('input', { bubbles: true })); // autosize, the draft, the Auto preview
}

if (CAN_DICTATE) {
  addEventListener('wisp-dictation', (e) => {
    const { state, text = '', error = '' } = e.detail || {};
    if (!cur) return;
    if (state === 'listening') paint(cur.btn, true);
    else if ((state === 'partial' || state === 'final' || state === 'error') && text) put(text);
    if (state === 'error' && WHY[error]) toast(WHY[error], { tone: error === 'silence' ? '' : 'bad', timeout: error === 'blocked' ? 8000 : 4200 });
    if (state === 'end' || state === 'error') {
      paint(cur.btn, false);
      cur = null;
    }
  });
}
