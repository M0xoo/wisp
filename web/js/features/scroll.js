// The page scrolls inside #stage, under a sticky top bar and the launcher, which docks there once
// it scrolls away. Everything that moves the page on a card's behalf goes through here.
// In split view (features/split.js) the stage stands still: the task list scrolls in the sidebar
// and the open task in its own body, so the same calls move those instead.

import { $, $$ } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';

export const stage = $('#stage');

const split = () => document.body.classList.contains('split');
const sideBox = () => $('#feedWrap');
// The open task's body, the main pane's scroller in split view.
const mainBox = () => (split() ? $('#feed .item.open > .it-body') : null);

// How much of the feed the sticky top bar and docked launcher cover: the stage's scroll-padding-top,
// which scrollIntoView already honours, so hand-placed cards line up with scrolled-to ones.
// In split view: where the open task's body starts showing, under its sticky bar.
export function topInset() {
  const box = mainBox();
  if (box) return box.getBoundingClientRect().top + barCover(box);
  return parseFloat(getComputedStyle(stage).scrollPaddingTop) || 0;
}

// How much of an open split-view body its sticky bar covers: on a narrow pane, its height; on a wide
// one nothing, the bar is the details column beside the task (and has no height of its own).
export const barCover = (body) => $('.it-bar', body)?.offsetHeight || 0;

// Whether the user is reading a card, not just catching its edge at the top or bottom of the
// screen: it crosses the middle of the viewport, or it's focused and a fair share of it shows.
// Anything that moves the page on a card's behalf asks this first.
export function watching(id) {
  const card = S.nodes.get(id)?.card;
  if (!card?.isConnected) return false;
  if (split()) return S.open.has(id); // the open task fills the main pane
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
  if (top === null || !card.isConnected) return;
  const dy = card.getBoundingClientRect().top - top;
  // Split view: the card's head is a row in the sidebar, so the sidebar holds it still.
  if (split()) Math.abs(dy) >= 1 && (sideBox().scrollTop += dy);
  else scrollByPx(dy);
}

// A re-render that moves a card the user is watching (a follow-up sends it to Working): the view
// follows it. In split view that card is the open task's row in the sidebar, and if it lands where
// it still shows, the list stays where it was rather than scrolling to it.
export function keepFollowing(card, change) {
  if (!split() || !card?.isConnected) return keepInPlace(card, change);
  const top = card.getBoundingClientRect().top;
  keepInPlace(feedAnchor(card.dataset.id), change);
  if (!card.isConnected) return;
  const box = sideBox().getBoundingClientRect();
  const r = card.getBoundingClientRect();
  if (r.top >= box.top + ($('#splitTop')?.offsetHeight || 0) && r.bottom <= box.bottom) return;
  sideBox().scrollTop += r.top - top;
}

// Any write to scrollTop cancels a smooth scroll in flight (j/k, Open, a launch), so only
// write when there's an actual shift to undo.
export function scrollByPx(dy) {
  if (Math.abs(dy) >= 1) (mainBox() || stage).scrollTop += dy;
}

// The card to hold still while the feed changes around it: the first one showing under the top
// bar and docked launcher, skipping `id` (the card that's changing). None at the very top of the page, where new
// cards should push the list down, or when `id` itself is the top card on screen: then the next
// one should slide up into its place.
export function feedAnchor(id) {
  const box = split() ? sideBox() : stage;
  if (box.scrollTop < 1) return null;
  const moving = id && S.nodes.get(id)?.card;
  const inset = split() ? box.getBoundingClientRect().top + ($('#splitTop')?.offsetHeight || 0) : topInset();
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
  // The phone keeps it docked at the bottom, in reach of a thumb (responsive.css), from the start.
  const gone = MOBILE || launchSlot.getBoundingClientRect().bottom < $('#topbar').offsetHeight;
  if (gone === box.classList.contains('docked')) return;
  launchSlot.style.height = gone && !MOBILE ? `${box.offsetHeight}px` : '';
  box.classList.toggle('docked', gone);
};

export const backToTop = () => (mainBox() || (split() ? sideBox() : stage)).scrollTo({ top: 0, behavior: 'smooth' });

// Sticky top bar gets a hairline once the page scrolls; "back to top" shows after a screen's worth.
export function onScroll() {
  $('#topbar').classList.toggle('scrolled', stage.scrollTop > 4);
  dockLauncher();
  toTop.hidden = stage.scrollTop < stage.clientHeight * 0.75;
}
