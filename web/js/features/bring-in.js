// Bring in (server/services/bring-in.js): one quiet line in the launcher when the project it points
// at has worktrees another tool left. It sits over the recipes row, so nothing moves when it comes
// or goes. wisp asks about the project picked and only that one, once, on this computer: finding
// them runs a git per worktree, and wisp never goes looking on its own.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { popover, refocus } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { renderFeed, reveal } from './feed.js';
import { goBack, isStacked, splitOpen, stackPage } from './split.js';

const NONE = { from: '', items: [], detached: 0 };
const SLOW = 900; // ms before Bring in says it's still at it: it can wait on one fetch, about 20 s

const offers = new Map(); // project id -> what the server last said
const asks = new Map(); // project id -> the newest ask: an older answer is dropped
const held = new Set(); // projects whose line was just answered: it stays away until the server has
const brought = new Map(); // task id -> project id, for the tasks that came this way
let want = null; // the project the launcher points at, when it's one that can have an offer
let seq = 0;
let faded = null; // the project whose line has had its fade: a repaint must not play it again

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const worktrees = (n) => plural(n, 'worktree');

async function ask(id) {
  const n = ++seq;
  asks.set(id, n);
  const offer = await api(`/projects/${id}/foreign-worktrees`).catch(() => NONE);
  if (asks.get(id) !== n) return;
  offers.set(id, offer);
  paintBringIn();
}

// What's known has changed: the project showing asks again, any other does when it's next picked.
function askAgain(id) {
  if (id === want) return ask(id);
  asks.delete(id);
  offers.delete(id);
}

// launcher.js, on every paint of its chips: p is the project picked, null when it can't have one.
export function bringInFor(p) {
  want = p?.id || null;
  if (want && !asks.has(want)) ask(want);
  paintBringIn();
}

// What the line leaves to its tip: how they stand, and which branches.
const MAX_LISTED = 8;
function facts({ items, detached }) {
  const dirty = items.filter((x) => x.dirty).length;
  const chats = items.filter((x) => x.chat).length;
  const left = items.length - MAX_LISTED;
  return {
    said: [dirty && `${dirty} with uncommitted changes`, chats && `${plural(chats, 'chat')} to resume`].filter(Boolean).join(', '),
    branches: [...items.slice(0, MAX_LISTED).map((x) => x.branch), ...(left > 0 ? [`and ${left} more`] : [])],
    stuck: detached ? `${detached} with no branch can’t be brought in` : '',
  };
}
function tip(offer) {
  const { said, branches, stuck } = facts(offer);
  return [said, ...branches, stuck].filter(Boolean).join('\n');
}

// A tip for the keyboard and for a finger, which have no hover.
function showTip(anchor, offer) {
  const { said, branches, stuck } = facts(offer);
  const r = anchor.getBoundingClientRect();
  const menu = el(`<div class="menu bring-tip" style="top:${r.bottom + 6}px;left:${r.left}px">${said ? `<p>${esc(said)}</p>` : ''}${branches.map((x) => `<code>${esc(x)}</code>`).join('')}${stuck ? `<p>${esc(stuck)}</p>` : ''}</div>`);
  popover(menu, { anchor });
}

export function paintBringIn() {
  const box = $('#launcher');
  const line = box && $('.l-bring', box);
  if (!line) return;
  const offer = want && !held.has(want) ? offers.get(want) : null;
  // Typing, the row is the recipes': Save as recipe sits there. The line comes back on an empty box.
  const typing = !!$('#prompt', box)?.value.trim();
  const n = typing ? 0 : offer?.items.length || 0;
  const html = n
    ? `<button type="button" class="l-bring-n" aria-haspopup="dialog" title="${esc(tip(offer))}">${icon('branch')}<span>${esc(`${worktrees(n)} from ${offer.from}`)}</span></button><button type="button" class="ghost xs l-bring-take" data-a="take">Bring in</button><button type="button" class="ghost xs l-bring-skip" data-a="skip">Not now</button>`
    : '';
  // Compared: a live refresh must leave the buttons alone, one may be under the pointer.
  if (line.dataset.h !== html) (line.innerHTML = html), (line.dataset.h = html);
  line.hidden = !n;
  if (n && faded !== want) {
    faded = want;
    line.classList.add('fresh');
    line.onanimationend = () => {
      line.classList.remove('fresh');
    };
  }
  if (!offer?.items.length) faded = null;
  line.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !offer) return;
    if (b.dataset.a === 'take') take(want, offer);
    else if (b.dataset.a === 'skip') skip(want, offer);
    else showTip(b, offer);
  };
  // A spell may hide the line: then the recipes it would have covered stay.
  box.classList.toggle('bring-on', !!n && getComputedStyle(line).display !== 'none');
}

