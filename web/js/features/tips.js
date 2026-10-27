// Tips under the prompt box: a few at a time, from a long list that rotates on every visit (and on
// "More tips"), each opening the trywisp.dev guide that explains it. Split view's home only, under
// Needs you: not in the feed, where the tasks are, nor on a phone. A spell restyles or hides them
// through the `tips` part and sets how many show with its `count` prop. Until this computer has a
// harness that can run, a setup tip stays pinned on top (phones too) and opens Settings → Agents.
// Until git and gh are installed and gh is signed in to GitHub, a second one asks for the next of
// those and opens their row there: Ship it can't commit, push or open a pull request without them.
// A wisp on your own computer that isn't on a wisp Grid gets a third, until it is: on a grid it
// opens from anywhere at its grid address. It opens Machines at its grid sign-in. On a cloud
// computer it explains that instead (its address), until opened once: Settings → Connect.

import * as bus from '../core/bus.js';
import { api } from '../core/api.js';
import { $, $$, icon } from '../core/dom.js';
import { esc } from '../md.js';
import { inGrid, load, MOBILE, S, save } from '../core/state.js';
import { TIPS } from '../tips-data.js';
import { loadTools, tools } from './setup.js';
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
  // Generic on purpose: whichever harness was found signed out, any of them (or opencode's free
  // models, which need no account) gets a first task going.
  const [title, line] = S.agents.some((a) => a.available)
    ? ['Bring your own model', 'opencode’s free models run here for now: sign in to Claude Code, Codex or another, or add a key']
    : S.agents.some((a) => a.signedIn === false)
      ? ['Sign in to a coding agent', 'Use Claude Code, Codex or another you have, or start free with opencode’s models']
      : ['Connect a coding agent', 'wisp drives Claude Code, Codex and more. No account? Start free with opencode’s models'];
  return pinned('', 'agent', title, line, 'Set up');
}

const pinned = (cls, ico, title, line, cta) => `<button type="button" class="tip tip-setup ${cls}">
    <span class="ts-badge">${icon(ico)}</span>
    <span class="ts-text"><b>${title}</b><small>${line}</small></span>
    <span class="ts-cta">${cta}${icon('arrow')}</span>
  </button>`;

// What Ship it needs, one card at a time: git, then gh, then gh signed in to GitHub.
function toolsHtml() {
  if (!tools) return '';
  if (!tools.git.installed) return pinned('tip-tool', 'branch', 'Install git', 'Tasks get their own branch, and Ship it commits and pushes them, with git', 'How to');
  if (!tools.gh.installed) return pinned('tip-tool', 'github', 'Install the GitHub CLI', 'Ship it pushes your branch and opens the pull request with gh', 'How to');
  return tools.gh.signedIn === false ? pinned('tip-tool', 'github', 'Sign in to GitHub', 'So tasks can push their branch and open a pull request when you ship them', 'Sign in') : '';
}

// This computer on a grid (GET /computer): null until known. Not asked on a phone (it reaches its
// computers already) or a cloud computer (it's on the grid).
let here = null;
const SEEN = 'wisp.tipGridSeen';
function gridHtml() {
  if (MOBILE) return '';
  if (inGrid()) {
    const at = String(S.config.grid?.address || '').replace(/^https?:\/\//, '');
    return load(SEEN, false) || !at ? '' : pinned('tip-grid', 'cloud', 'This wisp opens from anywhere', `It lives at <span class="mono">${esc(at)}</span>: open it from your phone, another computer or any browser, signed in with this account`, 'How');
  }
  if (!here || here.on || here.cloud) return '';
  return pinned('tip-grid', 'cloud', 'Reach this wisp from anywhere', 'Put this computer on a wisp Grid and open it at your grid address from your phone or any browser. No SSH, no open ports', here.account ? 'Add to grid' : 'Set up');
}
function loadHere() {
  if (MOBILE || inGrid()) return;
  api('/computer')
    .then((v) => {
      here = v;
      paintTips();
    })
    .catch(() => {});
}

function html() {
  const setup = setupHtml() + toolsHtml() + gridHtml();
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
  const pin = e.target.closest('.tips .tip-setup');
  if (pin) {
    if (pin.classList.contains('tip-grid')) {
      // Here: Machines, at the grid sign-in. On the grid: Settings → Connect, and the card has done its job.
      if (inGrid()) {
        save(SEEN, true);
        paintTips();
      }
      import('./machines.js').then((m) => m.openMachines({ focusGrid: true }));
      return;
    }
    const tool = pin.classList.contains('tip-tool');
    import('./settings.js').then((m) => {
      m.openSettings({ pane: 'agents' });
      // Straight to the git or GitHub row, under the harnesses.
      if (tool) $('.sx .sx-tool')?.scrollIntoView({ block: 'center' });
    });
    return;
  }
  if (!e.target.closest('.tips .tip-more')) return;
  at = (at + count()) % TIPS.length;
  save(AT, at);
  paintTips();
});

start();
paintTips();
loadTools();
loadHere();
bus.on('tools', paintTips);
bus.on('computer', (v) => {
  here = v;
  paintTips();
});
// Signed in to a grid or out of it: whether there's an account to add this computer with.
bus.on('machines', () => {
  if (here && !here.on && !!here.account !== S.machines.some((m) => m.kind === 'grid' && !m.computer)) loadHere();
});
bus.on('spells', paintTips);
bus.on('agents', paintTips);
