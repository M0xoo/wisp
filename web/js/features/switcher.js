// ⌃Tab: back to the task you had open before, like switching apps. A tap jumps there; with Ctrl held
// each Tab steps through the tasks, latest first, and letting go opens the one picked. Chrome keeps
// ⌃Tab for its own tabs and never sends it to a page, so this is the desktop app's.

import { $, el } from '../core/dom.js';
import { S } from '../core/state.js';
import { esc } from '../md.js';
import { taskSub } from './commands.js';
import { feedIds, reveal } from './feed.js';
import { inProject } from './places.js';
import { splitOpen } from './split.js';

const MAX = 20; // the last ones you were on: older work is ⌘K's
const SHOW_AFTER = 130; // ms: a tap is over by then, and draws nothing

let sw = null; // { ids, sel, from, node, timer, reply }

const fits = (id) => {
  const s = S.sessions.get(id);
  return !!s && !s.archived && !s.pending && !S.deleting.has(id) && (S.filter === 'all' || inProject(s, S.filter));
};

function start(back) {
  // The task on screen: not one left open under My Stuff, Crew or a plan.
  const from = splitOpen();
  const ids = [...new Set([from, ...S.recent, ...feedIds()])].filter(fits).slice(0, MAX);
  const at = from && ids[0] === from ? 0 : -1;
  if (!ids.length || (ids.length === 1 && at === 0)) return;
  const n = ids.length;
  sw = { ids, from, sel: back ? (at + n) % n : (at + 1) % n, node: null, reply: !!document.activeElement?.closest('.reply, #prompt') };
  sw.timer = setTimeout(show, SHOW_AFTER);
}

function show() {
  clearTimeout(sw.timer);
  if (sw.node) return;
  const rows = sw.ids.map((id, i) => {
    const s = S.sessions.get(id);
    return `<div class="pal-row" role="option" data-i="${i}" aria-selected="false"><span class="pal-lead"><i class="p-dot c-${esc(s.color)}"></i></span><span class="pal-label">${esc(s.title)}</span><span class="pal-sub">${esc(taskSub(s))}</span></div>`;
  });
  sw.node = el(`<div class="palette switcher"><div class="pal-list" role="listbox" aria-label="Switch task">${rows.join('')}</div>
    <footer class="pal-foot"><span><kbd>Tab</kbd> next</span><span><kbd>⇧</kbd><kbd>Tab</kbd> back</span><span><kbd>esc</kbd> stay here</span></footer></div>`);
  sw.node.addEventListener('click', onPick);
  // Ctrl+click is a right-click on a Mac: it never sends a click.
  sw.node.addEventListener('contextmenu', onPick);
  document.body.append(sw.node);
  paint();
}

function onPick(e) {
  e.preventDefault();
  const r = e.target.closest('.pal-row');
  if (r) {
    sw.sel = Number(r.dataset.i);
    finish(true);
  }
}

function paint() {
  if (!sw.node) return;
  sw.node.querySelectorAll('.pal-row').forEach((r, i) => {
    r.classList.toggle('on', i === sw.sel);
    r.setAttribute('aria-selected', i === sw.sel);
  });
  $('.pal-row.on', sw.node).scrollIntoView({ block: 'nearest' });
}

function move(by) {
  sw.sel = (sw.sel + by + sw.ids.length) % sw.ids.length;
  show();
  paint();
}

async function finish(open) {
  const { ids, sel, from, node, timer, reply } = sw;
  sw = null;
  clearTimeout(timer);
  node?.remove();
  const id = ids[sel];
  if (!open || id === from || !S.sessions.has(id)) return;
  await reveal(id);
  // You were writing: carry on writing, in the task you came to.
  if (reply) $('.reply', S.nodes.get(id)?.card)?.focus();
}

// On the window, before anything else: a terminal or a text box keeps most keys to itself.
function onDown(e) {
  if (!sw) {
    if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if ($('#overlay').hidden) start(e.shiftKey);
    return;
  }
  if (e.key === 'Control') return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Tab') move(e.shiftKey ? -1 : 1);
  else if (e.key === 'ArrowDown') move(1);
  else if (e.key === 'ArrowUp') move(-1);
  else if (e.key === 'Enter') finish(true);
  else if (e.key === 'Escape') finish(false);
}

function onUp(e) {
  if (sw && e.key === 'Control') finish(true);
}

export function initSwitcher() {
  addEventListener('keydown', onDown, true);
  addEventListener('keyup', onUp, true);
  // Ctrl let go in another window never reaches this one.
  addEventListener('blur', () => {
    if (sw) finish(false);
  });
}
