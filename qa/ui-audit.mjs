// The scorecard's numbers, taken on every view (qa/views.mjs) in every size and theme: 1440, 1000
// and 390px in a browser, 390px on a touch screen and in the phone app (wispMobile), light and dark.
// In each one it fails on:
//
//   axe        an axe-core wcag2a / wcag2aa violation (contrast, names, nested controls …)
//   sizes      more than five font sizes in the text on screen (design/ui.md → Type)
//   overflow   the page scrolls sideways
//   cut        a short label (24 characters or fewer) cut with "…": a name, not a preview
//   tap        in the app, a control under 44px either way (text fields inside a bigger box aside)
//
// `node qa/ui-audit.mjs` → qa/out/ui-audit.json and a screenshot per view (qa/out/ui-audit/).
// axe-core comes from outside the repo like Playwright: npm i --prefix /tmp/wisp-qa-pw axe-core.
// WIDTHS=1440,390 THEMES=dark VIEWS=home,task narrow it down.

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, OUT } from './lib.mjs';
import { NOT_IN_APP, seededWisp, views as viewsOf } from './views.mjs';

const PORT = Number(process.env.QA_AUDIT_PORT) || 4498;
const PROFILES = (process.env.WIDTHS || '1440,1000,390,touch,app').split(',');
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const ONLY = process.env.VIEWS?.split(',');
const SHOTS = path.join(OUT, 'ui-audit');
fs.mkdirSync(SHOTS, { recursive: true });
const AXE = path.join(process.env.PW_DIR || '/tmp/wisp-qa-pw', 'node_modules/axe-core/axe.min.js');
if (!fs.existsSync(AXE)) throw new Error(`axe-core not found: npm i --prefix ${path.dirname(path.dirname(path.dirname(AXE)))} axe-core`);
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36';

// ---- the measurement, in the page ----
async function measure(app) {
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${[...e.classList].slice(0, 2).map((c) => `.${c}`).join('')}`;
  // A dialog open is the screen: the page dimmed behind it isn't what's being read
  const root = document.querySelector('#overlay:not([hidden])') || document.body;
  const sizes = new Set();
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const t = walk.currentNode;
    // One or two characters (an account's initial, a file's M, a count in a dot) are a mark, not text
    if (t.textContent.trim().length > 2 && shown(t.parentElement)) sizes.add(getComputedStyle(t.parentElement).fontSize);
  }
  const cut = [];
  for (const e of root.querySelectorAll('*')) {
    if (!shown(e) || getComputedStyle(e).textOverflow !== 'ellipsis' || e.scrollWidth <= e.clientWidth + 1) continue;
    const text = e.textContent.trim().replace(/\s+/g, ' ');
    // The branch is cut in the middle on purpose (its head, then its tail beside it: "wisp/add-a-rat…-9c5e26")
    if (text && text.length <= 24 && !e.matches('.b-h')) cut.push(`${name(e)} "${text}"`);
  }
  const tap = [];
  if (app)
    for (const e of document.querySelectorAll('button, [role=button], a[href], select, input:not([type=hidden])')) {
      if (!shown(e) || e.closest('[aria-hidden="true"], .md, .ask-text')) continue;
      // WCAG 2.5.8's own exceptions: a link inside a sentence, and a box or radio whose label takes the tap
      if (e.matches('p a, small a') || (e.matches('input[type=checkbox], input[type=radio]') && e.closest('label')?.getBoundingClientRect().height >= 43.5)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) tap.push(`${name(e)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  const axe = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
  return {
    sizes: [...sizes].sort(),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cut,
    tap,
    axe: axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
  };
}

const seeded = await seededWisp(PORT);
const { w } = seeded;
const VIEWS = Object.entries(viewsOf(seeded)).filter(([v]) => !ONLY || ONLY.includes(v));
const browser = await launchBrowser();
const results = [];
const notOpened = [];
for (const theme of THEMES)
  for (const profile of PROFILES) {
    const app = profile === 'app';
    const touch = profile === 'touch' || app;
    const width = touch ? 390 : Number(profile);
    for (const [view, go] of VIEWS) {
      if (app && NOT_IN_APP.has(view)) continue;
      const at = `${view}@${profile}-${theme}`;
      // A fresh context each time: a task left open (kept in localStorage) would cover the next view
      const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: theme, ...(touch && { hasTouch: true, isMobile: true, userAgent: UA + (app ? ' wispMobile' : '') }) });
      await ctx.addInitScript({ path: AXE });
      const p = await ctx.newPage();
      try {
        await p.goto(w.url);
        await p.waitForTimeout(900);
        await go(p);
        await p.waitForTimeout(400);
      } catch (err) {
        notOpened.push(`${at}: ${String(err.message).split('\n')[0]}`);
        await ctx.close();
        continue;
      }
      const m = await p.evaluate(measure, app);
      const issues = [
        ...m.axe.map((x) => `axe ${x}`),
        ...(m.sizes.length > 5 ? [`sizes ${m.sizes.length}: ${m.sizes.join(' ')}`] : []),
        ...(m.overflow > 0 ? [`overflow ${m.overflow}px`] : []),
        ...m.cut.map((x) => `cut ${x}`),
        ...m.tap.map((x) => `tap ${x}`),
      ];
      results.push({ view: at, ...m, issues });
      if (issues.length) await p.screenshot({ path: path.join(SHOTS, `${at}.png`) });
      await ctx.close();
    }
  }
await browser.close();
w.stop();

// Text fields sit inside a box that takes the tap (the reply box, the prompt): not a control of their own.
const FIELD = /^tap (textarea|input)[#.]/;
const open_ = results.flatMap((r) => r.issues.filter((i) => !FIELD.test(i)).map((i) => `${r.view}  ${i}`));
fs.writeFileSync(path.join(OUT, 'ui-audit.json'), JSON.stringify({ views: results.length, notOpened, issues: open_, results }, null, 1));
const most = Math.max(...results.map((r) => r.sizes.length));
console.log(`\n  ui-audit: ${results.length} views · at most ${most} font sizes · ${results.reduce((n, r) => n + r.axe.length, 0)} axe violations`);
for (const f of notOpened) console.log(`  ! view didn't open: ${f}`);
for (const i of open_) console.log(`  ✗ ${i}`);
console.log(`  ${open_.length ? `${open_.length} issues` : 'no issues'} · ${path.relative(process.cwd(), SHOTS)}/`);
process.exit(open_.length || notOpened.length ? 1 : 0);