// The list has them, even if the live stream hasn't said so yet.
function listed(tasks) {
  for (const t of tasks) if (!S.sessions.has(t.id)) S.sessions.set(t.id, t);
  for (const t of tasks) brought.set(t.id, t.projectId);
  renderFeed();
}

function broughtToast(tasks, missed) {
  const done = tasks.length ? `Brought in ${worktrees(tasks.length)}` : '';
  const miss = missed.length ? `${worktrees(missed.length)} didn’t come: ${missed[0].why}` : '';
  toast(esc(done && miss ? `${done}. ${miss}` : done || miss), { tone: done ? '' : 'bad', ...(miss && { timeout: 10_000 }) });
}

async function take(id, offer) {
  if (held.has(id)) return; // a double click: the first one has it
  held.add(id);
  paintBringIn();
  refocus($('#prompt'));
  const n = offer.items.length;
  let still = null;
  const slow = setTimeout(() => {
    still = toast(`Bringing in ${worktrees(n)}…`, { timeout: 30_000 });
  }, SLOW);
  const quiet = () => (clearTimeout(slow), still?.remove());
  let r;
  try {
    r = await api(`/projects/${id}/foreign-worktrees`, { method: 'POST', body: { paths: offer.items.map((x) => x.path) } });
  } catch (err) {
    quiet();
    held.delete(id);
    paintBringIn();
    toastError(err);
    return;
  }
  quiet();
  listed(r.tasks);
  broughtToast(r.tasks, r.missed);
  await askAgain(id);
  held.delete(id);
  paintBringIn();
  // One opens, unless you've moved on to something else while it came. Several stay in the list,
  // which on a phone is the page behind this one (as after Send).
  if (r.tasks.length === 1 && !splitOpen()) reveal(r.tasks[0].id);
  else if (r.tasks.length > 1 && isStacked() && stackPage() && !splitOpen()) goBack();
}

async function skip(id, offer) {
  if (held.has(id)) return;
  held.add(id);
  paintBringIn();
  refocus($('#prompt'));
  const n = offer.items.length;
  const url = `/projects/${id}/foreign-worktrees/dismiss`;
  const asked = api(url, { method: 'POST', body: {} });
  let undone = false;
  toast(n === 1 ? 'Won’t offer this worktree again' : `Won’t offer these ${n} worktrees again`, {
    action: {
      label: 'Undo',
      run: async () => {
        undone = true;
        const answer = await asked.catch(() => null);
        if (!answer) return; // it never went: the line is already back
        asks.set(id, ++seq); // an answer on its way is from before this
        offers.set(id, offer);
        held.delete(id);
        paintBringIn();
        try {
          await api(url, { method: 'POST', body: { undo: answer.paths || offer.items.map((x) => x.path) } });
        } catch (err) {
          offers.set(id, NONE);
          paintBringIn();
          toastError(err);
        }
        askAgain(id);
      },
    },
    timeout: 8000,
  });
  try {
    await asked;
  } catch (err) {
    held.delete(id);
    paintBringIn();
    toastError(err);
    return;
  }
  if (undone) return;
  await askAgain(id);
  held.delete(id);
  paintBringIn();
}

// A task that came this way, deleted: its worktree can be offered again.
const note = () => {
  for (const s of S.sessions.values()) if (s.foreign) brought.set(s.id, s.projectId);
};
bus.on('listed', note);
bus.on('summary', (id) => {
  const s = S.sessions.get(id);
  if (s?.foreign) brought.set(id, s.projectId);
  if (s || !brought.has(id)) return;
  const project = brought.get(id);
  brought.delete(id);
  if (asks.has(project)) askAgain(project);
});
bus.on('spells', paintBringIn);
