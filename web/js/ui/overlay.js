import { $ } from '../core/dom.js';
import { sweep } from '../core/bus.js';

// The one modal layer (#overlay). Opening a dialog replaces whatever it showed.
export function overlay(node, { onClose } = {}) {
  const o = $('#overlay');
  o.innerHTML = '';
  o.append(node);
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('on'));
  const close = () => {
    o.classList.remove('on');
    // Another overlay may have replaced this one while it faded (palette → settings): leave that alone.
    setTimeout(() => {
      if (o.firstChild === node) (o.hidden = true), (o.innerHTML = '');
      sweep();
    }, 200);
    onClose?.();
  };
  // A block body: an on* handler that returns false cancels the click, which would stop every
  // submit button inside the dialog from submitting its form.
  o.onclick = (e) => {
    if (e.target === o) close();
  };
  o.close = close;
  return close;
}

export const closeOverlay = () => !$('#overlay').hidden && $('#overlay').close?.();

// A view opens as its own dialog, or inside another one (Settings) that hands it a host.
// Returns what closes it for good: the whole overlay either way.
export function present(node, host) {
  if (host) return host(node);
  const close = overlay(node);
  $('.close', node).onclick = close;
  return close;
}
