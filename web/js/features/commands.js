// The ⌘K palette's contents: actions on the focused session, every session, app actions, recipes
// and project filters. palette.js draws it.

import { laterActions, runLaterAction } from './later.js';
import { goalActions, runGoalAction } from './goal.js';
import { palette } from '../palette.js';
import { $ } from '../core/dom.js';
import { ago, STATUS_LABEL } from '../core/format.js';
import { isForLater, MOBILE, S, save } from '../core/state.js';
import { shortcuts } from '../ui/kbd.js';
import { closeOverlay, overlay } from '../ui/overlay.js';
import { canSaveForLater, deleteSession, forkable, forkTask, rename, rerun, rollbackTurn, setArchived, setForLater, takeOver, toggleDone } from './actions.js';
import { openAutomations, recipeParams, runRecipe, saveAsRecipe } from './automations.js';
import { compareView } from './compare.js';
import { collapseAll, expand, feedToTop, renderFeed, reveal } from './feed.js';
import { feedbackOn, openFeedback } from './feedback.js';
import { focusLauncher, renderLaunchChips } from './launcher.js';
import { inBrowser, openGetApp } from './getapp.js';
import { openMachines } from './machines.js';
import { openMemory } from './memory.js';
import { openPhone } from './phone.js';
import { openProjects, renderProjects } from './projects.js';
import { agentName } from './runners.js';
import { openSettings } from './settings.js';
import { mergePr, shipDialog, shipLabel, shippable } from './ship.js';
import { transcriptOn } from './transcript.js';
import { toggleTranscript } from './turns.js';
import { openUsage } from './usage.js';
import { activeSpells, runAction } from './spells.js';
import { openCast } from './spell-ui.js';
import { isSplit, isStacked, sideShown, toggleSidebar } from './split.js';
import { setTheme, themePref } from './theme.js';
import { addToCrew, cadenceLabel, crewEditor, crewList, memberById, openCrew } from './crew.js';
import { importCrew, shareMember } from './crew-share.js';

const STATE_LABEL = { running: 'Working', waiting: 'Asking', review: 'Review', done: 'Done' };

// Run something on a session's card, expanding it first if the action needs the body.
function withCard(id, fn, { open = false } = {}) {
  reveal(id);
  if (!open || S.open.has(id)) return setTimeout(fn, 50);
  expand(id).then(fn);
}

