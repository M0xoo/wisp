// The page's views for the QA sweeps (buttons.mjs, ui-audit.mjs): a QA wisp seeded with something in
// every place (tasks, a goal with judges, a crew member), and a function per view that leaves the
// page in that state: New task and its menus, a task with its menus, panels and dialogs, crew,
// My Stuff, the palette and every Settings pane.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from '../test/helpers.js';
import { api, ENGINE, launchBrowser, OUT, startWisp } from './lib.mjs';

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
    'task.changes-diff': async (p) => (await bar('changes')(p), await p.waitForTimeout(600)),
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
    crew: async (p) => click(p, '#crewRail .cl-face:visible, #secCrew .cr-row:not(.cr-empty):visible'),
    'crew.add': async (p) => click(p, '#crewRail .cl-add:visible, #secCrew .cr-add:visible'),
    'crew.org': async (p) => click(p, '#crewRail .cl-org:visible, #secCrew .cr-org:visible'),
    projects: async (p) => click(p, '#manageProjects'),
    stuff: async (p) => click(p, '#splitStuff:visible, .stuff-top:visible'),
    'me-menu': async (p) => click(p, '#meBtn'),
    palette: async (p) => (await p.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'), await p.waitForTimeout(400)),
    ...Object.fromEntries(['general', 'notifications', 'agents', 'connectors', 'auto', 'machines', 'cloud', 'memory', 'automations', 'spells', 'worktrees', 'usage', 'privacy'].map((n) => [`settings.${n}`, settings(n)])),
  };
}

// The phone app has neither: projects come with its Computers, and wisp Cloud is its Computers screen.
export const NOT_IN_APP = new Set(['projects', 'settings.cloud']);

// `node qa/views.mjs` opens every view by itself, light and dark, at 1440 and 390px, in each engine
// (QA_ENGINE): a view fails if it can't be opened or logs an error. Shots in qa/out/views-<engine>/.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.QA_VIEWS_PORT) || 4499;
  const seeded = await seededWisp(port);
  const browser = await launchBrowser();
  const dir = path.join(OUT, `views-${ENGINE}`);
  const only = process.env.VIEWS?.split(',');
  let pass = 0;
  let fail = 0;
  for (const [width, height] of [[1440, 900], [390, 844]])
    for (const colorScheme of ['light', 'dark'])
      for (const [name, open] of Object.entries(views(seeded))) {
        if (only && !only.includes(name)) continue;
        const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
        const p = await ctx.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        p.on('console', (m) => {
          if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
        });
        try {
          await p.goto(seeded.w.url);
          await p.locator('#feed .item[data-id]').first().waitFor({ state: 'attached' });
          await open(p);
          await p.screenshot({ path: path.join(dir, `${name}-${width}-${colorScheme}.png`) });
        } catch (err) {
          errors.push(String(err?.message || err).split('\n')[0]);
        }
        await ctx.close();
        if (errors.length) console.log(`  ✗ ${name} ${width} ${colorScheme}: ${errors.slice(0, 2).join(' | ')}`);
        errors.length ? fail++ : pass++;
      }
  await browser.close();
  seeded.w.stop();
  console.log(`\n  views (${ENGINE}): ${pass} passed, ${fail} failed · ${dir}`);
  process.exit(fail ? 1 : 0);
}
