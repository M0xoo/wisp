// Shoots the README demo in one scripted take: stage.mjs's wisp, driven by Playwright in the system
// Chrome, captured through the CDP screencast, then encoded by ffmpeg to an MP4 and the README GIF.
// Captions, the cursor and the end card are overlays in the page.
//
//   PW_DIR=/tmp/gridcheck node marketing/readme-demo/record.mjs   → out/demo.mp4, out/demo.gif

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, api, playwright } from '../../qa/lib.mjs';
import { start } from './stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const FRAMES = path.join(OUT, 'frames');
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const w = await start();
const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1024, height: 720 }, deviceScaleFactor: 2, colorScheme: process.env.THEME || 'dark' });
const p = await ctx.newPage();
await p.goto(w.url);
await p.waitForSelector('.cr-member .cr-row');
// A task already at work, and Claude Code picked in the launcher (Auto would run a scout first).
await api(w.url, '/api/sessions', { prompt: 'Migrate billing to the v2 API, keep the webhooks on v1 for now', cwd: w.cwd, agent: 'claude' });
await p.click('.runner-btn');
await p.locator('.picker').getByText('Claude Code').first().click();
await p.keyboard.press('Escape');
await p.evaluate(() => document.activeElement?.blur());
await p.waitForTimeout(1500);

