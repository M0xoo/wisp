// The page-wide key bindings. Popovers handle their own Escape first (ui/popover.js).

import { $, $$ } from '../core/dom.js';
import { S } from '../core/state.js';
import { modKey, shortcuts } from '../ui/kbd.js';
import { closeOverlay } from '../ui/overlay.js';
import { deleteSession, rename, rerun, setArchived, takeOver, toggleDone } from './actions.js';
import { openPalette } from './commands.js';
import { collapse, collapseAll, expand, feedIds, setFocus, toggle } from './feed.js';
import { focusLauncher } from './launcher.js';
import { backToTop } from './scroll.js';
import { shipDialog, shippable } from './ship.js';
import { replay, toggleTranscript } from './turns.js';

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
  const typing = e.target.closest('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape') {
    if (!$('#overlay').hidden) return $('#overlay .sx-back') ? $('#overlay .sx-back').click() : closeOverlay();
    if (typing) return e.target.blur();
    if (S.focus && S.open.has(S.focus)) {
      collapse(S.focus);
      S.nodes.get(S.focus)?.card.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('#overlay').hidden) return;
  const k = e.key.toLowerCase();
  const id = S.focus && S.nodes.has(S.focus) ? S.focus : null;
  if (k === 'n') {
    e.preventDefault();
    focusLauncher();
  } else if (k === 'j' || k === 'k') {
    const ids = feedIds();
    if (!ids.length) return;
    const i = ids.indexOf(id);
    const next = i < 0 ? ids[0] : ids[k === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)];
    setFocus(next);
  } else if ((k === 'o' || (k === 'enter' && !e.target.closest('button, a'))) && id) {
    e.preventDefault();
    toggle(id);
  } else if (k === 'e' && id) toggleDone(id);
  else if (k === 'a' && id) {
    const s = S.sessions.get(id);
    if (s && (s.archived || (s.state !== 'running' && s.state !== 'waiting'))) setArchived(id, !s.archived);
  }
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
  else if (k === 's' && id && shippable(S.sessions.get(id))) shipDialog(id);
  else if (k === 'r' && id) replay(id);
  else if (k === 'v' && id) toggleTranscript(id);
  else if (k === '/' && id) {
    e.preventDefault();
    const focusReply = () => $('.reply', S.nodes.get(id)?.card)?.focus();
    if (S.open.has(id)) focusReply();
    else expand(id).then(focusReply);
  } else if (k === '?') shortcuts();
  else if (/^[1-9]$/.test(k) && id && S.open.has(id)) {
    const card = S.nodes.get(id).card;
    const opts = $$('.ask-card .opt', card).length ? $$('.ask-card .opt', card) : $$('.turn:last-child .b-question:not(.answered) .opt:not(.own)', card);
    opts[Number(k) - 1]?.click();
  }
}
