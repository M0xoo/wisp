// QA for wisp in the browser: the scenarios in qa/scenarios/web.md, against a QA wisp
// (own home, port and repo, fake agents). `node qa/web.mjs` → qa/out/web.json + screenshots.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { until } from '../test/helpers.js';
import { api, CHROME, ok, OUT, playwright, ROOT, runner, startWisp } from './lib.mjs';

const PORT = Number(process.env.QA_WEB_PORT) || 4493;
const { check: run, done } = runner('web');
// A failing check leaves a screenshot of the main page behind (web-fail-<id>.png).
const check = (id, title, fn) =>
  run(id, title, async () => {
    try {
      await fn();
    } catch (err) {
      await p?.shot(`fail-${id}`).catch(() => {});
      throw err;
    }
  });
const w = await startWisp({ port: PORT });
const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1' });
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// A page that records uncaught errors and console.error; `clean()` throws if there were any.
async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text())) p.errors.push(m.text());
  });
  p.clean = () => ok(!p.errors.length, `console errors: ${p.errors.slice(0, 3).join(' | ')}`);
  p.shot = (name) => p.screenshot({ path: path.join(OUT, `web-${name}.png`) });
  return p;
}
const session = async (id) => (await api(w.url, `/api/sessions/${id}`)).json;
const settled = (id, states = ['review', 'done', 'waiting']) =>
  until(async () => states.includes((await session(id))?.state) && session(id), { timeout: 30_000, what: `session ${id} to settle` });
