// Tips under the prompt box: a few at a time, from a long list that rotates on every visit (and on
// "More tips"), each opening the trywisp.dev guide that explains it. Split view's home only, under
// Needs you: not in the feed, where the tasks are, nor on a phone. A spell restyles or hides them
// through the `tips` part and sets how many show with its `count` prop.

import * as bus from '../core/bus.js';
import { $$, icon } from '../core/dom.js';
import { load, MOBILE, save } from '../core/state.js';
import { TIPS } from '../tips-data.js';
import { spellProp } from './spells.js';

const AT = 'wisp.tipsAt'; // where the last set started, so a reload shows the next ones
let at = 0;

function count() {
  return Math.max(1, Math.min(spellProp('tips', 'count') || 3, TIPS.length));
}

// Turn the list on: a new set each time the page loads.
function start() {
  at = (load(AT, -count()) + count()) % TIPS.length;
  save(AT, at);
}

function html() {
  const n = count();
  const items = Array.from({ length: n }, (_, i) => TIPS[(at + i) % TIPS.length])
    .map(([text, href]) => `<a class="tip" href="${href}" target="_blank" rel="noopener">${icon('spark')}<span>${text}</span>${icon('external', 'tip-go')}</a>`)
    .join('');
  return `<h4>Tips<button class="tip-more" title="Show other tips">More tips</button></h4>${items}`;
}

export function paintTips() {
  const out = MOBILE ? '' : html();
  for (const box of $$('.tips')) {
    // Only when they changed: a repaint on every feed render would replay hover and focus.
    if (box.dataset.h !== out) (box.innerHTML = out), (box.dataset.h = out);
    box.hidden = !out;
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.tips .tip-more')) return;
  at = (at + count()) % TIPS.length;
  save(AT, at);
  paintTips();
});

start();
paintTips();
bus.on('spells', paintTips);
