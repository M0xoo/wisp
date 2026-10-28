// Feedback. Four ways in, none of them taking room: thumbs at the end of a turn's trail, "/feedback …"
// or "/bug …" in any prompt box, "Send feedback" in ⌘K, and a quiet line at the foot of home. It all goes to the wisp team (PostHog), with the
// run's harness, model and status but never the prompt or the result.

import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';

export const feedbackOn = () => S.config?.feedback !== false;
const FEEDBACK_CMD = /^\/(feedback|bug)(?:\s|$)/i;
export const isFeedback = (text) => FEEDBACK_CMD.test(text);
// A bug report or anything else (an idea, praise, a gripe): the team reads them in different places.
const KINDS = [
  ['idea', 'spark', 'Idea or thought', 'What works, what’s missing, what you wish it did…'],
  ['bug', 'bug', 'Something broke', 'What happened, and what did you expect? The steps to get there help most.'],
];
const THANKS = 'Thanks! Sent to the wisp team.';

// The box is already empty; `restore` puts the text back if the server refuses it.
export function feedbackCommand(text, { sessionId, restore } = {}) {
  if (!feedbackOn()) return (restore?.(), toast('Feedback is turned off on this install.', { tone: 'bad' }));
  const kind = text.match(FEEDBACK_CMD)[1].toLowerCase() === 'bug' ? 'bug' : undefined;
  const note = text.replace(FEEDBACK_CMD, '').trim();
  if (!note) return openFeedback({ sessionId, kind });
  postFeedback({ text: note, kind, sessionId, source: 'command' }, { onFail: restore });
}

// Optimistic: thanks at once. Offline, the server keeps it and sends it later.
function postFeedback(body, { onFail, quiet = false } = {}) {
  if (!quiet) toast(THANKS);
  return api('/feedback', { method: 'POST', body })
    .then((r) => {
      if (!r.sent && r.available !== false) toast('Saved: it goes out once wisp is back online.');
    })
    .catch((err) => {
      onFail?.();
      toastError(err);
    });
}

function paintRate(node, rating) {
  $('.rate', node)?.classList.toggle('rated', !!rating);
  $$('[data-rate]', node).forEach((b) => {
    b.classList.toggle('on', b.dataset.rate === rating);
    b.setAttribute('aria-pressed', b.dataset.rate === rating);
  });
}

export function rateTurn(s, t, node, rating) {
  const prev = t.feedback;
  t.feedback = rating ? { rating, at: Date.now() } : undefined;
  paintRate(node, rating);
  if (rating === 'up') {
    const tip = $('.rate', node);
    tip.classList.remove('thanked');
    void tip.offsetWidth; // restart the animation
    tip.classList.add('thanked');
  }
  postFeedback({ rating, sessionId: s.id, turnId: t.id, source: 'turn' }, {
    quiet: true,
    onFail: () => ((t.feedback = prev), paintRate(node, prev?.rating)),
  });
}

// After 👎: one optional line on what went wrong. The rating is already sent.
export function whyForm(s, t, close) {
  const f = el(`
    <form class="why">
      <textarea class="textarea" rows="2" placeholder="What went wrong? Optional, goes to the wisp team" maxlength="4000"></textarea>
      <div class="why-foot"><span class="muted xs">Sent with the harness and model, not your prompt or code.</span><button type="button" class="link xs" data-a="skip">Skip</button><button class="primary xs">Send</button></div>
    </form>`);
  const ta = $('textarea', f);
  f.onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return close();
    close();
    postFeedback({ rating: 'down', text, sessionId: s.id, turnId: t.id, source: 'turn' }, { onFail: () => openFeedback({ sessionId: s.id, text, rating: 'down' }) });
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), f.requestSubmit());
    if (e.key === 'Escape') (e.stopPropagation(), close());
  };
  $('[data-a="skip"]', f).onclick = () => {
    close();
    toast(THANKS);
  };
  requestAnimationFrame(() => ta.focus());
  return f;
}

export function openFeedback({ sessionId, text = '', rating = null, kind = 'idea', source = 'dialog' } = {}) {
  if (!feedbackOn()) return toast('Feedback is turned off on this install.', { tone: 'bad' });
  const node = el(`
    <form class="modal fb-modal">
      <header><h2>Send feedback</h2><button type="button" class="icon-btn close">${icon('x')}</button></header>
      <fieldset class="pk-seg fb-kind" role="radiogroup" aria-label="Kind">${KINDS.map(([k, i, label]) => `<button type="button" role="radio" data-kind="${k}">${icon(i)}${label}</button>`).join('')}</fieldset>
      <div class="fb-rate"><span>How is wisp working for you?</span>
        ${['up', 'down'].map((r) => `<button type="button" class="rate-btn" data-rate="${r}" aria-pressed="false" title="${r === 'up' ? 'Good' : 'Not good'}">${icon(`thumb-${r}`)}</button>`).join('')}
      </div>
      <textarea class="textarea" name="text" rows="5" maxlength="4000" placeholder="What works, what breaks, what you wish it did…"></textarea>
      <div class="ship-foot"><span class="muted xs">Goes to the wisp team with your wisp version and OS. Not your code or prompts. Tip: type <code>/feedback …</code> or <code>/bug …</code> in any prompt box.</span><button class="primary sm" data-a="send">${icon('send')}Send</button></div>
    </form>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const ta = $('textarea', node);
  const send = $('[data-a="send"]', node);
  ta.value = text;
  // A bug needs words; thumbs say nothing about one, so they step aside (and don't go out) and
  // a hint takes their row.
  const paint = () => {
    const bug = kind === 'bug';
    $$('[data-kind]', node).forEach((b) => {
      b.classList.toggle('on', b.dataset.kind === kind);
      b.setAttribute('aria-checked', b.dataset.kind === kind);
    });
    $('.fb-rate', node).classList.toggle('off', bug);
    $('.fb-rate span', node).textContent = bug ? 'One bug per report, so each one gets fixed.' : 'How is wisp working for you?';
    ta.placeholder = KINDS.find(([k]) => k === kind)[3];
    paintRate(node, rating);
    send.disabled = (bug || !rating) && !ta.value.trim();
  };
  $$('[data-kind]', node).forEach((b) => {
    b.onclick = () => {
      kind = b.dataset.kind;
      paint();
      ta.focus();
    };
  });
  $$('[data-rate]', node).forEach((b) => {
    b.onclick = () => {
      rating = rating === b.dataset.rate ? null : b.dataset.rate;
      paint();
    };
  });
  ta.oninput = paint;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.preventDefault(), node.requestSubmit());
  };
  node.onsubmit = (e) => {
    e.preventDefault();
    const note = ta.value.trim();
    const bug = kind === 'bug';
    if ((bug || !rating) && !note) return;
    close();
    const body = { rating: (!bug && rating) || undefined, text: note, kind: bug ? 'bug' : undefined, sessionId, source };
    postFeedback(body, { onFail: () => openFeedback({ sessionId, text: note, rating, kind, source }) });
  };
  paint();
  requestAnimationFrame(() => ta.focus());
}