function paletteItems() {
  const items = [];
  const cur = S.focus && S.sessions.get(S.focus);
  if (cur) {
    const id = cur.id;
    const full = S.full.get(id);
    const lastTurn = full?.turns?.at(-1);
    const live = cur.state === 'running' || cur.state === 'waiting';
    const canRollback = cur.agent !== 'wisp' && !live && (lastTurn?.changes?.length || lastTurn?.checkpoint?.commit || cur.filesChanged);
    const rolledBack = !!lastTurn?.rolledBackAt;
    const g = 'This task';
    const sub = cur.title;
    items.push({ group: g, label: 'Follow up', sub, icon: 'send', kbd: '/', run: () => withCard(id, () => $('.reply', S.nodes.get(id)?.card)?.focus(), { open: true }) });
    if (!live) items.push({ group: g, label: cur.state === 'done' ? 'Move back to review' : 'Mark done', sub, icon: 'done', kbd: 'E', run: () => toggleDone(id) });
    if (canRollback) items.push({ group: g, label: rolledBack ? 'Re-apply latest turn' : 'Restore to before latest turn', sub, icon: rolledBack ? 'rerun' : 'replay', keywords: 'rollback revert undo checkpoint restore', run: () => rollbackTurn(id, lastTurn?.id, rolledBack) });
    if (isForLater(cur) || canSaveForLater(cur)) items.push({ group: g, label: isForLater(cur) ? 'Unsave' : 'Save for later', sub, icon: 'bookmark', kbd: 'L', keywords: 'bookmark park later read', run: () => setForLater(id, !isForLater(cur)) });
    if (cur.archived || !live) items.push({ group: g, label: cur.archived ? 'Unarchive' : 'Archive', sub, icon: 'archive', kbd: 'A', run: () => setArchived(id, !cur.archived) });
    items.push({ group: g, label: 'Take over in a terminal', sub, icon: 'terminal', kbd: 'T', run: () => takeOver(id) });
    items.push({ group: g, label: 'Rerun…', sub, icon: 'rerun', kbd: '⇧R', keywords: 'retry again restart model harness', run: () => rerun(id) });
    if (forkable(cur)) items.push({ group: g, label: 'Fork…', sub, icon: 'fork', kbd: '⇧F', keywords: 'branch copy duplicate try another way split', run: () => forkTask(id) });
    if (shippable(cur)) items.push({ group: g, label: shipLabel(cur), sub, icon: 'send', kbd: 'S', keywords: 'commit push pull request pr github', run: () => shipDialog(id) });
    if (cur.pr?.state === 'OPEN') items.push({ group: g, label: `Merge PR #${cur.pr.number}…`, sub, icon: 'check', keywords: 'squash github', run: () => mergePr(id) });
    if (cur.groupId) items.push({ group: g, label: 'Compare runs', sub, icon: 'agent', keywords: 'vs side by side harness', run: () => compareView(id) });
    items.push({ group: g, label: 'Save as recipe…', sub, icon: 'bolt', keywords: 'template reuse automation', run: () => saveAsRecipe(id) });
    // The goal's items, as the task's menus have them (Set goal… / Edit goal…, Pause, Resume, Drop).
    for (const x of goalActions(cur)) items.push({ group: g, label: x.label, sub, icon: x.icon, keywords: 'goal done when until keep going condition', run: () => runGoalAction(x.a, id, null) });
    for (const x of laterActions(cur)) items.push({ group: g, label: x.label, sub, icon: x.icon, keywords: 'scheduled later follow-up reminder snooze time', run: () => runLaterAction(x.a, cur, null, { x: innerWidth / 2 - 120, y: innerHeight / 3 }) });
    const member = cur.crew && memberById(cur.crew.id);
    if (member) items.push({ group: g, label: `Open ${member.name}`, sub, icon: 'crew', keywords: 'crew agent member', run: () => openCrew(member.id) });
    else if (!cur.parentId && cur.agent !== 'wisp') items.push({ group: g, label: 'Add to crew…', sub, icon: 'crew', keywords: 'crew agent assistant persistent schedule avatar', run: () => addToCrew(id) });
    items.push({ group: g, label: transcriptOn(id) ? 'Show the presentation' : 'Show the full transcript', sub, icon: 'transcript', kbd: 'V', keywords: 'transcript log messages steps tool calls verbose activity history', run: () => withCard(id, () => toggleTranscript(id)) });
    items.push({ group: g, label: 'Rename', sub, icon: 'pen', kbd: 'M', run: () => withCard(id, () => rename(id)) });
    items.push({ group: g, label: 'Delete task', sub, icon: 'trash', kbd: '⌫', keywords: 'remove', run: () => deleteSession(id) });
  }

  // The crew: open a member, or add one.
  for (const m of crewList()) items.push({ group: 'Crew', label: m.name, sub: [m.role, m.paused ? 'Paused' : cadenceLabel(m.cron)].filter(Boolean).join(' · '), icon: 'crew', keywords: `crew agent @${m.name} ${m.brief.slice(0, 200)}`, run: () => openCrew(m.id) });
  items.push({ group: 'Crew', label: 'Add a crew member…', icon: 'plus', keywords: 'crew agent assistant new persistent schedule avatar spirit', run: () => crewEditor() });
  // Sharing them: one, all of them, or one someone shared with you (crew-share.js).
  for (const m of crewList()) items.push({ group: 'Crew', label: `Share ${m.name}…`, icon: 'arrow', keywords: 'crew export gist file copy send colleague', run: () => shareMember(m.id) });
  if (crewList().length > 1) items.push({ group: 'Crew', label: 'Share your crew…', icon: 'arrow', keywords: 'crew export all members gist file', run: () => shareMember(crewList().map((m) => m.id)) });
  items.push({ group: 'Crew', label: 'Import crew members…', icon: 'download', keywords: 'crew import shared gist file .crew.json add', run: () => importCrew() });

  const sessions = [...S.sessions.values()].filter((s) => !s.pending).sort((a, b) => a.archived - b.archived || b.updatedAt - a.updatedAt);
  for (const s of sessions) {
    const state = s.archived ? 'Archived' : s.state === 'review' ? STATUS_LABEL[s.status] || 'Review' : STATE_LABEL[s.state] || s.state;
    items.push({
      group: 'Tasks',
      label: s.title,
      sub: `${s.project} · ${state} · ${ago(s.updatedAt)}`,
      dot: s.color,
      keywords: [s.preview, s.live, s.question, agentName(s.agent)].filter(Boolean).join(' '),
      // Live and unread work floats up; archived sinks.
      rank: (s.state === 'waiting' ? 3 : 0) + (s.unread ? 2 : 0) + (s.state === 'running' ? 1 : 0) - (s.archived ? 4 : 0),
      at: s.updatedAt,
      run: () => reveal(s.id),
    });
  }

  const a = 'Actions';
  items.push(
    { group: a, label: 'New task', icon: 'plus', kbd: 'N', keywords: 'launch create prompt task', run: focusLauncher },
    { group: a, label: S.showDone ? 'Hide done' : 'Show done', icon: 'done', keywords: 'toggle finished', run: () => $('#secDone .sec-toggle').click() },
    { group: a, label: S.showArchived ? 'Hide archived' : 'Show archived', icon: 'archive', keywords: 'toggle', run: () => $('#secArchived .sec-toggle').click() },
  );
  if (S.open.size) items.push({ group: a, label: 'Collapse all', icon: 'minus', kbd: 'C', run: collapseAll });
  items.push(
    { group: a, label: 'Add project…', icon: 'folder', keywords: 'folder repo directory', run: () => openProjects({ focusAdd: true }) },
    { group: a, label: 'Manage projects', icon: 'folder', keywords: 'rename color remove', run: () => openProjects() },
    { group: a, label: 'Memory', icon: 'spark', keywords: 'learned preferences lessons retro', run: () => openMemory() },
    { group: a, label: 'Recipes', icon: 'bolt', keywords: 'automations saved prompts templates', run: () => openAutomations({ tab: 'recipes' }) },
    { group: a, label: 'Triggers', icon: 'replay', keywords: 'automations schedule cron ci issues github', run: () => openAutomations({ tab: 'triggers' }) },
    { group: a, label: 'Usage', icon: 'stats', keywords: 'spend cost tokens outcomes success', run: () => openUsage() },
    { group: a, label: 'Phone', icon: 'send', keywords: 'ntfy telegram notifications mobile remote', run: () => openPhone() },
    // In the phone app, the app's own list of computers instead (openMachines goes there).
    ...(MOBILE
      ? [{ group: a, label: 'Your computers', icon: 'server', keywords: 'switch computer machine server add', run: () => openMachines() }]
      : [
          ...(inBrowser() ? [{ group: a, label: 'Get the desktop app', icon: 'laptop', keywords: 'download install app desktop mac windows linux electron', run: () => openGetApp() }] : []),
          { group: a, label: 'Machines', icon: 'server', keywords: 'remote ssh server computer devbox cloud vm', run: () => openMachines() },
          { group: a, label: 'Add a machine…', icon: 'server', keywords: 'remote ssh server computer connect', run: () => openMachines({ focusAdd: true }) },
        ]),
    { group: a, label: 'Settings', icon: 'settings', keywords: 'preferences lessons learn retro editor terminal notifications', run: openSettings },
  );
  // The phone has no keyboard: no shortcuts list. Stacked, the list is already its own screen.
  if (!MOBILE) items.push(
    ...(isSplit() && !isStacked() ? [{ group: a, label: sideShown() ? 'Hide the task list' : 'Show the task list', icon: 'split', kbd: '[', keywords: 'sidebar collapse expand toggle focus full width', run: toggleSidebar }] : []),
    { group: a, label: 'Keyboard shortcuts', icon: 'info', kbd: '?', keywords: 'keys help hotkeys', run: shortcuts },
  );
  // Theme: the two you're not on.
  for (const [t, label, ic] of [['system', 'System theme', 'laptop'], ['light', 'Light theme', 'sun'], ['dark', 'Dark theme', 'moon']]) {
    if (t !== themePref()) items.push({ group: a, label, icon: ic, keywords: 'theme appearance light dark mode system colors night', run: () => setTheme(t) });
  }
  items.push(
    { group: a, label: 'Cast a spell…', icon: 'wizard', keywords: 'spell customize change wisp add button panel block theme plugin extension mod', run: () => openCast() },
    { group: a, label: 'Spells', icon: 'wizard', keywords: 'spells installed manage import export share customize', run: () => openSettings({ pane: 'spells' }) },
  );
  // What spells add to ⌘K: their commands, and their buttons for the palette slot.
  for (const spell of activeSpells()) {
    const cmds = [...(spell.commands || []), ...(spell.buttons || []).filter((b) => b.slot === 'palette')];
    for (const c of cmds) items.push({ group: 'Spells', label: c.label, sub: spell.name, icon: c.icon || 'wizard', kbd: c.key ? c.key.replace(/^shift\+/i, '⇧').toUpperCase() : undefined, keywords: `spell ${c.keywords || ''}`, run: () => runAction(spell, c.do, { session: S.focus }) });
  }
  if (feedbackOn()) items.push({ group: a, label: 'Send feedback…', icon: 'thumb-up', keywords: 'feedback bug report idea suggestion thumbs contact team', run: () => openFeedback() });

  for (const r of S.config.recipes || []) items.push({ group: 'Recipes', label: `Run: ${r.name}`, sub: r.prompt.replace(/\s+/g, ' ').slice(0, 80), icon: 'bolt', keywords: `recipe ${r.prompt}`, run: () => runRecipe({ ...r, params: recipeParams(r.prompt) }) });

  const filter = (id) => () => {
    S.filter = id;
    save('wisp.filter', id);
    renderProjects();
    renderFeed();
    feedToTop();
    renderLaunchChips();
  };
  items.push({ group: 'Projects', label: 'All projects', sub: S.filter === 'all' ? 'Current filter' : '', dot: 'slate', keywords: 'filter clear', run: filter('all') });
  for (const p of S.config.projects.slice().sort((x, y) => (y.lastUsedAt || y.addedAt) - (x.lastUsedAt || x.addedAt))) {
    items.push({ group: 'Projects', label: p.name, sub: S.filter === p.id ? 'Current filter' : p.path, dot: p.color, keywords: `filter ${p.path}`, at: p.lastUsedAt || p.addedAt, run: filter(p.id) });
  }
  return items;
}

let paletteOpen = false;
export function openPalette() {
  if (paletteOpen) return closeOverlay();
  // Don't stack over another modal (settings, projects…); the palette replaces nothing.
  if (!$('#overlay').hidden) return;
  paletteOpen = true;
  palette({ items: paletteItems(), overlay: (node) => overlay(node, { onClose: () => (paletteOpen = false) }) });
}
