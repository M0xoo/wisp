// The page-wide key bindings. Popovers handle their own Escape first (ui/popover.js).

import { $, $$ } from '../core/dom.js';
import { isForLater, S } from '../core/state.js';
import { modKey, shortcuts } from '../ui/kbd.js';
import { closeOverlay } from '../ui/overlay.js';
import { deleteSession, forkable, forkTask, rename, rerun, setArchived, setForLater, takeOver, toggleDone } from './actions.js';
import { openPalette } from './commands.js';
import { collapseAll, expand, feedIds, setFocus, toggle } from './feed.js';
import { focusLauncher } from './launcher.js';
import { backToTop } from './scroll.js';
import { shipDialog, shippable } from './ship.js';
import { toggleTranscript } from './turns.js';
import { activeSpells, runAction } from './spells.js';
import { goBack, splitOpen, stackPage, toggleSidebar } from './split.js';
import { openPanel, reviewLabel, shellKey, toggle as togglePanel } from './panel.js';

// Keys wisp uses itself (with or without Shift), which spells can't claim.
const BUILT_IN = new Set(['n', 'j', 'k', 'o', 'enter', 'e', 'a', 'l', 'c', 'u', 'home', 'm', 'delete', 'backspace', 't', 'shift+r', 'shift+f', 's', 'r', 'v', '/', '?', 'shift+?', 'escape', '\\', '[', ']', 'p', ...'123456789'.split('')]);

export function onKey(e) {
  // ⌘K / Ctrl+K works from anywhere, even mid-sentence in the launcher.
  if (modKey(e, 'k')) {
    e.preventDefault();
    return openPalette();
  }
  // ⌘L / Ctrl+L jumps to the launcher from anywhere, including another composer.
  if (modKey(e, 'l')) {
    e.preventDefault();
    if (!$('#overlay').hidden) closeOverlay();
    return focusLauncher();
  }
  // ⌃` (Ctrl on every computer): into the task's shell from anywhere, and from it back to the reply box.
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) {
    e.preventDefault();
    return shellKey();
  }
  const typing = e.target.closest('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape') {
    if (!$('#overlay').hidden) return $('#overlay .sx-back') ? $('#overlay .sx-back').click() : closeOverlay();
    if (typing) return e.target.blur();
    // A crew job → its member's thread → home (stacked: the list).
    if (S.crewOpen || splitOpen() || stackPage()) goBack();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('#overlay').hidden) return;
  const k = e.key.toLowerCase();
  const id = S.focus && S.nodes.has(S.focus) ? S.focus : null;
  // A spell's key (only keys wisp doesn't use itself: spells can't take over built-in ones).
  const combo = `${e.shiftKey ? 'shift+' : ''}${k}`;
  if (!BUILT_IN.has(combo)) {
    for (const spell of activeSpells()) {
      const c = [...(spell.commands || []), ...(spell.buttons || [])].find((x) => x.key && x.key.toLowerCase() === combo);
      if (c) {
        e.preventDefault();
        return runAction(spell, c.do, { session: id });
      }
    }
  }
  if (k === 'n') {
    e.preventDefault();
    focusLauncher();
  } else if (k === 'j' || k === 'k') {
    const ids = feedIds();
    if (!ids.length) return;
    const i = ids.indexOf(id);
    const next = i < 0 ? ids[0] : ids[k === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)];
    setFocus(next);
    expand(next, { scroll: false }); // moving opens the task beside the list
  } else if ((k === 'o' || (k === 'enter' && !e.target.closest('button, a'))) && id) {
    e.preventDefault();
    toggle(id);
  } else if (k === 'e' && id) {
    e.preventDefault(); // done goes to New task, which focuses the prompt: the E mustn't land in it
    toggleDone(id);
  } else if (k === 'a' && id) {
    e.preventDefault();
    const s = S.sessions.get(id);
    if (s && (s.archived || (s.state !== 'running' && s.state !== 'waiting'))) setArchived(id, !s.archived);
  }
  else if (k === 'l' && id) setForLater(id, !isForLater(S.sessions.get(id)));
  else if (k === 'c' && S.open.size) collapseAll();
  else if (k === 'u' || k === 'home') {
    e.preventDefault();
    backToTop();
  }
  else if (k === 'm' && id) {
    e.preventDefault();
    rename(id);
  } else if ((k === 'delete' || k === 'backspace') && id) {
    e.preventDefault();
    deleteSession(id);
  } else if (k === 't' && id) takeOver(id);
  else if (k === 'r' && e.shiftKey && id) rerun(id);
  else if (k === 'f' && e.shiftKey && id && forkable(S.sessions.get(id))) forkTask(id);
  else if (k === 's' && id && shippable(S.sessions.get(id))) shipDialog(id);
  else if (k === 'v' && id) toggleTranscript(id);
  else if (k === '/' && id) {
    e.preventDefault();
    const focusReply = () => $('.reply', S.nodes.get(id)?.card)?.focus();
    if (S.open.has(id)) focusReply();
    else expand(id).then(focusReply);
  } else if (k === '?') shortcuts();
  else if (k === '[') toggleSidebar();
  else if (k === ']' && (splitOpen() || id)) togglePanel();
  else if (k === 'p' && id && reviewLabel(S.sessions.get(id))) openPanel(id, 'pr');
  else if (/^[1-9]$/.test(k) && id && S.open.has(id)) {
    const card = S.nodes.get(id).card;
    const opts = $$('.ask-card .opt', card).length ? $$('.ask-card .opt', card) : $$('.turn:last-child .b-question:not(.answered) .opt:not(.own)', card);
    opts[Number(k) - 1]?.click();
  }
}
