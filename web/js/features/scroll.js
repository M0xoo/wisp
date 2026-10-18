// The page scrolls inside #stage, under a sticky top bar and the launcher, which docks there once
// it scrolls away. Everything that moves the page on a card's behalf goes through here.

import { $, $$ } from '../core/dom.js';
import { S } from '../core/state.js';

export const stage = $('#stage');

// How much of the feed the sticky top bar and docked launcher cover: the stage's scroll-padding-top,
// which scrollIntoView already honours, so hand-placed cards line up with scrolled-to ones.
export const topInset = () => parseFloat(getComputedStyle(stage).scrollPaddingTop) || 0;

// Whether the user is reading a card, not just catching its edge at the top or bottom of the
// screen: it crosses the middle of the viewport, or it's focused and a fair share of it shows.
// Anything that moves the page on a card's behalf asks this first.
export function watching(id) {
  const card = S.nodes.get(id)?.card;
  if (!card?.isConnected) return false;
  const r = card.getBoundingClientRect();
  const mid = innerHeight / 2;
  if (r.top <= mid && r.bottom >= mid) return true;
  const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return S.focus === id && shown >= Math.min(r.height, innerHeight) / 3;
}

// Run a DOM change without moving `card` on screen. The browser's own scroll anchoring misses
// cards that are moved between lists, so feed re-renders do this explicitly.
export function keepInPlace(card, change) {
  const top = card?.isConnected ? card.getBoundingClientRect().top : null;
  change();
  if (top !== null && card.isConnected) scrollByPx(card.getBoundingClientRect().top - top);
}

// Any write to scrollTop cancels a smooth scroll in flight (j/k, Open, a launch), so only
// write when there's an actual shift to undo.
export function scrollByPx(dy) {
  if (Math.abs(dy) >= 1) stage.scrollTop += dy;
}

// The card to hold still while the feed changes around it: the first one showing under the top
// bar and docked launcher, skipping `id` (the card that's changing). None at the very top of the page, where new
// cards should push the list down, or when `id` itself is the top card on screen: then the next
// one should slide up into its place.
export function feedAnchor(id) {
  if (stage.scrollTop < 1) return null;
  const moving = id && S.nodes.get(id)?.card;
  const inset = topInset();
  for (const card of $$('#feed .item')) {
    const r = card.getBoundingClientRect();
    if (r.bottom > inset) return card === moving ? null : card;
  }
  return null;
}

const toTop = $('#toTop');

// Once the launcher scrolls under the top bar it docks there, folded to one line. The slot keeps
// its full height in the feed so docking never shifts what you're reading.
const launchSlot = $('#launchSlot');
const dockLauncher = () => {
  const box = $('#launcher');
  const gone = launchSlot.getBoundingClientRect().bottom < $('#topbar').offsetHeight;
  if (gone === box.classList.contains('docked')) return;
  launchSlot.style.height = gone ? `${box.offsetHeight}px` : '';
  box.classList.toggle('docked', gone);
};

export const backToTop = () => stage.scrollTo({ top: 0, behavior: 'smooth' });

// Sticky top bar gets a hairline once the page scrolls; "back to top" shows after a screen's worth.
export function onScroll() {
  $('#topbar').classList.toggle('scrolled', stage.scrollTop > 4);
  dockLauncher();
  toTop.hidden = stage.scrollTop < stage.clientHeight * 0.75;
}
