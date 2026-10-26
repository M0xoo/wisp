// Tips under the prompt box: a few at a time, from a long list that rotates on every visit (and on
// "More tips"), each opening the trywisp.dev guide that explains it. Split view's home only, under
// Needs you: not in the feed, where the tasks are, nor on a phone. A spell restyles or hides them
// through the `tips` part and sets how many show with its `count` prop. Until this computer has a
// harness that can run, a setup tip stays pinned on top (phones too) and opens Settings → Agents.

import * as bus from '../core/bus.js';
import { $$, icon } from '../core/dom.js';
import { esc } from '../md.js';
import { load, MOBILE, S, save } from '../core/state.js';
import { TIPS } from '../tips-data.js';
import { spellProp } from './spells.js';

const AT = 'wisp.tipsAt'; // where the last set started, so a reload shows the next ones
let at = 0;

function count() {
  return Math.max(1, Math.min(spellProp('tips', 'count') || 3, TIPS.length));
}

// Turn the list on: a new set each time the page loads.
function start() {
  at = (load(AT, -count()) + count()) % TIPS.length;
  save(AT, at);
}

// Nothing here can run a task for real: none found, found but signed out, or only opencode on its
// free models (no provider, no API key). Unknown until the first detection is back (an empty
// list), so a slow start doesn't flash it.
function setupHtml() {
  if (!S.agents.length || S.agents.some((a) => a.available && a.hasKey !== false)) return '';
  const out = S.agents.filter((a) => a.signedIn === false);
  const [title, line, cta] = out.length
    ? [`Sign in to ${esc(out[0].name)}`, `It’s installed but signed out, so tasks have nowhere to run yet`, 'Sign in']
    : S.agents.some((a) => a.available)
      ? ['Bring your own model', 'Only opencode’s free models run here: sign in to Claude Code or Codex, or add a key', 'Set up']
      : ['Connect a coding agent', 'wisp drives Claude Code, Codex, opencode and more: pick one to run your first task', 'Set up'];
  return `<button type="button" class="tip tip-setup">
    <span class="ts-badge">${icon('agent')}</span>
    <span class="ts-text"><b>${title}</b><small>${line}</small></span>
    <span class="ts-cta">${cta}${icon('arrow')}</span>
  </button>`;
}

function html() {
  const setup = setupHtml();
  if (MOBILE) return setup && `<h4>Tips</h4>${setup}`;
  const n = count();
  const items = Array.from({ length: n }, (_, i) => TIPS[(at + i) % TIPS.length])
    .map(([text, href]) => `<a class="tip" href="${href}" target="_blank" rel="noopener">${icon('spark')}<span>${text}</span>${icon('external', 'tip-go')}</a>`)
    .join('');
  return `<h4>Tips<button class="tip-more" title="Show other tips">More tips</button></h4>${setup}${items}`;
}

export function paintTips() {
  const out = html();
  for (const box of $$('.tips')) {
    // Only when they changed: a repaint on every feed render would replay hover and focus.
    if (box.dataset.h !== out) (box.innerHTML = out), (box.dataset.h = out);
    box.hidden = !out;
    box.classList.toggle('has-setup', out.includes('tip-setup')); // stacked shows this one alone
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.tips .tip-setup')) {
    import('./settings.js').then((m) => m.openSettings({ pane: 'agents' }));
    return;
  }
  if (!e.target.closest('.tips .tip-more')) return;
  at = (at + count()) % TIPS.length;
  save(AT, at);
  paintTips();
});

start();
paintTips();
bus.on('spells', paintTips);
bus.on('agents', paintTips);