const launch = async (body) => {
  const r = await api(w.url, '/api/sessions', { cwd: w.repo, agent: 'claude', ...body });
  ok(r.status === 201, `launch ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
};
// Shortcuts only work with nothing focused: a focused reply box would just get the letters.
const blur = (q) => q.evaluate(() => document.activeElement?.blur());
const press = async (q, key) => {
  if (key !== 'Escape') await blur(q);
  await q.keyboard.press(key);
};
const noOverflow = async (p) => {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(o <= 1, `horizontal overflow of ${o}px`);
};

let p;
try {
  await check('WEB-01', 'server boots and answers', async () => {
    const h = await api(w.url, '/api/health');
    ok(h.status === 200 && h.json.version === version, `health ${h.status} ${h.text}`);
    const s = await api(w.url, '/api/status');
    ok(s.status === 200 && 'live' in s.json && 'clients' in s.json, `status ${s.text}`);
    ok((await api(w.url, '/api/config')).status === 200, 'config');
    const o = await api(w.url, '/api/openapi.json');
    ok(o.status === 200 && o.json?.paths, `openapi ${o.status}`);
  });

  p = await page();
  await check('WEB-02', 'first paint: split view home', async () => {
    await p.goto(w.url);
    await p.getByText('What should wisp do next?').waitFor();
    for (const t of ['New task', 'Needs you', 'Welcome to wisp', 'This computer', 'Tips'])
      ok(await p.getByText(t, { exact: false }).first().isVisible(), `"${t}" not visible`);
    await p.shot('home');
    // You, Machines, Automations and Settings: behind the avatar.
    await p.locator('#meBtn').click();
    for (const t of ['Not connected', 'Machines', 'Automations', 'Settings'])
      ok(await p.locator('#meMenu').getByText(t, { exact: false }).first().isVisible(), `"${t}" not in the avatar's menu`);
    await p.shot('account-menu');
    await press(p, 'Escape');
    ok(await p.locator('#meMenu').isHidden(), 'Esc did not close the avatar menu');
    p.clean();
  });

  await check('WEB-03', 'welcome tour renders every block', async () => {
    await p.locator('.item', { hasText: 'Welcome to wisp' }).first().click();
    await p.waitForTimeout(2500);
    // The open card's body sits in the sidebar, fixed over #splitStage.
    // An unknown type falls back to its JSON under "unknown block · <type>" (blocks.js R.unknown).
    const raw = await p.evaluate(() => [...document.querySelectorAll('.it-body .lang')].map((e) => e.textContent).filter((t) => t.startsWith('unknown block')));
    ok(!raw.length, `rendered as raw JSON: ${raw.join(', ')}`);
    const blocks = await p.locator('.it-body .blk:visible').count();
    await p.shot('welcome');
    ok(blocks > 5, `only ${blocks} blocks rendered`);
    p.clean();
  });

  const proj = await api(w.url, '/api/projects', { path: w.repo });
  let first;
  await check('WEB-04', 'launch a task from the launcher', async () => {
    ok(proj.status < 300, `add project ${proj.status} ${proj.text}`);
    await press(p, 'Escape');
    await p.goto(w.url);
    await p.getByText('What should wisp do next?').waitFor();
    // Pick the project: the chip next to "in".
    await p.getByText('No folder', { exact: true }).first().click();
    await p.getByText(path.basename(w.repo)).last().click();
    const box = p.locator('#prompt');
    await box.click();
    await box.fill('fix the add bug from the launcher');
    const t0 = Date.now();
    const launched = p.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions');
    await box.press('Enter');
    await p.locator('.item', { hasText: 'fix the add bug from the launcher' }).first().waitFor({ timeout: 3000 });
    const shown = Date.now() - t0;
    ok((await box.inputValue().catch(() => box.innerText())).trim() === '', 'prompt box not cleared');
    first = await (await launched).json();
    await settled(first.id);
    // Auto picks the harness, so any fake one may have run it.
    await p.locator(`.item[data-id="${first.id}"]`, { hasText: /Fake [\w-]+ finished/ }).waitFor({ timeout: 15000 });
    await p.locator(`.item[data-id="${first.id}"]`).click();
    await p.locator('.it-body:visible button[data-tab="changes"]').first().waitFor({ timeout: 10000 });
    ok(await p.getByText(/wisp\/fix-the-add-bug/).first().isVisible(), 'branch not shown in details');
    await p.shot('task-finished');
    // A toast shown over an open task stays clear of its reply box.
    await p.evaluate(() => import('/js/ui/toast.js').then((m) => m.toast('QA toast', { action: { label: 'Open', run() {} } })));
    await p.waitForTimeout(500);
    const [t, c] = await p.evaluate(() => [document.querySelector('#toasts .toast'), document.querySelector('.it-body .it-dock .composer')].map((e) => e && e.getBoundingClientRect().toJSON()));
    ok(t && c, 'no toast or reply box to compare');
    ok(t.bottom <= c.top, `toast (bottom ${t.bottom}) covers the reply box (top ${c.top})`);
    await p.shot('toast-over-task');
    ok(shown < 1500, `card took ${shown}ms to appear`);
    p.clean();
  });

  await check('WEB-05', 'live updates without reload (SSE)', async () => {
    const s = await launch({ prompt: 'live update check' });
    await p.locator(`.item[data-id="${s.id}"]`).waitFor({ timeout: 5000 });
    await settled(s.id);
    await until(async () => /finished/i.test(await p.locator(`.item[data-id="${s.id}"]`).innerText()), { timeout: 10000, what: 'card to finish' });
    p.clean();
  });

  await check('WEB-06', 'follow up', async () => {
    await p.locator(`.item[data-id="${first.id}"]`).click();
    const box = p.locator('textarea.reply:visible').first();
    await box.waitFor();
    await box.fill('also add a comment');
    await box.press('Enter');
    await until(async () => (await box.inputValue()) === '', { timeout: 1500, what: 'follow-up box to clear' });
    await until(async () => (await session(first.id)).turns?.length >= 2, { timeout: 10000, what: 'second turn' });
    await settled(first.id);
    await p.getByText('also add a comment').first().waitFor({ timeout: 5000 });
    p.clean();
  });

  await check('WEB-07', 'agent asks a question (ask_user)', async () => {
    const s = await launch({ prompt: 'ASK before you fix it' });
    await until(async () => (await session(s.id)).state === 'waiting', { timeout: 20000, what: 'waiting state' });
    await p.locator(`.item[data-id="${s.id}"]`).click();
    await p.getByText('Proceed with the fix?').first().waitFor({ timeout: 5000 });
    await p.shot('question');
    await p.getByRole('button', { name: /Yes$/ }).first().click();
    await settled(s.id, ['review', 'done']);
    p.clean();
  });

  await check('WEB-08', 'approve in Edits mode', async () => {
    const s = await launch({ prompt: 'APPROVE then publish', mode: 'edits' });
    await until(async () => (await session(s.id)).state === 'waiting', { timeout: 20000, what: 'approval' });
    await p.locator(`.item[data-id="${s.id}"]`).click();
    await p.getByRole('button', { name: /^\d?\s*Allow$/ }).first().waitFor({ timeout: 5000 });
    await p.shot('approval');
    await p.getByRole('button', { name: /^\d?\s*Allow$/ }).first().click();
    await settled(s.id, ['review', 'done']);
    p.clean();
  });

  await check('WEB-09', 'stop a running task', async () => {
    const s = await launch({ prompt: 'a long task', agent: 'claude' });
    await api(w.url, `/api/sessions/${s.id}/stop`, {});
    const after = await until(async () => {
      const x = await session(s.id);
      return x.state !== 'running' && x;
    }, { timeout: 10000, what: 'stop' });
    ok(after.state !== 'running', `still ${after.state}`);
  });

  await check('WEB-10', 'mark done, archive, delete', async () => {
    await p.locator(`.item[data-id="${first.id}"]`).click();
    await p.waitForTimeout(300);
    await press(p, 'e');
    await until(async () => (await session(first.id)).state === 'done', { timeout: 3000, what: 'done' });
    const a = await api(w.url, `/api/sessions/${first.id}`, { archived: true }, 'PATCH');
    ok(a.status === 200 && a.json.archived, `archive ${a.status}`);
    await until(async () => !(await p.locator(`.item[data-id="${first.id}"]`).isVisible()), { timeout: 3000, what: 'archived card to leave the list' });
    const tmp = await launch({ prompt: 'to delete' });
    await settled(tmp.id);
    const d = await api(w.url, `/api/sessions/${tmp.id}`, {}, 'DELETE');
    ok(d.status === 200, `delete ${d.status}`);
    ok((await api(w.url, `/api/sessions/${tmp.id}`)).status === 404, 'still there after delete');
    p.clean();
  });

  let fresh;
  await check('WEB-11', 'transcript and diff viewer', async () => {
    fresh = await launch({ prompt: 'NARRATE the fix' });
    await settled(fresh.id);
    await p.locator(`.item[data-id="${fresh.id}"]`).click();
    await p.getByText('1 file').first().waitFor({ timeout: 8000 });
    await press(p, 'v');
    await p.waitForTimeout(800);
    await p.shot('transcript');
    await press(p, 'v');
    await p.locator('.it-body:visible button[data-tab="changes"]').first().click();
    await p.getByText('math.js').first().waitFor({ timeout: 5000 });
    await p.shot('diff');
    await press(p, 'Escape');
    p.clean();
  });

  await check('WEB-12', 'command palette', async () => {
    await press(p, process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await p.locator('.palette input').waitFor();
    await p.locator('.palette input').fill('long task');
    await p.locator('.pal-row', { hasText: 'a long task' }).first().waitFor();
    await p.shot('palette');
    await press(p, 'Escape');
    await until(async () => !(await p.locator('.palette').isVisible()), { timeout: 2000, what: 'palette to close on Esc' });
    p.clean();
  });

  await check('WEB-13', 'split view is the only layout: no feed, no switch', async () => {
    await press(p, 'Escape');
    await p.locator('body').click({ position: { x: 700, y: 5 } }).catch(() => {});
    await press(p, '\\');
    await p.waitForTimeout(400);
    const split = () => p.evaluate(() => document.body.classList.contains('split'));
    ok(await split(), '\\ left split view');
    await p.reload();
    await p.waitForTimeout(1500);
    ok(await split(), 'no split view after a reload');
    await p.locator('#meBtn').click(); // Settings is in the avatar's menu
    await p.locator('#settingsBtn').click();
    await p.locator('section.sx-pane[data-pane="general"]').waitFor({ state: 'visible', timeout: 3000 });
    ok(!(await p.locator('.view-seg').count()), 'Settings still has a Layout switch');
    await press(p, 'Escape');
    await until(async () => !(await p.locator('#overlay').isVisible()), { timeout: 2000, what: 'Settings to close on Esc' });
    await p.evaluate(() => document.activeElement?.blur()); // the reload focused the prompt box
    p.clean();
  });

  await check('WEB-14', 'keyboard: J / K / N / Esc', async () => {
    await press(p, 'Escape');
    await press(p, 'j');
    await p.waitForTimeout(400);
    const one = await p.locator('#splitHead').getAttribute('data-id');
    await press(p, 'j');
    await p.waitForTimeout(400);
    const two = await p.locator('#splitHead').getAttribute('data-id');
    await press(p, 'k');
    await p.waitForTimeout(400);
    const back = await p.locator('#splitHead').getAttribute('data-id');
    ok(one && two && one !== two && back === one, `J/K ids ${one} ${two} ${back}`);
    await press(p, 'Escape');
    await p.waitForTimeout(300);
    await press(p, 'n');
    await p.waitForTimeout(300);
    ok(await p.evaluate(() => document.activeElement?.id === 'prompt'), 'N did not focus the prompt');
    p.clean();
  });

  await check('WEB-15', 'settings: every pane opens', async () => {
    await press(p, 'Escape');
    await p.locator('#meBtn').click(); // Settings is in the avatar's menu
    await p.locator('#settingsBtn').click();
    const panes = ['general', 'notifications', 'agents', 'auto', 'machines', 'cloud', 'memory', 'automations', 'spells', 'usage', 'privacy'];
    for (const id of panes) {
      await p.locator(`button[role="tab"][data-pane="${id}"]`).click();
      const pane = p.locator(`section.sx-pane[data-pane="${id}"]`);
      await pane.waitFor({ state: 'visible', timeout: 3000 });
      if (id === 'agents') await pane.getByText('Claude Code').first().waitFor({ timeout: 5000 });
      ok(!/NaN|undefined|\[object Object\]/.test(await pane.innerText()), `${id} pane shows NaN/undefined`);
      await p.screenshot({ path: path.join(OUT, `web-settings-${id}.png`) });
    }
    await press(p, 'Escape');
    p.clean();
  });

  await check('WEB-16', 'light and dark themes', async () => {
    for (const scheme of ['light', 'dark']) {
      const q = await page({ colorScheme: scheme });
      await q.goto(w.url);
      await q.getByText('What should wisp do next?').waitFor();
      await q.shot(`home-${scheme}`);
      await q.locator(`.item[data-id="${fresh.id}"]`).click();
      await q.waitForTimeout(1200);
      await q.shot(`task-${scheme}`);
      const bg = await q.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const lum = bg.match(/\d+/g).slice(0, 3).reduce((a, b) => a + Number(b), 0) / 3;
      ok(scheme === 'dark' ? lum < 80 : lum > 180, `${scheme} body background ${bg}`);
      q.clean();
      await q.context().close();
    }
  });

  await check('WEB-17', 'narrow window stacks: the list, a task as a page, Back to the list where it was', async () => {
    const q = await page({ viewport: { width: 860, height: 600 } });
    await q.goto(w.url);
    await q.waitForTimeout(1500);
    const st = () => q.evaluate(() => ({ stack: document.body.classList.contains('stack'), page: document.body.classList.contains('stack-page'), top: document.querySelector('#feedWrap').scrollTop }));
    const a = await st();
    ok(a.stack && !a.page, `not the stacked list at 860px (${JSON.stringify(a)})`);
    await noOverflow(q);
    await q.shot('narrow');
    await q.evaluate(() => (document.querySelector('#feedWrap').scrollTop = 40));
    const before = (await st()).top;
    await q.locator(`.item[data-id="${fresh.id}"] .it-head`).click();
    await q.waitForTimeout(600);
    ok((await st()).page, 'opening a task did not open its page');
    ok(await q.locator('#splitHead .sh-back').isVisible(), 'no Back on the task page');
    await q.shot('narrow-task');
    await q.locator('#splitHead .sh-back').click();
    await q.waitForTimeout(300);
    const b = await st();
    ok(!b.page && b.top === before, `Back: page ${b.page}, list at ${b.top} (was ${before})`);
    await q.locator('#splitNew').click();
    await q.waitForTimeout(300);
    ok((await st()).page && (await q.evaluate(() => document.activeElement?.id === 'prompt')), 'New task did not open home with the prompt focused');
    await press(q, 'Escape'); // out of the prompt
    await press(q, 'Escape'); // home → the list
    await q.waitForTimeout(300);
    ok(!(await st()).page, 'Esc did not go back to the list');
    q.clean();
    await q.context().close();
  });

  await check('WEB-18', 'phone width: no overflow, long URLs wrap', async () => {
    const url = 'https://example.com/' + 'a-very-long-path-segment/'.repeat(12);
    const s = await launch({ prompt: `check ${url}` });
    await settled(s.id);
    const q = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await q.goto(w.url);
    await q.waitForTimeout(1500);
    await noOverflow(q);
    await q.shot('phone-home');
    await q.locator(`.item[data-id="${s.id}"]`).first().click();
    await q.waitForTimeout(1500);
    await noOverflow(q);
    await q.shot('phone-task');
    // The follow-up box is one line until you're in it: its bar (and the mode button) shows then.
    await q.locator('.it-body:visible .reply').first().click();
    const mode = await q.locator('.it-body:visible .c-mode').first().boundingBox();
    ok(mode && mode.height <= 44, `follow-up mode button wraps (${mode?.height}px tall)`);
    ok(!(await q.locator('.collapse-all').isVisible()), 'floating Collapse shows over the card on a phone');
    q.clean();
    await q.context().close();
  });

  await check('WEB-19', 'spells: install, use, turn off', async () => {
    const { SPELL_EXAMPLES } = await import('../server/spell-guide.js');
    const spell = SPELL_EXAMPLES.find((e) => e.spell.id === 'tool-stats').spell;
    const r = await api(w.url, '/api/spells', { spell, enable: true });
    ok(r.status < 300, `install ${r.status} ${r.text.slice(0, 200)}`);
    await p.reload();
    const btn = p.getByRole('button', { name: 'Tools' }).first();
    await btn.waitFor({ timeout: 5000 });
    await btn.click();
    await p.getByText('Tool calls · last 30 days').first().waitFor({ timeout: 5000 });
    await p.shot('spell-panel');
    await press(p, 'Escape');
    const off = await api(w.url, `/api/spells/${spell.id}`, { enabled: false }, 'PATCH');
    ok(off.status < 300, `turn off ${off.status} ${off.text.slice(0, 200)}`);
    await until(async () => !(await p.getByRole('button', { name: 'Tools' }).count()), { timeout: 5000, what: 'spell button to go' });
    p.clean();
  });

  await check('WEB-20', 'recipes: saved, shown, run', async () => {
    const r = await api(w.url, '/api/recipes', { name: 'qa-release', prompt: 'release {version} please' });
    ok(r.status === 201, `save ${r.status} ${r.text}`);
    await p.reload();
    await p.getByText('qa-release').first().waitFor({ timeout: 5000 });
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin/wisp.js'), 'run', 'qa-release', '0.0.1', '--json', '-C', w.repo, '--port', String(PORT)], { env: w.env, encoding: 'utf8' });
    const s = JSON.parse(out);
    ok(/release 0\.0\.1 please/.test(s.prompt || s.title || JSON.stringify(s)), `param not filled: ${out.slice(0, 200)}`);
    p.clean();
  });

  await check('WEB-21', 'compare two harnesses', async () => {
    const s = await launch({ prompt: 'compare this', compare: [{ agent: 'codex' }] });
    ok(s.group?.length === 2 || s.group?.length >= 2, `group ${JSON.stringify(s.group)?.slice(0, 200)}`);
    for (const g of s.group) await settled(g.id || g);
  });

  await check('WEB-22', '/btw side question', async () => {
    const turns = (await session(fresh.id)).turns.length;
    const r = await api(w.url, `/api/sessions/${fresh.id}/btw`, { text: 'did you update the docs?' });
    ok(r.status === 200, `btw ${r.status} ${r.text.slice(0, 200)}`);
    ok((await session(fresh.id)).turns.length === turns, 'btw added a turn');
  });

  await check('WEB-23', 'Machines, Automations, Get the app open from the avatar menu and close', async () => {
    for (const [label, sel] of [['Machines', '#machinesBtn'], ['Automations', '#autoBtn'], ['Get the app', '#getAppBtn']]) {
      await press(p, 'Escape');
      await p.locator('#meBtn').click(); // they're rows in the avatar's menu
      await p.locator(sel).click();
      await p.waitForTimeout(500);
      ok(await p.locator('#meMenu').isHidden(), `the menu stayed open after ${label}`);
      await p.screenshot({ path: path.join(OUT, `web-menu-${label.replace(/ /g, '-').toLowerCase()}.png`) });
      await press(p, 'Escape');
      await p.waitForTimeout(300);
    }
    p.clean();
  });

  await check('WEB-24', 'usage counts the tasks', async () => {
    const u = await api(w.url, '/api/usage');
    ok(u.status === 200, `usage ${u.status}`);
    ok(!/NaN/.test(u.text), 'NaN in usage');
    await p.locator('#meBtn').click(); // Settings is in the avatar's menu
    await p.locator('#settingsBtn').click();
    await p.locator('button[role="tab"][data-pane="usage"]').click();
    await p.waitForTimeout(800);
    const txt = await p.locator('section.sx-pane[data-pane="usage"]').innerText();
    ok(!/NaN|undefined/.test(txt), 'Usage pane shows NaN/undefined');
    await press(p, 'Escape');
    p.clean();
  });

  await check('WEB-25', 'CLI against the running server', async () => {
    const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'bin/wisp.js'), ...a, '--port', String(PORT)], { env: w.env, encoding: 'utf8', timeout: 60000 });
    ok(cli('--version').trim().endsWith(version), 'version');
    const res = JSON.parse(cli('add a test from the CLI', '--wait', '--json', '-C', w.repo, '--agent', 'claude'));
    ok(res.id && /review|done/.test(res.state), `wait result ${JSON.stringify(res).slice(0, 200)}`);
    const ls = JSON.parse(cli('ls', '--json'));
    ok(ls.some((s) => s.id === res.id), 'ls misses the task');
    ok(cli('show', res.id).length > 20, 'show printed nothing');
  });

  await check('WEB-26', 'MCP server lists its tools', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/wisp.js'), 'mcp'], { env: { ...w.env, WISP_PORT: String(PORT) } });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    try {
      await until(() => /"id":2/.test(buf), { timeout: 10000, what: 'tools/list' });
    } finally {
      child.kill();
    }
    for (const t of ['wisp_launch', 'wisp_wait', 'wisp_reply']) ok(buf.includes(t), `missing ${t}`);
  });

  await check('WEB-27', 'reload keeps the open task', async () => {
    await press(p, 'Escape');
    await p.locator(`.item[data-id="${fresh.id}"]`).click();
    await p.waitForTimeout(500);
    await p.reload();
    await p.waitForTimeout(2000);
    const open = await p.locator('#splitHead').getAttribute('data-id');
    ok(open === fresh.id, `after reload open task is ${open}`);
    p.clean();
  });

  await check('WEB-31', 'docs site builds and renders', async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/site.mjs')], { cwd: ROOT, stdio: 'ignore' });
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      const q = await page({ viewport: vp });
      await q.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
      await q.goto('file://' + path.join(ROOT, 'docs/index.html'));
      await q.waitForTimeout(1500);
      q.errors = q.errors.filter((e) => !/net::ERR_FAILED|posthog|Failed to load resource|CORS|file:/.test(e));
      await noOverflow(q);
      await q.shot(`site-${label}`);
      q.clean();
      await q.context().close();
    }
  });
} finally {
  await browser.close();
  w.stop();
}
process.exit(done());
