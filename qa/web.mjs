// QA for wisp in the browser: the scenarios in qa/scenarios/web.md, against a QA wisp
// (own home, port and repo, fake agents). `node qa/web.mjs` → qa/out/web.json + screenshots.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeClone, until } from '../test/helpers.js';
import { api, launchBrowser, ok, OUT, ROOT, runner, startWisp } from './lib.mjs';

const PORT = Number(process.env.QA_WEB_PORT) || 4493;
const { check: run, done } = runner('web');
// A failing check leaves a screenshot of the main page behind (web-fail-<id>.png).
// ONLY=WEB-67 runs that scenario alone (several: comma-separated).
const only = process.env.ONLY?.split(',');
const check = (id, title, fn) =>
  (!only || only.includes(id)) &&
  run(id, title, async () => {
    try {
      await fn();
    } catch (err) {
      await p?.shot(`fail-${id}`).catch(() => {});
      throw err;
    }
  });
const w = await startWisp({ port: PORT, extraEnv: { FAKE_GH_STATE: path.join(OUT, 'web-gh.json') } });
const browser = await launchBrowser({ headless: process.env.HEADED !== '1' });
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// A page that records uncaught errors and console.error; `clean()` throws if there were any.
async function page(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => {
    // WebKit logs a fetch cut off by a reload as an access control failure, and Playwright's own
    // screenshot style as refused by a sandboxed frame's CSP. Neither is the page's.
    if (m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|due to access control checks|Refused to apply a stylesheet/.test(m.text())) p.errors.push(m.text());
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
    // The greeting is in index.html; Needs you and the tasks paint once /api answers, so wait for them.
    for (const t of ['New task', 'Needs you', 'Welcome to wisp', 'Tips'])
      await p.getByText(t, { exact: false }).first().waitFor({ timeout: 10_000 }).catch(() => ok(false, `"${t}" not visible`));
    // Before the first task the launcher is the prompt, how it runs and Send; the rest is behind More options (#520).
    await p.locator('#launcher.first-run').waitFor({ timeout: 10_000 }).catch(() => ok(false, 'a fresh home is not a first-run launcher'));
    ok(await p.locator('#whereBtn').isHidden(), 'the place button shows before More options');
    await p.shot('home');
    await p.locator('#launchMore').click();
    ok(await p.locator('#launcher.first-run').count() === 0, 'More options did not open the full launcher');
    // The launcher is under 800px wide here, so the place shows as its icon; its title names it.
    ok(await p.locator('#whereBtn').isVisible(), 'the place button is not visible after More options');
    ok(/this computer/i.test(await p.locator('#whereBtn').getAttribute('title')), 'the place button does not say this computer');
    ok(await p.locator('#launchMore').isHidden(), 'More options still shows once opened');
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
    await p.locator('.b-flow .wire.back').waitFor({ state: 'attached' });
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
    // Side by side at 1000px a picked project adds Worktree: the harness keeps its name, Worktree folds to its icon.
    await p.setViewportSize({ width: 1000, height: 900 });
    await p.locator('#wtBtn').waitFor();
    await p.waitForTimeout(200);
    const rb = await p.evaluate(() => { const h = document.querySelector('.runners .rb-h'); return { h: h.textContent, cut: h.scrollWidth > h.clientWidth }; });
    ok(!rb.cut, `harness name "${rb.h}" cut off in the launcher at 1000px`);
    await p.setViewportSize({ width: 1440, height: 900 });
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
    // Named after what was asked (#728), not the agent's report: the card says it's done in its line.
    await until(async () => /finished/i.test(await p.locator(`.item[data-id="${first.id}"]`).innerText()), { timeout: 15000, what: 'card to finish' });
    ok(/fix the add bug from the launcher/.test(await p.locator(`.item[data-id="${first.id}"]`).innerText()), 'the card is not named after the prompt');
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

  await check('WEB-06c', 'the reader holds, the tail follows, Latest says what landed', async () => {
    // The fake's answers are short: room to scroll, so there's somewhere to read from.
    const room = await p.addStyleTag({ content: '#feed .item.open .turn { min-height: 1400px; }' });
    const body = () => p.locator('#feed .item.open > .it-body');
    const top = () => body().evaluate((b) => b.scrollTop);
    const pill = p.locator('#feed .item.open .latest-pill');
    const lastTop = () => body().evaluate((b) => [...b.querySelectorAll('.turn')].at(-1).getBoundingClientRect().top - b.getBoundingClientRect().top);
    const another = async (text) => {
      const had = (await session(first.id)).turns.length;
      await api(w.url, `/api/sessions/${first.id}/reply`, { text });
      await until(async () => (await session(first.id)).turns?.length > had, { timeout: 5000, what: 'a new turn' });
      await settled(first.id);
      await p.waitForTimeout(900);
    };
    await body().evaluate((b) => (b.scrollTop = 300));
    await p.waitForTimeout(200);
    await another('in the middle of reading');
    ok(Math.abs((await top()) - 300) <= 1, `the reader moved to ${await top()}`);
    ok(await pill.isVisible(), 'no Latest pill');
    await pill.click();
    await p.waitForTimeout(900);
    ok(!(await pill.isVisible()), 'Latest stayed after its click');
    ok((await lastTop()) < 200, `Latest landed ${await lastTop()}px down`);
    await body().evaluate((b) => (b.scrollTop = b.scrollHeight));
    await p.waitForTimeout(200);
    await another('at the end');
    ok(Math.abs(await lastTop()) < 200, `the answer landed ${await lastTop()}px away`);
    ok(!(await pill.isVisible()), 'a pill at the tail');
    await room.evaluate((x) => x.remove());
    p.clean();
  });

  await check('WEB-06d', 'the overlap warning arriving keeps a reader at the end there', async () => {
    const room = await p.addStyleTag({ content: '#feed .item.open .turn { min-height: 1400px; }' });
    // The server sends overlaps seconds after a run ends: here it comes with the reader exactly at the end.
    const gap = await p.evaluate(async (id) => {
      const [{ S }, { renderOverlapStrip }] = await Promise.all([import('/js/core/state.js'), import('/js/features/overlaps.js')]);
      const s = S.sessions.get(id);
      const body = document.querySelector('#feed .item.open > .it-body');
      const had = s.overlaps;
      s.overlaps = [];
      renderOverlapStrip(id);
      body.scrollTop = body.scrollHeight;
      s.overlaps = [{ id: 'other', title: 'Another task', files: ['math.js'] }];
      renderOverlapStrip(id);
      const left = body.scrollHeight - body.clientHeight - body.scrollTop;
      s.overlaps = had;
      renderOverlapStrip(id);
      return left;
    }, first.id);
    ok(gap <= 1, `the strip left the reader ${gap}px from the end`);
    await room.evaluate((x) => x.remove());
    p.clean();
  });

  await check('WEB-06b', 'rename keeps the task open', async () => {
    const head = p.locator(`#splitHead:not([hidden])[data-id="${first.id}"]`);
    const title = head.locator('.sh-title');
    // Enter saves the name; Escape cancels the next one. Neither may close the task or go back.
    await title.dblclick();
    await p.locator(`#splitHead[data-id="${first.id}"] .sh-title[contenteditable="true"]`).waitFor({ timeout: 3000 });
    await p.keyboard.type('renamed from its header');
    await p.keyboard.press('Enter');
    await until(async () => (await session(first.id)).title === 'renamed from its header', { timeout: 5000, what: 'title saved' });
    ok(await head.isVisible(), 'Enter after a rename closed the task');
    await title.dblclick();
    await p.locator(`#splitHead[data-id="${first.id}"] .sh-title[contenteditable="true"]`).waitFor({ timeout: 3000 });
    await p.keyboard.type('never saved');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    ok(await head.isVisible(), 'Escape after a rename left the task');
    ok((await title.textContent()) === 'renamed from its header', `Escape kept "${await title.textContent()}"`);
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
    // One answer box: the card has none, the reply box answers it, whatever mode is picked under it.
    const t = await launch({ prompt: 'ASK before you fix it', mode: 'plan' });
    await until(async () => (await session(t.id)).state === 'waiting', { timeout: 20000, what: 'waiting state' });
    await p.locator(`.item[data-id="${t.id}"]`).click();
    await p.getByText('Proceed with the fix?').first().waitFor({ timeout: 5000 });
    ok((await p.locator('.ask-card:visible input, .ask-card:visible textarea, .ask-card:visible form').count()) === 0, 'the question card has a text box of its own');
    const reply = p.locator('.composer .reply:visible');
    ok((await reply.getAttribute('placeholder')) === 'Answer Claude Code…', `the reply box says "${await reply.getAttribute('placeholder')}"`);
    await p.locator('.composer .c-mode:visible').click();
    await p.locator('button[data-mode="auto"]:visible').first().click();
    await reply.fill('only the tests, please');
    await reply.press('Enter');
    ok((await reply.inputValue()) === '', 'the reply box kept the answer');
    const answered = await settled(t.id, ['review', 'done']);
    ok(answered.turns.length === 1 && answered.turns[0].activity.some((a) => a.label === 'You answered: only the tests, please'), 'the typed words did not answer the question');
    ok(answered.mode === 'plan', `the answer ran a new turn in ${answered.mode}`);
    ok((await p.locator('.composer .c-mode:visible').textContent()).includes('Full auto'), 'the Full auto pick went with the answer');
    p.clean();
  });

  await check('WEB-07', 'a long question keeps its answers above the reply box', async () => {
    const s = await launch({ prompt: 'ASKLONG before you fix it' });
    await until(async () => (await session(s.id)).state === 'waiting', { timeout: 20000, what: 'waiting state' });
    await p.locator(`.item[data-id="${s.id}"]`).click();
    await p.getByRole('button', { name: /Yes$/ }).first().waitFor({ timeout: 5000 });
    const seen = await p.evaluate(() => {
      const box = document.querySelector('.item.open .composer').getBoundingClientRect().top;
      return [...document.querySelectorAll('.ask-card .opt')].map((o) => o.getBoundingClientRect().bottom <= box);
    });
    ok(seen.length === 2 && seen.every(Boolean), `answers on screen: ${seen}`);
    await p.shot('question-long');
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
    // Typed in the reply box, words deny the call and pass on, as the card's old box did.
    const t = await launch({ prompt: 'APPROVE then publish', mode: 'edits' });
    await until(async () => (await session(t.id)).state === 'waiting', { timeout: 20000, what: 'approval' });
    await p.locator(`.item[data-id="${t.id}"]`).click();
    await p.getByRole('button', { name: /^\d?\s*Deny$/ }).first().waitFor({ timeout: 5000 });
    ok((await p.locator('.ask-card:visible input, .ask-card:visible textarea, .ask-card:visible form').count()) === 0, 'the approval card has a text box of its own');
    const reply = p.locator('.composer .reply:visible');
    ok((await reply.getAttribute('placeholder')) === 'Or say what to do instead (denies it)…', `the reply box says "${await reply.getAttribute('placeholder')}"`);
    await reply.fill('do a dry run instead');
    await reply.press('Enter');
    const denied = await settled(t.id, ['review', 'done']);
    ok(denied.turns[0].activity.some((a) => a.label === 'You denied: run `npm publish` (“do a dry run instead”)'), 'the typed words did not deny the call');
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
    ok((await p.locator('.it-body:visible').count()) === 0 && (await p.locator('#prompt').isVisible()) && !(await p.locator('#prompt').inputValue()), 'done should go to New task (empty prompt), not open another task');
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

  await check('WEB-47', 'side panel Changes: Ship it empties the commit box and the counts, in every window', async () => {
    fs.rmSync(path.join(OUT, 'web-gh.json'), { force: true });
    const repo = makeClone();
    const m = await launch({ prompt: 'Fix add()', cwd: repo.dir, mode: 'auto' });
    const dir = (await settled(m.id)).worktree.path;
    const q = await page();
    const other = await page(); // a second window hears of it from the server alone
    const open = async (x) => {
      await x.goto(`${w.url}/`);
      await x.locator(`.item[data-id="${m.id}"]`).first().click({ position: { x: 100, y: 16 } });
      await x.waitForSelector(`#splitHead[data-id="${m.id}"]`, { timeout: 10000 });
      await blur(x);
      await x.keyboard.press('d');
      await x.waitForSelector('.cx-commit:not([hidden])', { timeout: 10000 });
      ok(/uncommitted/.test(await x.locator('.pn-place').innerText()), 'uncommitted before the ship');
    };
    await open(q);
    await open(other);
    await blur(q);
    await q.keyboard.press('s');
    await q.locator('.ship-modal .primary').click();
    await until(async () => (await session(m.id)).pr, { timeout: 15000, what: 'the PR' });
    for (const x of [q, other]) {
      await x.waitForSelector('.cx-commit', { state: 'hidden', timeout: 5000 });
      await until(async () => !/uncommitted/.test(await x.locator('.pn-place').innerText()), { timeout: 5000, what: 'the counts' });
      ok((await x.locator('.cx-row').count()) > 0, 'the branch keeps its files');
      ok(!(await x.locator('.cx-row button.cx-stage').count()), 'no Stage on committed files');
      x.clean();
    }
    ok(!execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' }).trim(), 'the worktree is clean');
    await q.context().close();
    await other.context().close();
  });

  await check('WEB-47', 'side panel Changes: the first file opens, or all of three or fewer, and a fold stays', async () => {
    const changes = (t) => p.locator(`.item[data-id="${t.id}"] [data-a="changes"]`).filter({ visible: true }).first();
    const opened = async (files) => {
      const t = await launch({ prompt: 'fix the add function' });
      const s = await settled(t.id);
      const dir = s.worktree?.cwd || s.cwd;
      for (const f of files) fs.writeFileSync(path.join(dir, f), 'export const x = 1;\n');
      await p.locator(`.item[data-id="${t.id}"] .it-head`).click();
      await p.waitForTimeout(300);
      if (!(await p.locator('.pn-changes:visible').count())) await changes(t).click(); // a second click puts it away
      await p.locator('.pn-changes .cx-file.open').first().waitFor({ timeout: 8000 });
      return { t, rows: await p.locator('.pn-changes .cx-file').count(), open: await p.locator('.pn-changes .cx-file.open').count() };
    };
    const few = await opened(['open-a.js']);
    ok(few.rows <= 3 && few.open === few.rows, `every one of a few opens: ${few.open} of ${few.rows}`);
    await p.locator('.pn-changes .cx-file.open .cx-row').first().click();
    await p.evaluate(() => dispatchEvent(new Event('focus')));
    await p.waitForTimeout(600);
    ok((await p.locator('.pn-changes .cx-file.open').count()) === few.open - 1, 'a file you fold stays folded');
    const many = await opened(['open-a.js', 'open-b.js', 'open-c.js', 'open-d.js']);
    ok(many.rows > 3 && many.open === 1, `only the first of many opens: ${many.open} of ${many.rows}`);
    await changes(many.t).click();
    // Files that arrive with Changes open: a first look with nothing to open doesn't use up the opening,
    // a few all open as they would after a reload, and your fold stops it.
    const t = await launch({ prompt: 'say hello', cwd: makeClone().dir, mode: 'auto' });
    const dir = (await settled(t.id)).worktree.path;
    execFileSync('git', ['checkout', 'origin/main', '--', 'math.js'], { cwd: dir }); // the fake's edit: nothing of its own to open
    // Until the file shows: a look at Changes takes from 0.1 to 1.6 s, in any engine.
    const refresh = async (file) => {
      await p.evaluate(() => dispatchEvent(new Event('focus')));
      await until(async () => (await shown()).some((f) => f.path === file), { timeout: 8000, what: `${file} in Changes` });
    };
    const shown = () => p.evaluate(() => [...document.querySelectorAll('.pn-changes .cx-file')].filter((x) => x.offsetParent).map((x) => ({ path: x.dataset.k.slice(2), open: x.classList.contains('open') })));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
    await p.locator(`.item[data-id="${t.id}"] .it-head`).click();
    await p.waitForTimeout(300);
    if (!(await p.locator('.pn-changes:visible').count())) await changes(t).click();
    await p.locator('.pn-changes .cx-fold').waitFor({ timeout: 8000 });
    ok((await p.locator('.pn-changes .cx-file.open').count()) === 0, 'only a generated file: nothing opens');
    fs.writeFileSync(path.join(dir, 'arrive-a.js'), 'export const a = 1;\n');
    await refresh('arrive-a.js');
    const one = await shown();
    ok(one.find((f) => f.path === 'arrive-a.js')?.open, `a file arriving after a first look with nothing to open opens: ${JSON.stringify(one)}`);
    fs.writeFileSync(path.join(dir, 'arrive-b.js'), 'export const b = 1;\n');
    await refresh('arrive-b.js');
    const two = await shown();
    ok(two.filter((f) => f.open).length === two.length && two.length > 1, `a few arriving all open, as after a reload: ${JSON.stringify(two)}`);
    await p.locator('.pn-changes .cx-file.open .cx-row').first().click();
    fs.writeFileSync(path.join(dir, 'arrive-c.js'), 'export const c = 1;\n');
    await refresh('arrive-c.js');
    const three = await shown();
    ok(three.find((f) => f.path === 'arrive-c.js') && !three.find((f) => f.path === 'arrive-c.js').open && three.filter((f) => f.open).length === two.length - 1, `after your fold nothing else opens: ${JSON.stringify(three)}`);
    await changes(t).click();
  });

  await check('WEB-47', 'side panel Changes: a long folder is cut to …/, never a bare ./', async () => {
    const t = await launch({ prompt: 'fix the add function' });
    const s = await settled(t.id);
    const deep = path.join(s.worktree?.cwd || s.cwd, 'web/css/components/a-very-long-folder-name-for-testing/another-really-long-folder');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'a-file-with-a-rather-long-name-indeed.css'), '.a { color: red; }\n');
    await p.locator(`.item[data-id="${t.id}"] .it-head`).click();
    await p.locator(`.item[data-id="${t.id}"] [data-a="changes"]`).filter({ visible: true }).first().click();
    const dir = p.locator('.pn-changes .cx-row .dir').filter({ visible: true }).first();
    await dir.waitFor({ timeout: 8000 });
    // The folder shrinks first; it must keep room for its "…/" (a sliver shows one dot: "./").
    const { width, need } = await dir.evaluate((d) => {
      const c = document.createElement('canvas').getContext('2d');
      c.font = getComputedStyle(d).font;
      return { width: d.getBoundingClientRect().width, need: c.measureText('…/').width };
    });
    ok(width + 0.5 >= need, `the folder is ${width.toFixed(1)}px wide, "…/" needs ${need.toFixed(1)}px`);
    // A long name drops the controls under it rather than being cut, and they keep their columns.
    const long = await p.locator('.pn-changes .cx-file[data-path$="indeed.css"]').evaluate((f) => {
      const b = f.querySelector('.base');
      const col = (n) => Math.round(n.querySelector('.cx-more').getBoundingClientRect().right);
      return { shown: b.clientWidth, full: b.scrollWidth, same: [...document.querySelectorAll('.pn-changes .cx-file')].every((x) => col(x) === col(f)) };
    });
    ok(long.shown >= long.full, `the name shows ${long.shown}px of ${long.full}px`);
    ok(long.same, 'the controls are in the same column on every row');
    await p.shot('changes');
    await press(p, 'Escape');
    p.clean();
  });

  await check('WEB-12', 'command palette', async () => {
    await press(p, process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await p.locator('.palette input').waitFor();
    await p.locator('.palette input').fill('long task');
    await p.locator('.pal-row', { hasText: 'a long task' }).first().waitFor();
    // The overlay fades in (modals.css): shot mid-fade, the home page shows through the palette.
    await until(async () => (await p.evaluate(() => getComputedStyle(document.querySelector('.overlay:has(.palette)')).opacity)) === '1', { timeout: 2000, what: 'palette to fade in' });
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

  await check('WEB-14b', 'ctrl+tab switches tasks', async () => {
    const head = () => p.locator('#splitHead').getAttribute('data-id');
    await press(p, 'Escape');
    await press(p, 'j');
    await p.waitForTimeout(400);
    const a = await head();
    await press(p, 'j');
    await p.waitForTimeout(400);
    const b = await head();
    await p.keyboard.press('Control+Tab');
    await p.waitForTimeout(400);
    ok((await head()) === a, 'a tap goes back to the last task');
    ok(!(await p.locator('.switcher').count()), 'a tap draws nothing');
    await p.keyboard.press('Control+Tab');
    await p.waitForTimeout(400);
    ok((await head()) === b, 'a second tap returns');
    await p.keyboard.down('Control');
    await p.keyboard.press('Tab');
    await p.keyboard.press('Tab');
    await p.waitForTimeout(200);
    ok(await p.locator('.switcher .pal-row.on').count(), 'held, the list shows');
    await p.keyboard.press('Escape');
    await p.keyboard.up('Control');
    await p.waitForTimeout(300);
    ok((await head()) === b && !(await p.locator('.switcher').count()), 'Esc stays put');
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
    await q.locator(`.item[data-id="${fresh.id}"] .it-head`).scrollIntoViewIfNeeded(); // the click would scroll it there
    const before = (await st()).top;
    await q.locator(`.item[data-id="${fresh.id}"] .it-head`).click();
    await q.waitForTimeout(600);
    ok((await st()).page, 'opening a task did not open its page');
    ok(await q.locator('#splitHead .sh-back').isVisible(), 'no Back on the task page');
    await q.shot('narrow-task');
    // Wide enough for the details column: one fact a row, none running off the page (#352's
    // phone bar used to put the state, harness and project on one clipped line here).
    const facts = await q.evaluate(() => {
      const props = document.querySelector('.item.open .it-props');
      const rows = [...props.children].filter((c) => c.offsetWidth && !c.matches('.q-time')).map((c) => c.getBoundingClientRect());
      return { pane: document.body.classList.contains('pane-wide'), right: Math.max(...rows.map((r) => r.right)), tops: rows.map((r) => Math.round(r.top)), vw: innerWidth };
    });
    ok(facts.pane, 'no details column on the 860px task page');
    ok(facts.right <= facts.vw, `the task's facts run off the page (${facts.right} > ${facts.vw})`);
    ok(new Set(facts.tops).size === facts.tops.length, `the task's facts share a row: ${facts.tops}`);
    // A phone in landscape: as wide, but too short for the column, whose actions would sit below
    // the window. The bar over the task keeps every action on screen.
    await q.setViewportSize({ width: 860, height: 390 });
    await q.waitForTimeout(400);
    const low = await q.evaluate(() => ({
      pane: document.body.classList.contains('pane-wide'),
      acts: [...document.querySelectorAll('.item.open .it-actions > button')].filter((b) => b.offsetWidth).map((b) => Math.round(b.getBoundingClientRect().bottom)),
      vh: innerHeight,
    }));
    ok(!low.pane, 'a details column on an 860×390 task page');
    ok(low.acts.length && low.acts.every((y) => y <= low.vh), `the task's actions are off the window at 390px tall (${low.acts} > ${low.vh})`);
    await q.shot('narrow-task-landscape');
    await q.setViewportSize({ width: 860, height: 600 });
    await q.waitForTimeout(300);
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

  await check('WEB-56', 'the keyboard stays in the reply box after Send', async () => {
    const m = await launch({ prompt: 'Keys after Send', mode: 'auto' });
    await settled(m.id);
    await p.locator(`.item[data-id="${m.id}"]`).click();
    const box = p.locator('.composer textarea:visible').first();
    await box.click();
    await box.fill('One more thing');
    await p.keyboard.press('Enter');
    await p.locator(`#secWorking .item[data-id="${m.id}"]`).waitFor();
    await p.keyboard.type('edit');
    ok((await box.inputValue()) === 'edit', `the box has "${await box.inputValue()}"`);
    ok(!(await p.locator('.ask-pop').count()), 'a shortcut asked to take over');
    await box.fill('');
    p.clean();
  });

  await check('WEB-64', 'the Enter that picks an IME word sends nothing', async () => {
    await p.locator('#splitNew:visible, #promptFab:visible').first().click();
    const box = p.locator('#prompt');
    await box.fill('こんにちは');
    // As Safari sends it: the composition already ended, the keydown still says 229.
    await box.evaluate((b) => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { value: 229 });
      b.dispatchEvent(e);
    });
    await p.waitForTimeout(300);
    ok((await box.inputValue()) === 'こんにちは', 'the box was sent');
    await box.fill('');
    p.clean();
  });

  await check('WEB-69', 'the editor: a file opens at its first line, and the keyboard stays with it', async () => {
    const m = await launch({ prompt: 'Add a long file', mode: 'auto' });
    const s = await settled(m.id);
    fs.writeFileSync(path.join(s.worktree.path, 'long.js'), 'export const a = 1;\n'.repeat(400));
    const q = await page(); // its own window: the side panel stays open
    await q.goto(w.url);
    await q.locator(`.item[data-id="${m.id}"]`).click();
    await q.getByRole('button', { name: /^Changes/ }).filter({ visible: true }).first().click();
    const pen = q.locator('[data-a="cx-edit"][aria-label="Edit long.js"]');
    await pen.click();
    const code = q.locator('.pn-edit textarea');
    await code.waitFor();
    await until(() => q.evaluate(() => document.activeElement.matches('.pn-edit textarea')));
    const place = () => q.evaluate(() => [document.querySelector('.ed-scroll').scrollTop, document.querySelector('.pn-edit textarea').selectionStart]);
    ok(String(await place()) === '0,0', `it opened at ${await place()}`);
    await q.keyboard.type('x');
    await q.keyboard.press('Escape');
    await q.locator('.ask-pop').waitFor();
    await q.keyboard.press('Escape');
    await until(() => q.evaluate(() => document.activeElement.matches('.pn-edit textarea')));
    await q.keyboard.press('Control+p');
    await q.locator('.pal-input, #overlay input').first().waitFor();
    await q.keyboard.press('Escape');
    await until(() => q.evaluate(() => document.activeElement.matches('.pn-edit textarea')));
    await code.fill((await code.inputValue()).slice(1));
    await q.keyboard.press('Escape');
    await until(() => q.evaluate(() => document.activeElement.matches('[data-a="cx-edit"][aria-label="Edit long.js"]')));
    q.clean();
    await q.context().close();
  });

  await check('WEB-70', 'a crew job’s toast: Open opens that task, not the member’s thread', async () => {
    const m = await api(w.url, '/api/crew', { name: 'Toasty', role: 'QA', cwd: w.repo, agent: 'claude' });
    ok(m.status === 201, `crew ${m.status} ${m.text.slice(0, 200)}`);
    const j = await api(w.url, `/api/crew/${m.json.id}/jobs`, { prompt: 'Report on the toast' });
    ok(j.status === 201 && j.json.session, `job ${j.status} ${j.text.slice(0, 200)}`);
    const id = j.json.session.id;
    await settled(id);
    for (const [name, viewport] of [['side', { width: 1440, height: 900 }], ['stacked', { width: 390, height: 844 }]]) {
      const q = await page({ viewport });
      await q.goto(w.url);
      await q.waitForFunction((id) => window.S?.sessions?.has(id) || document.querySelector(`[data-id="${id}"]`), id).catch(() => {});
      await q.evaluate(async (id) => {
        const [{ S }, { notifyFinished }] = await Promise.all([import('/js/core/state.js'), import('/js/features/notify.js')]);
        await new Promise((done) => (function wait() { S.sessions.has(id) ? done() : setTimeout(wait, 50); })());
        notifyFinished(S.sessions.get(id));
      }, id);
      const toast = q.locator('.toast', { hasText: 'Toasty' });
      await toast.waitFor({ timeout: 3000 });
      await toast.locator('.t-act').click();
      await until(() => q.evaluate((id) => import('/js/core/state.js').then(({ S }) => S.open.has(id) && !S.crewOpen), id), { timeout: 3000, what: `${name}: the job open as a task` });
      if (name === 'stacked') ok(await q.evaluate(() => document.body.classList.contains('stack-page')), 'stacked: the job is not a page over the list');
      else ok(await q.evaluate((id) => document.querySelector('#splitHead')?.dataset.id === id, id), 'side by side: the main pane is not the job');
      await q.waitForTimeout(400); // past the pane's fade
      await q.shot(`crew-toast-open-${name}`);
      // The member is its crumb (side by side, in the pane's head).
      if (name === 'side') ok(await q.evaluate(() => /Toasty/.test(document.querySelector('#splitHead')?.textContent || '')), 'side by side: no member crumb');
      if (name === 'side') {
        // From the Org page too: the job takes the pane.
        await q.evaluate(async (id) => {
          const [{ S }, { notifyFinished }, { openOrg }] = await Promise.all([import('/js/core/state.js'), import('/js/features/notify.js'), import('/js/features/org.js')]);
          openOrg();
          notifyFinished(S.sessions.get(id));
        }, id);
        await toast.first().locator('.t-act').click();
        await until(() => q.evaluate((id) => import('/js/core/state.js').then(({ S }) => S.open.has(id) && !S.crewOpen && !S.orgOpen), id), { timeout: 3000, what: 'Org page: the job open as a task' });
      }
      q.clean();
      await q.context().close();
    }
  });

  await check('WEB-49', 'Home Screen app: full screen and its own cache only when standalone', async () => {
    // A browser tab: no class, the viewport as it was, no manifest (this isn't a Grid).
    const tab = await p.evaluate(() => [document.documentElement.classList.contains('standalone'), document.querySelector('meta[name="viewport"]').content, !!document.querySelector('link[rel="manifest"]')]);
    ok(!tab[0] && !tab[1].includes('viewport-fit') && !tab[2], `browser tab: ${JSON.stringify(tab)}`);
    // Opened from an iPhone's Home Screen (navigator.standalone, before the page's first script).
    const q = await page({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await q.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
    await q.goto(w.url + '/');
    await q.waitForSelector('#splitHome, .item', { timeout: 15000 });
    const home = await q.evaluate(() => [document.documentElement.classList.contains('standalone'), document.querySelector('meta[name="viewport"]').content]);
    ok(home[0] && home[1].endsWith('viewport-fit=cover'), `standalone: ${JSON.stringify(home)}`);
    // Its service worker takes over, so the next open paints from cache (web/sw.js).
    await until(() => q.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0), { timeout: 10000, what: 'service worker' });
    ok(!(await q.evaluate(() => !!document.querySelector('link[rel="manifest"]'))), 'no manifest off a Grid');
    q.clean();
    await q.context().close();
  });

  await check('WEB-52', 'a pane opened as a page: its name sits on the row, or over what it still asks for', async () => {
    const it = (await api(w.url, '/api/stuff/starters/agent-board', {})).json;
    await api(w.url, '/api/config', { defaults: { panes: `${it.id}@home` } }, 'PATCH');
    const q = await page({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const middle = () => q.evaluate(() => {
      const mid = (n) => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; };
      const bar = document.querySelector('.pa-open .pa-bar');
      return { name: mid(bar.querySelector('.pa-name')), back: mid(bar.querySelector('.sh-back')), need: !bar.querySelector('.pa-need').hidden };
    });
    await q.goto(w.url);
    await q.locator('text=New task').first().click();
    await q.locator(`.sh-pane-row[data-pane="${it.id}"]`).click();
    await q.waitForSelector('.pa-open.pa-needs .pa-need:not([hidden])');
    const asking = await middle();
    ok(asking.name < asking.back, `with a line under it the name is at ${asking.name}, Back at ${asking.back}`);
    await api(w.url, `/api/stuff/${it.id}/allow`, { uses: it.uses });
    await q.reload();
    await q.locator('text=New task').first().click();
    await q.locator(`.sh-pane-row[data-pane="${it.id}"]`).click();
    await q.waitForSelector('.pa-open:not(.pa-needs) .pa-frame');
    const allowed = await middle();
    ok(!allowed.need && Math.abs(allowed.name - allowed.back) <= 1, `alone on its row the name is at ${allowed.name}, Back at ${allowed.back}`);
    q.clean();
    await q.context().close();
    await api(w.url, '/api/config', { defaults: { panes: '' } }, 'PATCH');
  });

  await check('WEB-63', 'a launch leaves the list where it is: the toast says it went, Open shows the row', async () => {
    const list = await Promise.all(Array.from({ length: 25 }, (_, i) => launch({ prompt: `Long list ${i}` })));
    for (const s of list) await settled(s.id);
    const q = await page({ viewport: { width: 1440, height: 700 } });
    await q.goto(w.url);
    await q.locator('#feed .item').first().waitFor();
    await q.fill('#prompt', 'Launched with a long list');
    const landed = q.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions');
    await q.keyboard.press('Enter');
    const toast = q.locator('.toast', { hasText: 'Sent to' });
    await toast.waitFor({ timeout: 3000 });
    const top = () => q.evaluate(() => document.querySelector('#feedWrap').scrollTop);
    ok((await top()) === 0, `the list moved to ${await top()}`);
    await landed;
    await q.waitForTimeout(50); // the toast's Open knows the task now
    // In one go: this fake run ends in a moment, and its row then moves with the list held.
    const shown = await q.evaluate(() => {
      document.querySelector('.toast .t-act').click();
      const b = document.querySelector('#feedWrap').getBoundingClientRect();
      const r = document.querySelector('#feed .item.open .it-head').getBoundingClientRect();
      return r.top >= b.top + document.querySelector('#splitTop').offsetHeight && r.bottom <= b.bottom;
    });
    ok(shown, 'Open left the row out of view');
    q.clean();
    await q.context().close();
  });

  await check('WEB-67', 'a share from the Home Screen app opens New task, in the box and attached', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const shared = (name = 'screenshot.png') => ({ name, mimeType: 'image/png', buffer: png });
    // What the share sheet does: a multipart POST to the manifest's action.
    const share = async (q, fields, files = []) => {
      await q.evaluate((f) => {
        const form = Object.assign(document.createElement('form'), { id: 'qaShare', method: 'post', action: '/share', enctype: 'multipart/form-data' });
        for (const [name, value] of Object.entries(f)) form.append(Object.assign(document.createElement('input'), { type: 'hidden', name, value }));
        form.append(Object.assign(document.createElement('input'), { type: 'file', name: 'files', multiple: true }));
        document.body.append(form);
      }, fields);
      await q.setInputFiles('#qaShare input[type=file]', files);
      await q.evaluate(() => document.querySelector('#qaShare').submit());
      await q.waitForFunction(() => !document.querySelector('#qaShare') && !location.search && !document.querySelector('#launcher.skel'));
    };
    const painted = (q) => q.waitForSelector('#launcher:not(.skel)', { state: 'attached' }); // behind the list, stacked
    const boxOf = (q) => q.evaluate(() => document.querySelector('#prompt').value);
    const chips = (q) => q.locator('#launcher .tray .att.held');
    const note = (q) => q.locator('#launcher .l-shared:not([hidden])');
    const worker = async (q) => {
      await q.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
      });
      await q.waitForFunction(() => navigator.serviceWorker.controller);
      await q.reload();
      await painted(q);
    };
    const before = (await api(w.url, '/api/sessions')).json.length;
    for (const [label, viewport, colorScheme] of [
      ['1440-light', { width: 1440, height: 900 }, 'light'],
      ['1440-dark', { width: 1440, height: 900 }, 'dark'],
      ['390-light', { width: 390, height: 844 }, 'light'],
      ['390-dark', { width: 390, height: 844 }, 'dark'],
    ]) {
      const q = await page({ viewport, colorScheme });
      await q.goto(w.url);
      await q.evaluate(async () => {
        localStorage.setItem('wisp.drafts', JSON.stringify({ home: 'My own notes' }));
        localStorage.setItem('wisp.theme', JSON.stringify(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
      });
      await q.waitForFunction(() => navigator.serviceWorker.controller);
      await q.reload();
      await painted(q);
      await share(q, { title: 'Flaky login test', text: 'CI failed again on the retry', url: 'https://example.com/runs/4821' }, [shared(), { name: 'run.log', mimeType: 'text/plain', buffer: Buffer.from('FAIL auth > login') }]);
      await chips(q).nth(1).waitFor();
      ok((await boxOf(q)) === 'My own notes\n\nFlaky login test\n\nCI failed again on the retry\n\nhttps://example.com/runs/4821', `the box says ${JSON.stringify(await boxOf(q))}`);
      if (viewport.width < 900) {
        ok(await q.evaluate(() => document.body.classList.contains('stack-page')), 'stacked: New task opens as a page');
        ok(await q.evaluate(() => document.activeElement?.id !== 'prompt'), 'no keyboard over Send');
      }
      await noOverflow(q);
      await q.shot(`share-${label}`);
      q.clean();
      await q.context().close();
    }
    const q = await page({ viewport: { width: 390, height: 844 } });
    await q.goto(w.url);
    const uploads = [];
    q.on('request', (r) => {
      if (r.url().includes('/api/uploads')) uploads.push(r.url());
    });
    await worker(q);
    await share(q, { text: 'Only words' });
    ok((await boxOf(q)) === 'Only words', 'a text-only share');
    await note(q).waitFor();
    await q.reload();
    await painted(q);
    ok((await boxOf(q)) === 'Only words', 'a reload adds nothing');
    await note(q).waitFor({ state: 'attached' }); // behind the list, stacked
    await q.evaluate(() => localStorage.removeItem('wisp.drafts'));
    await q.reload();
    await painted(q);
    await share(q, {}, [shared()]);
    await chips(q).first().waitFor();
    ok((await boxOf(q)) === 'Take a look at the attached file.', 'files alone can still be sent');
    // The harness list landing or a settings change repaints the launcher: the chips stay.
    await q.evaluate(() => import('/js/features/launcher.js').then((m) => m.renderLauncher()));
    ok((await chips(q).count()) === 1, 'a repaint dropped the shared file');
    await q.evaluate(() => localStorage.removeItem('wisp.drafts'));
    await q.reload();
    await painted(q);
    await share(q, {}, Array.from({ length: 11 }, (_, i) => shared(`shot-${i}.png`)));
    await chips(q).nth(9).waitFor();
    ok((await chips(q).count()) === 10, 'ten files at most');
    await q.waitForFunction(() => /Left out 1 file/.test(document.querySelector('#toasts').textContent));
    ok((await api(w.url, '/api/sessions')).json.length === before, 'nothing started by itself');
    ok(uploads.length === 0, `nothing uploaded before Send: ${uploads.length}`);
    await q.evaluate(() => localStorage.removeItem('wisp.drafts'));
    await q.reload();
    await painted(q);
    await share(q, { text: 'Only the picture goes' }, [shared(), { name: 'tool.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') }]);
    await chips(q).first().waitFor();
    ok((await chips(q).count()) === 1, 'a type the manifest refuses is left out');
    await q.waitForFunction(() => /Left out 1 file/.test(document.querySelector('#toasts').textContent));
    // A reload while the task's start is on its way: the server has it, so what was sent stays gone.
    await q.route('**/api/sessions', async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      const answer = await r.fetch();
      await new Promise((go) => setTimeout(go, 1500));
      await r.fulfill({ response: answer }).catch(() => {});
    });
    await q.click('#launch');
    await q.waitForFunction(() => !document.querySelector('#launcher .tray .att'));
    ok(uploads.length === 1, `Send uploads the file, once: ${uploads.length}`);
    await q.waitForFunction(() => document.querySelector('#launcher .l-shared')?.hidden !== false);
    await q.waitForFunction(() => document.querySelector('#prompt').value === '');
    await q.reload();
    await painted(q);
    await q.unroute('**/api/sessions');
    ok((await boxOf(q)) === '', `what was sent stayed gone: ${JSON.stringify(await boxOf(q))}`);
    ok(!/home/.test((await q.evaluate(() => localStorage.getItem('wisp.drafts'))) || ''), 'no draft of what was sent');
    await share(q, { text: 'The next share' });
    ok((await boxOf(q)) === 'The next share', `the next share lands alone: ${JSON.stringify(await boxOf(q))}`);
    await q.evaluate(() => localStorage.removeItem('wisp.drafts'));
    q.clean();
    // Signed out: the share stays unread, ?shared= with it, and lands once the server takes us.
    await q.reload();
    await painted(q);
    await q.route('**/api/health', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Sign in again."}' }));
    await q.evaluate(() => {
      const form = Object.assign(document.createElement('form'), { method: 'post', action: '/share', enctype: 'multipart/form-data' });
      form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: 'text', value: 'Kept through sign-in' }));
      document.body.append(form);
      form.submit();
    });
    await q.waitForURL(/shared=/);
    await q.waitForFunction(() => /Sign in to wisp again/.test(document.querySelector('#toasts')?.textContent || ''));
    ok(/shared=/.test(q.url()), 'signed out, the address keeps the share');
    await q.unroute('**/api/health');
    await q.reload();
    await painted(q);
    await q.waitForFunction(() => document.querySelector('#prompt').value === 'Kept through sign-in' && !location.search);
    // From another site, without a click: it lands the same way, marked, and nothing's sent.
    await q.evaluate(() => localStorage.removeItem('wisp.drafts'));
    await q.reload();
    await worker(q); // sign-in dropped it
    const elsewhere = new URL(w.url).hostname === 'localhost' ? `http://127.0.0.1:${PORT}` : `http://localhost:${PORT}`;
    await q.route(`${elsewhere}/qa-elsewhere`, (r) => r.fulfill({ contentType: 'text/html', body: `<form id=f method=post action="${new URL(w.url).origin}/share" enctype=multipart/form-data><input type=hidden name=text value="From a site"></form><script>f.submit()</script>` }));
    await q.goto(`${elsewhere}/qa-elsewhere`);
    await q.waitForFunction(() => document.querySelector('#prompt')?.value === 'From a site' && !location.search);
    await note(q).waitFor();
    ok((await api(w.url, '/api/sessions')).json.length === before + 1, 'a form from another site started nothing');
    await q.context().close();
    // No worker: the server's answer, and the toast that says what to do.
    const bare = await page({ viewport: { width: 390, height: 844 } });
    await bare.goto(w.url);
    await painted(bare);
    await share(bare, { text: 'x' });
    await bare.waitForFunction(() => /needs the Home Screen app/.test(document.querySelector('#toasts').textContent));
    await bare.context().close();
  });

  await check('WEB-31', 'docs site builds and renders', async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/site.mjs')], { cwd: ROOT, stdio: 'ignore' });
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      const q = await page({ viewport: vp });
      await q.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
      await q.goto('file://' + path.join(ROOT, 'docs/index.html'));
      await q.waitForTimeout(1500);
      q.errors = q.errors.filter((e) => !/net::ERR_FAILED|posthog|Failed to load resource|CORS|file:|Origin null/.test(e));
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
