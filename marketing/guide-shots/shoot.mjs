// Shoots the site's screenshots (docs/assets/shots/<light|dark>-<name>.webp) from the real app:
// stage.mjs's wisp, the system Chrome at deviceScaleFactor 2, once per theme. The guides, the agent
// pages and the landing page show them through `shot()` in scripts/site.mjs.
//
//   PW_DIR=/tmp/gridcheck node marketing/guide-shots/shoot.mjs           → docs/assets/shots/*.webp
//   ONLY=report,limit PW_DIR=/tmp/gridcheck node marketing/guide-shots/shoot.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, api, playwright } from '../../qa/lib.mjs';
import { start } from './stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '../../docs/assets/shots');
const ONLY = process.env.ONLY?.split(',');

const w = await start();
const until = async (what, fn) => {
  for (let i = 0; i < 120; i++) if (await fn()) return;
  else await new Promise((r) => setTimeout(r, 500));
  throw new Error(`timed out: ${what}`);
};
const sessions = async () => (await api(w.url, '/api/sessions')).json;
// Every scripted task has landed: the goal task is on round 3, the rest finished, asked or kept working.
await until('the tasks', async () => {
  const list = await sessions();
  const goal = list.find((x) => x.id === w.ids.goal);
  return goal?.goal?.round === 3 && goal.state === 'running' && list.filter((x) => x.state === 'review').length >= 7;
});
// wisp's welcome task, and two tasks already read, so the list looks lived in.
for (const x of await sessions()) if (x.agent === 'wisp') await api(w.url, `/api/sessions/${x.id}`, { archived: true }, 'PATCH');
for (const id of [w.ids.invoices, w.ids.camera]) await api(w.url, `/api/sessions/${id}`, { unread: false }, 'PATCH');

const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME });
// No toasts, no hover rows, no blinking caret. The compare group's time sits outside its row
// (absolutely placed against the stage), so it's hidden until that's fixed.
const CSS = `.toasts, #toasts { display: none !important; } * { caret-color: transparent !important; }
  .task-head .it-side .q-time { display: none !important; }`;

async function page(scheme, width, height) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme });
  await p.goto(w.url);
  await p.addStyleTag({ content: CSS });
  await p.waitForSelector('.f-group');
  await p.waitForTimeout(1200);
  return p;
}
const open = async (p, id) => {
  await p.click(`.item[data-id="${id}"]`);
  await p.waitForTimeout(1500);
  await p.mouse.move(2, 2);
  await p.waitForTimeout(2000); // the test rings and counts animate in
};
const pad = (box, n = 16) => ({ x: Math.max(0, box.x - n), y: Math.max(0, box.y - n), width: box.width + 2 * n, height: box.height + 2 * n });

