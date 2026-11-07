// The phone app (MOBILE): New task floats over the task list, in reach of a thumb (responsive.css).
// It opens home, the prompt box, as a page of its own over the list (split.js goHome); Back, or
// sending the task, goes back to the list. What was typed stays as the draft.

import { el, icon } from '../core/dom.js';
import { goHome } from './split.js';

export function promptFab() {
  const fab = el(`<button class="prompt-fab" id="promptFab" type="button">${icon('plus')}<span>New task</span></button>`);
  fab.addEventListener('click', () => {
    goHome();
  });
  document.body.append(fab);
  giveWay(fab);
}

// A question answered from its row (feed.js rowChoices) needs the person: while any row's choices
// are on screen the button gives way, so it never sits on a Yes (design/ux.md, Never in the way).
// Rows repaint their head only when it changes, so the observer sees new choices rarely.
function giveWay(fab) {
  const feed = document.getElementById('feed');
  if (!feed || !('IntersectionObserver' in window)) return;
  const seen = new Set();
  const watched = new Set();
  const paint = () => {
    const away = seen.size > 0;
    if (fab.classList.contains('away') !== away) fab.classList.toggle('away', away);
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) seen.add(en.target);
      else seen.delete(en.target);
    }
    paint();
  });
  const sync = () => {
    const now = new Set(feed.querySelectorAll('.it-choices'));
    for (const c of watched) {
      if (now.has(c)) continue;
      io.unobserve(c);
      watched.delete(c);
      seen.delete(c);
    }
    for (const c of now) {
      if (watched.has(c)) continue;
      watched.add(c);
      io.observe(c);
    }
    paint();
  };
  new MutationObserver(sync).observe(feed, { childList: true, subtree: true });
  sync();
}
