// Start a task from an issue (New task's Issue button, ⌘K Start from an issue…): the project's open
// GitHub issues (server/issues.js, through gh), or the Linear issues assigned to you when a Linear
// connector has an API key. Picking one fills the prompt; nothing starts until you send it.

import { esc } from '../md.js';
import { palette } from '../palette.js';
import { api } from '../core/api.js';
import { $, icon } from '../core/dom.js';
import { ago } from '../core/format.js';
import { overlay } from '../ui/overlay.js';
import { toast } from '../ui/toast.js';

// What an issue starts: what to do, the link, then what it says.
export const issuePrompt = (i) => `Fix ${i.ref}: ${i.title}\n\n${i.url}${i.body?.trim() ? `\n\n${i.body.trim()}` : ''}`;

// The words and the button for each problem (the server's fix).
const FIX = {
  signin: 'Sign in to GitHub',
  install: 'Install the GitHub CLI',
  linear: 'Connect Linear',
  jira: 'Connect Jira',
  retry: 'Try again',
};
const note = (text, fix) => `<div class="pal-note" role="status">${icon(fix === 'retry' ? 'warn' : 'info')}<p>${esc(text)}</p>${FIX[fix] ? `<button class="ghost sm" data-fix="${fix}">${FIX[fix]}</button>` : ''}</div>`;

const subOf = (i) => [...i.labels.slice(0, 3).map((l) => `<span class="pal-pill">${esc(l)}</span>`), `<span class="pal-who">${[i.assignee, i.updatedAt && ago(Date.parse(i.updatedAt))].filter(Boolean).map(esc).join(' · ')}</span>`].join('');

// project: the launcher's ({ id, name }; no id for No folder). ta: the prompt it fills.
export function pickIssue({ project, ta, source = 'github' }) {
  const linear = source === 'linear';
  const jira = source === 'jira';
  const name = project?.name || 'this project';
  let box = null;
  let group = linear ? 'Assigned to you on Linear' : jira ? 'Assigned to you on Jira' : 'Open issues';
  const ask = (q = '') => api(`/issues?${new URLSearchParams({ source, project: project?.id || '', q })}`);
  const toItems = (r) =>
    (r.issues || []).map((i) => ({ id: i.id, group, label: `${i.ref} ${i.title}`, subHtml: subOf(i), icon: 'issue', keywords: [i.number, ...i.labels, i.assignee].join(' '), run: () => fill(ta, i) }));
  const close = palette({
    items: [],
    loading: true,
    cls: 'issues',
    label: 'Start from an issue',
    placeholder: linear ? 'Search the Linear issues assigned to you…' : jira ? 'Search the Jira issues assigned to you…' : `Search ${name}’s open issues…`,
    overlay: (node) => ((box = node), overlay(node)),
    // Past the 50 newest: the server searches (gh's --search, Linear's titles).
    deep: async (q) => toItems(await ask(q)),
  });
  // The other place issues come from, under the list.
  const others = (r) => {
    const g = 'Other sources';
    // Every source but this one: GitHub for the project, then Linear and Jira (or how to connect them)
    const out = [];
    if (source !== 'github' && project?.id) out.push({ group: g, label: `${name}’s GitHub issues`, icon: 'github', run: () => pickIssue({ project, ta }) });
    if (!linear) out.push(r.linear ? { group: g, label: 'Linear issues assigned to you', icon: 'issue', keywords: 'linear', run: () => pickIssue({ project, ta, source: 'linear' }) } : { group: g, label: 'Connect Linear…', sub: 'Sign in with your Linear account', icon: 'plug', keywords: 'linear connector', run: () => openConnectors('linear') });
    if (!jira) out.push(r.jira ? { group: g, label: 'Jira issues assigned to you', icon: 'issue', keywords: 'jira atlassian', run: () => pickIssue({ project, ta, source: 'jira' }) } : { group: g, label: 'Connect Jira…', sub: 'Sign in with your Atlassian account', icon: 'plug', keywords: 'jira atlassian connector', run: () => openConnectors('jira') });
    return out;
  };
  const load = () =>
    ask()
      .then((r) => {
        if (r.repo) group = `Open issues · ${r.repo}`;
        // None assigned to you: the workspace's open ones, under a heading that says so.
        if (linear && r.scope === 'all') group = 'Open on Linear (none assigned to you)';
        const empty = !r.error && !r.issues.length && note(linear ? 'Nothing open is assigned to you on Linear.' : jira ? 'Nothing open is assigned to you on Jira.' : `${r.repo || name} has no open issues.`);
        close.set({ items: [...toItems(r), ...others(r)], notice: r.error ? note(r.error, r.fix) : empty || '' });
      })
      .catch((err) => close.set({ items: others({}), notice: note(`Couldn’t list the issues: ${err.message}`, 'retry') }));
  load();
  box.addEventListener('click', (e) => {
    const fix = e.target.closest('[data-fix]')?.dataset.fix;
    if (!fix) return;
    if (fix === 'retry') return void load();
    close();
    if (fix === 'linear' || fix === 'jira') return openConnectors(fix);
    openGh();
  });
}

// Settings → Agents, at its git / GitHub row (as tips.js does).
function openGh() {
  import('./settings.js').then((m) => {
    m.openSettings({ pane: 'agents' });
    $('.sx .sx-tool')?.scrollIntoView({ block: 'center' });
  });
}
// Settings → Connectors, at that source's connector (a new one filled in, or yours to sign in again).
function openConnectors(source) {
  import('./settings.js').then((m) => m.openSettings({ pane: 'connectors', connector: source }));
}

// Into the prompt, the caret at its end. A draft it replaces comes back with Undo.
function fill(box, i) {
  const ta = box?.isConnected ? box : $('#prompt'); // the launcher may have been drawn again since
  if (!ta) return;
  const was = ta.value;
  ta.value = issuePrompt(i);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollTop = ta.scrollHeight;
  if (was.trim())
    toast(`Started from ${esc(i.ref)}: your draft was replaced`, {
      action: {
        label: 'Undo',
        run: () => {
          ta.value = was;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
        },
      },
    });
}