// --- overlays ---------------------------------------------------------------------------------
const logo = fs.readFileSync(path.join(HERE, '../../docs/assets/icon.svg'), 'utf8');
await p.addStyleTag({
  content: `
  .sh-tips, .sh-keys, .toasts, #toasts { display: none !important; }
  #vcap { position: fixed; left: calc(50% + 170px); bottom: 92px; transform: translate(-50%, 12px); z-index: 99999; opacity: 0;
    padding: 12px 22px; border-radius: 14px; background: rgba(17,17,20,.94); color: #fff;
    font: 600 20px/1.2 var(--sans); letter-spacing: -.01em; white-space: nowrap; box-shadow: 0 10px 40px rgba(0,0,0,.45);
    transition: opacity .28s ease, transform .28s ease; pointer-events: none; }
  #vcap.on { opacity: 1; transform: translate(-50%, 0); }
  #vcur { position: fixed; z-index: 99998; width: 22px; height: 22px; margin: -3px 0 0 -3px; pointer-events: none;
    transition: transform .12s ease; filter: drop-shadow(0 2px 4px rgba(0,0,0,.5)); }
  #vcur.down { transform: scale(.82); }
  #vend { position: fixed; inset: 0; z-index: 100000; display: grid; place-content: center; justify-items: center; gap: 18px;
    background: radial-gradient(60% 60% at 50% 45%, #1d1a33 0%, #0e0e10 70%); opacity: 0; transition: opacity .45s ease;
    color: #f4f4f6; font-family: var(--sans); pointer-events: none; }
  #vend.on { opacity: 1; }
  #vend svg { width: 116px; height: 116px; border-radius: 26px; }
  #vend h1 { margin: 6px 0 0; font-size: 46px; letter-spacing: -.02em; font-weight: 700; }
  #vend p { margin: 0; font-size: 22px; color: #a9a9b3; }
  #vend code { margin-top: 10px; font: 500 19px var(--mono); color: #cfcfe6; padding: 9px 16px; border-radius: 10px; background: rgba(255,255,255,.07); }
`,
});
await p.evaluate((logo) => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="vcap"></div>
     <svg id="vcur" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>
     <div id="vend">${logo}<h1>wisp</h1><p>All your coding agents. One place, any machine.</p><code>npm i -g wisp-agents</code><p>trywisp.dev</p></div>`,
  );
  const cur = document.getElementById('vcur');
  cur.style.left = '1000px';
  cur.style.top = '600px';
  addEventListener('mousemove', (e) => ((cur.style.left = e.clientX + 'px'), (cur.style.top = e.clientY + 'px')), true);
  addEventListener('mousedown', () => cur.classList.add('down'), true);
  addEventListener('mouseup', () => cur.classList.remove('down'), true);
}, logo);

const caption = (text) =>
  p.evaluate(async (text) => {
    const c = document.getElementById('vcap');
    if (c.classList.contains('on')) {
      c.classList.remove('on');
      await new Promise((r) => setTimeout(r, 260));
    }
    c.textContent = text;
    if (text) c.classList.add('on');
  }, text);
let mouse = { x: 1000, y: 600 };
const moveTo = async (sel, { dx = 0, dy = 0 } = {}) => {
  const box = await p.locator(sel).first().boundingBox();
  const to = { x: box.x + Math.min(box.width / 2, 120) + dx, y: box.y + box.height / 2 + dy };
  await p.mouse.move(to.x, to.y, { steps: 18 });
  mouse = to;
};
const click = async (sel, opts) => {
  await moveTo(sel, opts);
  await p.waitForTimeout(120);
  await p.mouse.down();
  await p.waitForTimeout(90);
  await p.mouse.up();
};
const wait = (ms) => p.waitForTimeout(ms);
const id = (name) => w.crew[name].id;
const checkin = (name) => api(w.url, `/api/crew/${id(name)}/checkin`, {});

// --- capture ------------------------------------------------------------------------------------
const cdp = await ctx.newCDPSession(p);
const stamps = [];
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const f = path.join(FRAMES, `${String(stamps.length).padStart(5, '0')}.jpg`);
  stamps.push({ f, t: metadata.timestamp });
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 2560, maxHeight: 1440 });
const t0 = Date.now();
const mark = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);

// --- the take -----------------------------------------------------------------------------------
await wait(300);
await caption('Your coding agents and your crew, in one place');
await moveTo('.cr-member .cr-row >> nth=0', { dx: 20 });
await wait(1600);

await caption('Send a task off. It runs in its own worktree.');
await click('.sh-launch textarea', { dx: -60 });
await p.keyboard.type('Add rate limiting to /login: 5 attempts per minute per IP', { delay: 22 });
await wait(300);
await p.keyboard.press('Enter');
mark('sent');
await wait(1200);

await caption('Agents ask when they need you');
await p.waitForFunction(() => /Asks:/.test(document.body.innerText), null, { timeout: 15000 });
await click('article.item:has-text("rate limiting")');
await p.waitForSelector('button.opt:visible:has-text("Yes, behind nginx")', { timeout: 10000 }).catch(async (e) => (await p.screenshot({ path: path.join(OUT, 'fail.png') }), Promise.reject(e)));
await wait(1400);
await click('button.opt:visible:has-text("Yes, behind nginx")');
mark('answered');

await caption('Read a one-screen report, not the transcript');
await p.waitForFunction(() => /Login is rate-limited/.test(document.body.innerText), null, { timeout: 20000 });
mark('report');
await wait(2200);
await p.mouse.move(600, 400, { steps: 10 });
for (let i = 0; i < 3; i++) await (p.mouse.wheel(0, 70), wait(110));
await wait(1600);

await caption('Your crew checks in on its own');
await Promise.all([checkin('Scout'), checkin('Tinker'), checkin('Echo')]);
await moveTo('.cr-member .cr-row >> nth=0', { dx: 20 });
await wait(1200);
await click('.cr-member .cr-row >> nth=0');
await p.waitForFunction(() => /Run #418 failed/.test(document.body.innerText), null, { timeout: 15000 });
mark('Scout reported');
await wait(2200);

await caption('@ a crew member like a teammate');
await p.evaluate(() => document.activeElement?.blur());
await click('.split-new');
await wait(400);
await click('.sh-launch textarea', { dx: -60 });
await p.keyboard.type('@Qu', { delay: 60 });
await wait(350);
await p.keyboard.press('Enter');
await p.keyboard.type('review PR #142 before I merge', { delay: 26 });
await wait(200);
await p.keyboard.press('Enter');
mark('sent to Quill');
await wait(900);
await p.locator(`.cr-member[data-crew="${id('Quill')}"] .cr-row`).evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
await wait(450);
await click(`.cr-member[data-crew="${id('Quill')}"] .cr-row`);
await p.waitForFunction(() => /two things before merging/.test(document.body.innerText), null, { timeout: 15000 });
mark('Quill answered');
await wait(2000);
await caption('');
await p.evaluate(() => document.getElementById('vend').classList.add('on'));
await wait(2600);
mark('end');
await cdp.send('Page.stopScreencast');
await wait(200);
await browser.close();
w.stop();

// --- encode -------------------------------------------------------------------------------------
// Each frame lasts until the next one (the screencast only sends frames when something paints).
const list = stamps.map((s, i) => `file '${s.f}'\nduration ${Math.max(0.001, (stamps[i + 1]?.t ?? s.t + 0.04) - s.t).toFixed(4)}`).join('\n');
fs.writeFileSync(path.join(OUT, 'frames.txt'), `${list}\nfile '${stamps.at(-1).f}'\n`);
const SPEED = Number(process.env.SPEED || 1.25); // a touch faster than real time
const mp4 = path.join(OUT, 'demo.mp4');
const gif = path.join(OUT, 'demo.gif');
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
ff('-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'frames.txt'), '-vf', `setpts=PTS/${SPEED},fps=30,scale=2048:1440:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', mp4);
// The README GIF: 880 wide like the one it replaces, 10 fps, one palette for the whole take.
ff('-i', mp4, '-vf', 'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif);
console.log(mp4, gif, stamps.length, 'frames', ((stamps.at(-1).t - stamps[0].t) || 0).toFixed(1) + 's');
process.exit(0);
