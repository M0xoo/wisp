// The card a pane's write waits on: wisp's own markup in wisp's own modal layer, never in the
// frame. A pane can ask; only your click sends. App titles, task titles and prompts are written by
// whoever wrote the app, so all of it goes through esc(), and showInvisible() first: what you read
// is what's sent. A real invisible character gets a marker that typed-out "<U+202E>" doesn't.
//
// Questions and approvals are never restyled or hidden by spells (AGENTS.md), and this is one:
// it has no PARTS entry and must not get one.

import { esc } from '../md.js';
import { $, el, icon } from '../core/dom.js';
import { overlay } from '../ui/overlay.js';
import { showInvisible } from '../pane-bridge.js';

// Long enough that a click or key the pane timed for the moment it opens can't land on Send.
export const SEND_DELAY_MS = 600;

const clean = (v) => esc(showInvisible(v));
const unseen = (c) => showInvisible(c) !== c;
const marked = (v) => [...String(v ?? '')].map((c) => (unseen(c) ? `<span class="pc-inv">${clean(c)}</span>` : esc(c))).join('');
const count = (n) => `${n.toLocaleString('en-US')} character${n === 1 ? '' : 's'}`;

// spec: { head, rows: [[label, value, warn?]], prompt }. Resolves true on Send, false otherwise;
// rejects when a dialog of yours is open (overlay() would replace it): the pane can ask again.
export function paneCard({ head, rows, prompt }) {
  const o = $('#overlay');
  // One still fading out (.on is gone) is closed already: its node just hasn't left yet.
  if (!o.hidden && o.classList.contains('on')) return Promise.reject(new Error('wisp has a dialog open: close it, then try again.'));
  return new Promise((resolve) => {
    // Far down a long prompt a marker is out of sight, so the line above the box counts them.
    const hidden = [...prompt].filter(unseen).length;
    const node = el(`<div class="modal pane-card" role="alertdialog" aria-modal="true" aria-label="${clean(head)}" aria-describedby="pcFrom">
      <div class="pc-top">
        <header><h2>${marked(head)}</h2></header>
        <p class="pc-from" id="pcFrom">${icon('app')}<span>A pane wrote this, not you. Nothing happens until you press Send.</span></p>
        <dl class="pc-rows">${rows.map(([k, v, warn]) => `<div${warn ? ' class="pc-warn"' : ''}><dt>${esc(k)}</dt><dd>${warn ? icon('warn') : ''}<span>${marked(v)}</span></dd></div>`).join('')}</dl>
      </div>
      <div class="pc-label"><span>Prompt</span><span class="pc-len">${hidden ? `<span class="pc-hid">${hidden} invisible</span> · ` : ''}${count(prompt.length)}</span></div>
      <pre class="pc-prompt" tabindex="0" aria-label="Prompt">${marked(prompt)}</pre>
      <div class="pc-acts"><button class="ghost sm" data-a="no">Cancel</button><button class="primary sm" data-a="yes" disabled>Send</button></div>
    </div>`);
    const back = document.activeElement;
    const send = node.querySelector('[data-a="yes"]');
    let answer = false;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(arm);
      seen.disconnect();
      resolve(answer);
      if (back?.isConnected && back.tagName !== 'IFRAME') back.focus?.();
    };
    const close = overlay(node, { onClose: settle });
    const arm = setTimeout(() => {
      send.disabled = false;
    }, SEND_DELAY_MS);
    // A dialog you open on top (⌘K) replaces this one without closing it: that's a Cancel, or the
    // pane's call would wait for ever and no other card could open.
    const seen = new MutationObserver(() => {
      if (!node.isConnected) settle();
    });
    seen.observe(o, { childList: true });
    node.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      answer = a === 'yes';
      close();
    };
    node.querySelector('[data-a="no"]').focus();
  });
}
