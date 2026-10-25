// Other open tasks in the same repo changing the same files (the server's `overlaps`): a pill on the
// card head, a warning above the follow-up box naming the task and the files, and a line in the
// Ship it and Merge dialogs, so two tasks that would clash aren't both approved blind.

import { esc } from '../md.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { expand, renderFeed, reveal, setFocus } from './feed.js';

const SHOWN = 2; // rows on the card; the rest are a click away, so the warning stays small

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
  return `<span class="pill overlap${clash ? ' clash' : ''}" title="${esc(tip)}">${icon('merge')}<span class="ov-l">${clash ? 'Clash' : 'Overlap'}${all.length > 1 ? ` ×${all.length}` : ''}</span></span>`;
}

// Clashes first: they're the ones to sort out before shipping.
const ranked = (s) => [...(s?.overlaps || [])].sort((x, y) => clashes(y) - clashes(x));
const row = (o) => `<div class="ov-row">${icon('merge')}
      <span class="ov-text"><b>${clashes(o) ? 'Clashes with' : 'Overlaps with'} “${esc(titleOf(o))}”</b> <span class="ov-files">${esc(line(o))}</span></span>
      <button class="ghost xs" data-ov="${esc(o.id)}" title="Open that task">Open</button></div>`;
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
  const all = ranked(s);
  node.hidden = !all.length;
  if (!all.length) return void (node.innerHTML = '');
  node.classList.toggle('clash', all.some(clashes));
  const rest = all.length - SHOWN;
  node.innerHTML = all.slice(0, SHOWN).map(row).join('') + (rest > 0 ? `<button class="link xs ov-more" data-ov-all>+ ${rest} more task${rest > 1 ? 's' : ''}${all.slice(SHOWN).some(clashes) ? ', with clashes' : ''}</button>` : '');
  node.onclick = (e) => {
    // The card's own click handling mustn't see it: it would close the dialog as it opens.
    if (e.target.closest('[data-ov-all], [data-ov]')) e.stopPropagation();
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
