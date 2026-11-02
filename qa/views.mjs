// The page's views for the QA sweeps (buttons.mjs, ui-audit.mjs): a QA wisp seeded with something in
// every place (tasks, a goal with judges, a crew member), and a function per view that leaves the
// page in that state: New task and its menus, a task with its menus, panels and dialogs, crew,
// My Stuff, the palette and every Settings pane.

import { until } from '../test/helpers.js';
import { api, startWisp } from './lib.mjs';

export async function seededWisp(port) {
  const w = await startWisp({ port, extraEnv: { FAKE_DELAY: '300' } });
  const launch = async (body) => (await api(w.url, '/api/sessions', { cwd: w.repo, agent: 'claude', ...body })).json;
  const tasks = [];
  for (const prompt of ['Fix the login bug', 'Write docs for the API', 'Refactor the store']) tasks.push(await launch({ prompt }));
  const goal = await launch({ prompt: 'Make the tests pass', goal: { text: 'all tests pass', judges: [{ agent: 'claude', name: 'Claude Code' }, { agent: 'codex', name: 'Codex' }], vote: 'all' } });
  await api(w.url, '/api/crew', { name: 'Ada', role: 'Reviews every PR', cwd: w.repo, agent: 'claude' });
  await until(async () => {
    const all = await Promise.all([...tasks, goal].map(async (t) => (await api(w.url, `/api/sessions/${t.id}`)).json?.state));
    return all.every((s) => ['review', 'done', 'waiting'].includes(s));
  }, { timeout: 60_000, what: 'the seeded tasks to settle' });
  return { w, tasks, goal };
}

export const click = async (p, sel) => {
  await p.locator(sel).first().click({ force: true });
  await p.waitForTimeout(450);
};

// Each view leaves the page in a state to check.
export function views({ tasks, goal }) {
  const home = async (p) => {
    if (!(await p.isVisible('#goalBtn'))) await click(p, '#promptFab:visible, #splitNew:visible');
  };
  const open = (id) => async (p) => {
    await click(p, `#feed .item[data-id="${id}"] .it-head`);
    await p.waitForTimeout(500);
  };
  const first = () => open(tasks[0].id);
  // The task's own buttons, not its keys: opening a task puts the caret in its reply box
  // (on a phone Transcript, Rerun… and Take over sit at the top of More)
  const bar = (a) => async (p) => {
    await first()(p);
    if (await p.locator(`.item.open .it-actions [data-a="${a}"]:visible`).count()) return click(p, `.item.open .it-actions [data-a="${a}"]:visible`);
    await click(p, '.item.open .it-actions [data-a="more"]:visible');
    await click(p, `.menu [data-a="${a}"]`);
  };
  const settings = (pane) => async (p) => {
    await click(p, '#meBtn');
    await click(p, '#settingsBtn');
    if (pane) await click(p, `button[role="tab"][data-pane="${pane}"]`);
  };
  return {
    home,
    'home.goal-on': async (p) => (await home(p), await click(p, '#goalBtn')),
    'home.worktree-off': async (p) => (await home(p), await click(p, '#wtBtn')),
    'home.typed': async (p) => (await home(p), await p.fill('#prompt', 'Fix the flaky test in the store')),
    'home.mode-menu': async (p) => (await home(p), await click(p, '#mode')),
    'home.runner': async (p) => (await home(p), await click(p, '#runner')),
    'home.auto-preview': async (p) => (await home(p), await click(p, '#autoPv:visible')),
    'home.compare': async (p) => (await home(p), await click(p, '#compareBtn:visible')),
    'home.where': async (p) => (await home(p), await click(p, '#whereBtn')),
    'home.team': async (p) => (await home(p), await click(p, '#teamBtn')),
    'home.later': async (p) => (await home(p), await click(p, '#launchLater')),
    task: first(),
    'task.goal': open(goal.id),
    'task.goal-menu': async (p) => (await open(goal.id)(p), await click(p, '.gb-more')),
    'task.goal-judges': async (p) => (await open(goal.id)(p), await click(p, '.gb-more'), await click(p, '.menu [data-a="goal-set"]'), await click(p, '.goal-pop .gp-judges')),
    'home.goal-judges': async (p) => (await home(p), await click(p, '#goalBtn'), await click(p, '#judgesBtn')),
    'task.composer': async (p) => (await first()(p), await click(p, '.it-dock .composer textarea')),
    'task.composer-goal': async (p) => (await first()(p), await click(p, '.it-dock .composer textarea'), await click(p, '.it-dock .c-goal')),
    'task.transcript': bar('transcript'),
    'task.changes': async (p) => (await bar('changes')(p), await p.waitForTimeout(600)),
    'task.changes-diff': async (p) => (await bar('changes')(p), await p.waitForTimeout(600), await click(p, '.cx-row:visible')),
    'task.editor': async (p) => {
      await bar('changes')(p);
      await p.waitForTimeout(600);
      if (await p.locator('.cx-edit:visible').count()) return click(p, '.cx-edit:visible');
      await click(p, '.cx-more:visible'); // a phone's row keeps Edit here in its ⋯
      await click(p, '.menu [data-a="edit"]');
    },
    'task.preview': async (p) => (await bar('changes')(p), await p.waitForTimeout(500), await click(p, '.pn-tabs [data-tab="preview"]')),
    'home.issues': async (p) => (await home(p), await click(p, '[data-issue]:visible, .l-bar .issue-btn:visible'), await p.waitForTimeout(800)),
    // Automations' trigger editor, opened the way ⌘K does (Triggers)
    'automations.trigger-new': async (p) => {
      await p.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await p.waitForTimeout(300);
      await p.keyboard.type('Triggers');
      await p.waitForTimeout(300);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(600);
      await click(p, '.auto-modal [data-act="new"]');
    },
    'task.rerun': bar('rerun'),
    'task.ship': bar('ship'),
    'task.more': bar('more'),
    'task.right-click': async (p) => (await p.locator(`#feed .item[data-id="${tasks[1].id}"] .it-head`).click({ button: 'right' }), await p.waitForTimeout(400)),
    crew: async (p) => click(p, '#secCrew .cr-row:not(.cr-empty)'),
    'crew.add': async (p) => click(p, '#secCrew .cr-add'),
    'crew.org': async (p) => click(p, '#secCrew .cr-org'),
    projects: async (p) => click(p, '#manageProjects'),
    stuff: async (p) => click(p, '#splitStuff:visible, .stuff-top:visible'),
    'me-menu': async (p) => click(p, '#meBtn'),
    palette: async (p) => (await p.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'), await p.waitForTimeout(400)),
    ...Object.fromEntries(['general', 'notifications', 'agents', 'auto', 'machines', 'cloud', 'memory', 'automations', 'spells', 'usage', 'privacy'].map((n) => [`settings.${n}`, settings(n)])),
  };
}

// The phone app has neither: projects come with its Computers, and wisp Cloud is its Computers screen.
export const NOT_IN_APP = new Set(['projects', 'settings.cloud']);
