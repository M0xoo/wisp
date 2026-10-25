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
}