// [name, width, height, take(page) → screenshot options]
const TAKES = [
  ['app', 1280, 860, async (p) => {
    await open(p, w.ids.flaky);
    return {};
  }],
  ['picker', 1280, 860, async (p) => {
    await p.locator('#launcher textarea').first().fill('Add rate limiting to /login: 5 attempts per minute per IP, with a test');
    await p.click('#runner');
    await p.waitForTimeout(700);
    const a = await p.locator('#launcher').boundingBox();
    const m = await p.locator('.picker').last().boundingBox();
    const x = Math.min(a.x, m.x), y = Math.min(a.y, m.y);
    return { clip: pad({ x, y, width: Math.max(a.x + a.width, m.x + m.width) - x, height: Math.max(a.y + a.height, m.y + m.height) - y }, 20) };
  }],
  // The launcher's Run on with studio and gpu-box ticked beside this computer.
  ['machines', 1280, 860, async (p) => {
    await p.locator('#launcher textarea').first().fill('Run the e2e suite and fix what fails');
    await p.click('#whereBtn');
    await p.waitForSelector('.where-menu');
    for (const n of ['studio', 'gpu-box']) await p.locator('.where-menu .wm-row', { hasText: n }).locator('[data-also]').click();
    await p.mouse.move(2, 2);
    await p.waitForTimeout(600);
    const a = await p.locator('#launcher').boundingBox();
    const m = await p.locator('.where-menu').boundingBox();
    const x = Math.min(a.x, m.x), y = Math.min(a.y, m.y);
    return { clip: pad({ x, y, width: Math.max(a.x + a.width, m.x + m.width) - x, height: Math.max(a.y + a.height, m.y + m.height) - y }, 20) };
  }],
  ['report', 1100, 2200, async (p) => {
    await open(p, w.ids.flaky);
    return { clip: pad(await p.locator('.item.open .turns, .turns').first().boundingBox(), 12) };
  }],
  ['goal', 1000, 640, async (p) => {
    await open(p, w.ids.goal);
    return {};
  }],
  ['limit', 1100, 900, async (p) => {
    await open(p, w.ids.limit);
    const head = await p.getByText('Work is at its usage limit').first().boundingBox();
    const card = await p.getByRole('button', { name: /Continue on Personal/ }).first().locator('xpath=..').boundingBox();
    return { clip: pad({ x: head.x, y: head.y, width: Math.max(card.x + card.width, head.x + head.width) - head.x, height: card.y + card.height - head.y }, 20) };
  }],
  ['spell', 1100, 1000, async (p) => {
    await open(p, w.ids.spell);
    return { clip: pad(await p.locator('.item.open .presentation', { hasText: 'Task board' }).first().boundingBox(), 2) };
  }],
  // My Stuff (stage.mjs seeds it): the published pricing app first, then what else agents kept.
  ['stuff', 1280, 560, async (p) => {
    await p.click('#splitStuff');
    await p.waitForSelector('.stuff-view, .stuff-page, [class*="stuff"] .st-card', { timeout: 10000 }).catch(() => {});
    await p.mouse.move(2, 2);
    await p.waitForTimeout(1500);
    return {};
  }],
  // Org: a tech lead handing work to Scout, Quill and three Codex copies; Quill to Echo.
  ['org', 1280, 640, async (p) => {
    let ada = (await api(w.url, '/api/crew')).json.find((m) => m.name === 'Ada');
    ada ||= (await api(w.url, '/api/crew', { name: 'Ada', role: 'Tech lead', avatar: 'flame.amber.happy.smile.crown', color: 'amber', brief: 'Plan the week’s work and hand it out.', cwd: w.repos['api-server'], agent: 'claude' })).json;
    const { Scout, Quill, Echo } = w.crew;
    await api(w.url, `/api/crew/${ada.id}`, { team: [{ crew: Scout.id, name: 'Scout' }, { crew: Quill.id, name: 'Quill' }, { agent: 'codex', name: 'codex', count: 3, use: 'tests' }] }, 'PATCH');
    await api(w.url, `/api/crew/${Quill.id}`, { team: [{ crew: Echo.id, name: 'Echo' }] }, 'PATCH');
    await p.reload();
    await p.addStyleTag({ content: CSS });
    await p.waitForSelector('#secCrew .cr-org');
    await p.click('#secCrew .cr-org');
    await p.waitForSelector('.org-view .org-chart');
    await p.mouse.move(2, 2);
    await p.waitForTimeout(1500);
    return {};
  }],
  ['compare', 1240, 900, async (p) => {
    await p.click('.task-item [data-a="compare"]');
    await p.waitForSelector('.compare-modal');
    await p.mouse.move(2, 2);
    await p.waitForTimeout(2500); // the test rings and counts animate in
    return { clip: pad(await p.locator('.compare-modal').boundingBox(), 0) };
  }],
];

// PNG → WebP in Chrome (no encoder on the machine needed).
const enc = await browser.newPage();
const webp = (png) => enc.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/webp', 0.86).split(',')[1];
}, png.toString('base64'));

try {
  for (const scheme of ['light', 'dark']) {
    for (const [name, width, height, take] of TAKES) {
      if (ONLY && !ONLY.includes(name)) continue;
      const p = await page(scheme, width, height);
      const opts = await take(p);
      const png = await p.screenshot(opts);
      const prefix = name === 'compare' ? 'story-' : '';
      const file = path.join(SHOTS, `${prefix}${scheme}-${name}.webp`);
      fs.writeFileSync(file, Buffer.from(await webp(png), 'base64'));
      fs.writeFileSync(path.join('/tmp', `gshot-${scheme}-${name}.png`), png);
      console.log(file);
      await p.close();
    }
  }
} finally {
  await browser.close();
  w.stop();
}
process.exit(0);
