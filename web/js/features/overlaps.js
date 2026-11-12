// Other open tasks in the same repo changing the same files (the server's `overlaps`): a pill on the
// card head, a warning above the follow-up box naming the task and the files, and a line in the
// Ship it and Merge dialogs, so two tasks that would clash aren't both approved blind.

import { esc } from '../md.js';
import { $, el, icon } from '../core/dom.js';
import { S, load, save } from '../core/state.js';
import { atTail, toEnd } from '../tail.js';
import { overlay } from '../ui/overlay.js';
import { expand, renderFeed, reveal, setFocus } from './feed.js';

// Dismissed strips, by task: what they said when closed. A new task, a new file or a new clash
// brings the strip back; the pill on the card head stays either way.
const DISMISSED = 'wisp.overlapsDismissed';
const said = (all) => JSON.stringify(all.map((o) => [o.id, o.files, o.more || 0, o.conflicts || null]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

const SHOWN = 2; // overlaps named in the follow-up's own words (the strip shows one); the rest are a click away

const titleOf = (o) => S.sessions.get(o.id)?.title || o.title || 'another task';
const clashes = (o) => !!o.conflicts?.length;
const list = (files, more = 0) => `${files.join(', ')}${more ? ` and ${more} more` : ''}`;

// One overlap in words: what merging both would do to these files.
function line(o) {
  if (clashes(o)) return `Merging both would conflict in ${list(o.conflicts)}`;
  return `Also changes ${list(o.files, o.more)}${o.conflicts ? ', but they merge cleanly' : ''}`;
}

export function overlapPill(s) {
  const all = s.overlaps;
  if (!all?.length || s.pending) return '';
  const clash = all.some(clashes);
  const tip = all.map((o) => `“${titleOf(o)}”: ${line(o)}`).join('\n');
  return `<span class="pill overlap${clash ? ' clash' : ''}" title="${esc(tip)}">${icon('merge')}<span class="ov-l">${clash ? 'Clash' : 'Overlap'}</span>${all.length > 1 ? `<span class="ov-n">×${all.length}</span>` : ''}</span>`;
}

// Clashes first: they're the ones to sort out before shipping.
const ranked = (s) => [...(s?.overlaps || [])].sort((x, y) => clashes(y) - clashes(x));
const row = (o, more = '') => `<div class="ov-row">${icon('merge')}
      <span class="ov-text"><b>${clashes(o) ? 'Clashes with' : 'Overlaps with'} “${esc(titleOf(o))}”</b> <span class="ov-files">${esc(line(o))}</span></span>
      ${more}<button class="ghost xs" data-ov="${esc(o.id)}" title="Open that task">Open</button></div>`;
function openTask(other) {
  if (!other || !S.sessions.has(other)) return;
  reveal(other);
  renderFeed();
  expand(other);
  setFocus(other);
}

// The warning above the follow-up box (in split view too): the first two overlapping tasks, each
// with Open, and "+ n more" for a dialog with all of them.
export function renderOverlapStrip(id) {
  const n = S.nodes.get(id);
  const node = n?.body && $('.overlap-strip', n.body);
  const s = S.sessions.get(id);
  if (!node || !s) return;
  let all = ranked(s);
  if (all.length && load(DISMISSED, {})[id] === said(all)) all = [];
  // It comes seconds after the run ends, in a dock that sticks to the bottom: it would cover the end
  // of the answer and, at 44px, put a reader at the tail past its slack (the next answer wouldn't land).
  const tail = node.hidden && !!all.length && atTail(n.body);
  node.hidden = !all.length;
  if (!all.length) return void (node.innerHTML = '');
  node.classList.toggle('clash', all.some(clashes));
  // One line: the first (a clash leads), and "+ n more" on it for the dialog with them all. Two rows
  // and a line under them took ~60px above the reply box, a quarter of a phone's screen.
  const rest = all.length - 1;
  const more = rest > 0 ? `<button class="link xs ov-more" data-ov-all title="All the tasks that change the same files">+${rest} more${all.slice(1).some(clashes) ? ', with clashes' : ''}</button>` : '';
  const x = `<button class="icon-btn xs ov-x" data-ov-x aria-label="Dismiss" title="Dismiss until something changes">${icon('x')}</button>`;
  node.innerHTML = row(all[0], more).replace(/<\/div>$/, `${x}</div>`);
  if (tail) toEnd(n.body);
  node.onclick = (e) => {
    // The card's own click handling mustn't see it: it would close the dialog as it opens.
    if (e.target.closest('[data-ov-all], [data-ov], [data-ov-x]')) e.stopPropagation();
    if (e.target.closest('[data-ov-x]')) {
      // Read afresh (another tab may have closed one), and forget tasks that are gone.
      const kept = Object.fromEntries(Object.entries(load(DISMISSED, {})).filter(([k]) => S.sessions.has(k)));
      save(DISMISSED, { ...kept, [id]: said(ranked(S.sessions.get(id))) });
      renderOverlapStrip(id);
      return;
    }
    if (e.target.closest('[data-ov-all]')) {
      overlapsDialog(id);
      return;
    }
    openTask(e.target.closest('[data-ov]')?.dataset.ov);
  };
}

// Every task this one overlaps, clashes first, each with Open.
export function overlapsDialog(id) {
  const all = ranked(S.sessions.get(id));
  if (!all.length) return;
  const n = all.filter(clashes).length;
  const node = el(`<div class="modal ov-modal">
      <header><h2>Changes the same files as ${all.length} task${all.length > 1 ? 's' : ''}</h2><button class="icon-btn close" aria-label="Close">${icon('x')}</button></header>
      <p class="hint">${n ? `${n} would conflict if both were merged. ` : ''}Only tasks in Working or Needs you count.</p>
      <div class="ov-list">${all.map(row).join('')}</div></div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  node.onclick = (e) => {
    const other = e.target.closest('[data-ov]')?.dataset.ov;
    if (!other) return;
    close();
    openTask(other);
  };
}

// For the Ship it and Merge dialogs: the same first two, then how many more, or ''.
export function overlapWarning(s) {
  const all = ranked(s);
  const rest = all.length - SHOWN;
  return [...all.slice(0, SHOWN).map((o) => `⚠ ${clashes(o) ? 'Clashes with' : 'Overlaps with'} “${titleOf(o)}”: ${line(o)}.`), ...(rest > 0 ? [`…and ${rest} more task${rest > 1 ? 's' : ''} (listed on the card).`] : [])].join('\n');
}
