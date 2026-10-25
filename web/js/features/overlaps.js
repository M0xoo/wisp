// Other open tasks in the same repo changing the same files (the server's `overlaps`): a pill on the
// card head, a warning above the follow-up box naming the task and the files, and a line in the
// Ship it and Merge dialogs, so two tasks that would clash aren't both approved blind.

import { esc } from '../md.js';
import { $, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { expand, renderFeed, reveal, setFocus } from './feed.js';

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

// The warning above the follow-up box (in split view too): one row per overlapping task, with Open.
export function renderOverlapStrip(id) {
  const n = S.nodes.get(id);
  const node = n?.body && $('.overlap-strip', n.body);
  const s = S.sessions.get(id);
  if (!node || !s) return;
  const all = s.overlaps || [];
  node.hidden = !all.length;
  if (!all.length) return void (node.innerHTML = '');
  node.classList.toggle('clash', all.some(clashes));
  node.innerHTML = all
    .map(
      (o) => `<div class="ov-row">${icon('merge')}
      <span class="ov-text"><b>${clashes(o) ? 'Clashes with' : 'Overlaps with'} “${esc(titleOf(o))}”</b> <span class="ov-files">${esc(line(o))}</span></span>
      <button class="ghost xs" data-ov="${esc(o.id)}" title="Open that task">Open</button></div>`,
    )
    .join('');
  node.onclick = (e) => {
    const other = e.target.closest('[data-ov]')?.dataset.ov;
    if (!other || !S.sessions.has(other)) return;
    reveal(other);
    renderFeed();
    expand(other);
    setFocus(other);
  };
}

// For the Ship it and Merge dialogs: one warning per overlapping task, or ''.
export function overlapWarning(s) {
  return (s?.overlaps || []).map((o) => `⚠ ${clashes(o) ? 'Clashes with' : 'Overlaps with'} “${titleOf(o)}”: ${line(o)}.`).join('\n');
}
