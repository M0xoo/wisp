// Make a pane: say what you want and an agent writes the app into My Stuff, pinned, and keeps it up
// to date as it edits (kind 'pane', server/pane-guide.js); or start from one wisp ships with
// (GET /stuff/starters). A starter is pinned by your click on Add, so the Allow card comes from that
// click like any other.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';
import { isLoopback } from '../preview-spec.js';
import { launchDefaults, pinApp, pinnedAt } from './panes.js';
import { agentName } from './runners.js';
import { loadStuff } from './stuff.js';

export async function makePane(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const { agent, model, effort, account } = launchDefaults(); // the mode comes from the kind
  const out = await api('/sessions', { method: 'POST', body: { prompt: text, kind: 'pane', agent, model, effort, account: account || undefined } });
  S.sessions.set(out.id, out);
  const { renderFeed, reveal } = await import('./feed.js');
  renderFeed();
  reveal(out.id);
  toast(`${icon('app')} Making it: it pins itself, and reloads as the agent changes it`);
  return out;
}

// Add, Adding…, Pin and Added share one slot (.mk-list min-width), so a row never moves.
const onHome = (s) => {
  const it = s.added && (S.stuff || []).find((x) => x.id === s.added);
  return !!it && pinnedAt(it, 'home');
};
const row = (s) => {
  const word = s.added ? 'Pin' : 'Add';
  return `<li data-id="${esc(s.id)}"><b>${esc(s.name)}</b><small>${esc(s.description)}</small>${onHome(s) ? `<span class="mk-added">${icon('check')}Added</span>` : `<button type="button" class="ghost sm" data-add aria-label="${word} ${esc(s.name)}">${word}</button>`}</li>`;
};
const SKELETON = '<li class="mk-sk" aria-hidden="true"><i class="sk"></i><i class="sk"></i><i class="sk"></i></li>'.repeat(2);

export function openMakePane(prefill = '') {
  const node = el(`
    <form class="modal pane-make">
      <header><h2>${icon('app')} Make a pane</h2><button type="button" class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="hint">Say what it should show or do. An agent writes it into My Stuff and pins it. It gets nothing from wisp until you press Allow… on its bar.</p>
      ${MOBILE && isLoopback(location.href) ? '<p class="hint">Panes open when you connect through wisp Cloud, or in a browser on the computer running wisp.</p>' : ''}
      <textarea class="textarea mk-ask" rows="3" spellcheck="false" placeholder="A pane that lists my open PRs by repo…" aria-label="What should the pane do?"></textarea>
      <h4>Or start from one of these</h4>
      <ul class="mk-list">${SKELETON}</ul>
      <footer><span class="hint">Runs on ${esc(agentName(launchDefaults().agent))} in an empty folder of its own: it writes the pane, not your code.</span><button class="primary" type="submit">${icon('app')}Make it</button></footer>
    </form>`);
  const ta = $('.mk-ask', node);
  ta.value = prefill;
  const close = overlay(node);
  $('.close', node).onclick = close;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      node.requestSubmit();
    }
  };
  node.onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return ta.focus();
    close();
    makePane(text).catch((err) => {
      toastError(err);
      openMakePane(text);
    });
  };
  setTimeout(() => ta.focus(), 50);
  let list = [];
  const box = $('.mk-list', node);
  // My Stuff first when it hasn't loaded: Added needs it.
  Promise.all([api('/stuff/starters'), S.stuff ? null : loadStuff()]).then(
    ([out]) => {
      list = out.starters;
      box.innerHTML = list.map(row).join('');
    },
    (err) => {
      box.innerHTML = `<li class="mk-off">${esc(err.message)}</li>`;
    },
  );
  box.onclick = async (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn || btn.disabled) return;
    const s = list.find((x) => x.id === btn.closest('li').dataset.id);
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const it = await api(`/stuff/starters/${s.id}`, { method: 'POST' });
      await loadStuff();
      s.added = it.id;
      const added = (S.stuff || []).find((x) => x.id === it.id) || it;
      await pinApp(added, 'home', btn);
      if (pinnedAt(added, 'home')) return close();
    } catch (err) {
      toastError(err);
    }
    btn.disabled = false;
    btn.textContent = s.added ? 'Pin' : was;
    btn.setAttribute('aria-label', `${btn.textContent} ${s.name}`);
  };
}
