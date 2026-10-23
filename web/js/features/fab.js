// The phone app (MOBILE) keeps the prompt box off the page: a floating New task button opens it as a
// sheet over the feed (responsive.css). Back, a tap outside it or sending the task closes it. What
// was typed stays as the draft, so closing it loses nothing.

import { $, el, icon } from '../core/dom.js';
import { MOBILE } from '../core/state.js';
import { onBack } from '../ui/back.js';

let backDone = null;
const isOpen = () => document.body.classList.contains('prompt-open');

export function openPrompt() {
  if (!MOBILE) return;
  if (!isOpen()) {
    document.body.classList.add('prompt-open');
    backDone = onBack(closePrompt);
  }
  $('#prompt')?.focus({ preventScroll: true });
}

export function closePrompt() {
  if (!MOBILE || !isOpen()) return;
  document.body.classList.remove('prompt-open');
  backDone?.();
  backDone = null;
  if (document.activeElement?.closest?.('#launcher')) document.activeElement.blur();
}

export function promptFab() {
  const fab = el(`<button class="prompt-fab" id="promptFab" type="button">${icon('plus')}<span>New task</span></button>`);
  fab.addEventListener('click', () => {
    openPrompt();
  });
  document.body.append(fab);
  // The dimmed page around the sheet: a tap there closes it (the sheet itself is #launcher).
  const slot = $('#launchSlot');
  slot.addEventListener('click', (e) => {
    if (e.target === slot) closePrompt();
  });
}
