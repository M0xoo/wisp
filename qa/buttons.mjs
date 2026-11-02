// Every button, in every state: the page's views at desktop, side-by-side and phone widths, light
// and dark, and the phone app's page. Each visible button is measured as it rests, hovered and
// keyboard-focused, and in its lit states (Goal on, Worktree off, Transcript on, menus open …):
//
//   not-square   an icon-only button whose box shows (hover, lit, focus) isn't square
//   off-center   an icon-only button's icon isn't in its middle
//   h-pad/v-pad  a centred label sits closer to one side of its box than the other
//   row-heights  buttons side by side in one bar paint boxes of different heights
//   clipped      a label overflows its button without an ellipsis
//   overlap      two buttons on top of the page overlap
//
// `node qa/buttons.mjs` → qa/out/buttons.json (every measurement) and a contact sheet per view
// (qa/out/buttons/<view>@<width>-<theme>.png: each button at rest, hovered and focused).
// QUICK=1 skips hover and focus; WIDTHS=1440,390 and THEMES=dark narrow it down.

import fs from 'node:fs';
import path from 'node:path';
import { CHROME, OUT, playwright } from './lib.mjs';
import { click, NOT_IN_APP, seededWisp, views as viewsOf } from './views.mjs';

const PORT = Number(process.env.QA_BUTTONS_PORT) || 4497;
const WIDTHS = (process.env.WIDTHS || '1440,1000,390').split(',').map(Number);
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const QUICK = process.env.QUICK === '1';
const SHEETS = path.join(OUT, 'buttons');
fs.mkdirSync(SHEETS, { recursive: true });
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36 wispMobile';

// Known and meant: the crew header's + and Org sit inside its toggle row; on a phone the prompt
// bar scrolls under a pinned Send; menus, popovers and toasts lie over the page.
const ALLOWED = [
  /#secCrew > h4\.sec-toggle ⟷ #secCrew > button\.cr-(add|org)/,
  /button#launch\.send.*overlap|overlap.*button#launch\.send/,
  /⟷ .*(\.menu|#toasts|\.picker|\.pop|\.team-pop)/, // Delegate's and Judges' popovers too
  /^row-heights button\.cr-add=\d+ button\.cr-org=\d+ h4\.sec-toggle/, // the header row they sit in
  // the harness pill's + and vs: segments as tall as the pill's inside, as narrow as they can be
  /\.runners > button(#\w+)?\.vs-btn.* \| not-square/,
  /^#(topbar|projects) .* ⟷ #sec\w+ > h4/, // the list scrolled under the phone's sticky top bar
];

// ---- the measurement, in the page ----
function measure(state, only) {
  const SEL = 'button, [role=button], a.ghost, a.btn';
  const out = [];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && +cs.opacity > 0.05;
  };
  const onTop = (el) => {
    const r = el.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!t && (el.contains(t) || t.contains(el));
  };
  const name = (el) => {
    let s = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
    const cls = [...el.classList].filter((c) => !/^(on|open|pressed|busy|changed)$/.test(c)).slice(0, 3);
    if (cls.length) s += `.${cls.join('.')}`;
    const up = [];
    for (let p = el.parentElement, i = 0; p && i < 3; i++, p = p.parentElement) {
      if (p.id) {
        up.unshift(`#${p.id}`);
        break;
      }
      if (p.classList.length) up.unshift(`.${p.classList[0]}`);
    }
    return `${up.join(' ')} > ${s}`;
  };
  // What the button draws: its text, icons and boxed children (not its absolutely placed badges).
  const content = (el) => {
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity, text = false;
    const add = (q) => ((l = Math.min(l, q.left)), (r = Math.max(r, q.right)), (t = Math.min(t, q.top)), (b = Math.max(b, q.bottom)));
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          if (!c.textContent.trim()) continue;
          const rg = document.createRange();
          rg.selectNodeContents(c);
          for (const q of rg.getClientRects()) if (q.width) (add(q), (text = true));
        } else if (c.nodeType === 1) {
          const cs = getComputedStyle(c);
          if (cs.display === 'none' || cs.visibility === 'hidden' || /absolute|fixed/.test(cs.position)) continue;
          const q = c.getBoundingClientRect();
          if (!q.width || !q.height) continue;
          const boxed = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || (cs.borderStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0);
          if (c.tagName === 'svg' || c.tagName === 'IMG' || boxed || (!c.children.length && !c.textContent.trim())) add(q);
          else walk(c);
        }
      }
    };
    walk(el);
    return l === Infinity ? null : { l, r, t, b, text };
  };
  const painted = (cs) =>
    (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
    (cs.borderStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0 && cs.borderTopColor !== 'rgba(0, 0, 0, 0)') ||
    (cs.boxShadow !== 'none' && !/0px 0px 0px 0px/.test(cs.boxShadow));
  const all = only ? [only] : [...document.querySelectorAll(SEL)].filter(vis);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const c = content(el);
    const bg = painted(cs);
    // a picker (icon and chevron) is as wide as it needs: only a lone icon should be square
    const iconOnly = !!c && !c.text && ![...el.querySelectorAll('.chev')].some((x) => x.getBoundingClientRect().width);
    const issues = [];
    if (c && bg && c.text) {
      const centred = /center/.test(cs.justifyContent) || (cs.display.includes('grid') && /center/.test(cs.justifyItems)) || (!cs.display.includes('flex') && cs.textAlign === 'center');
      const L = c.l - r.left, R = r.right - c.r, T = c.t - r.top, B = r.bottom - c.b;
      if (centred && Math.abs(L - R) > 2.5 && r.right > c.r) issues.push(`h-pad ${L.toFixed(1)}/${R.toFixed(1)}`);
      if (Math.abs(T - B) > 2.5 && r.bottom > c.b && r.height < 60) issues.push(`v-pad ${T.toFixed(1)}/${B.toFixed(1)}`);
    }
    if (iconOnly && bg && r.width < 60 && Math.abs(r.width - r.height) > 1.5) issues.push(`not-square ${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
    if (iconOnly && r.width < 60) {
      const dx = (c.l + c.r) / 2 - (r.left + r.width / 2), dy = (c.t + c.b) / 2 - (r.top + r.height / 2);
      if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.2) issues.push(`off-center ${dx.toFixed(1)},${dy.toFixed(1)}`);
    }
    const ell = cs.textOverflow === 'ellipsis' || [...el.querySelectorAll('*')].some((x) => getComputedStyle(x).textOverflow === 'ellipsis');
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible' && !ell) issues.push(`clipped ${el.scrollWidth}>${el.clientWidth}`);
    el.parentElement.dataset.qaRow ||= Math.random().toString(36).slice(2, 8);
    out.push({ state, row: el.parentElement.dataset.qaRow, bg, iconOnly, name: name(el), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), w: +r.width.toFixed(1), h: +r.height.toFixed(1), issues });
  }
  if (only) return out;
  const top = all.filter(onTop);
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      if (top[i].contains(top[j]) || top[j].contains(top[i])) continue;
      const a = top[i].getBoundingClientRect(), b = top[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) out.push({ state, name: `${name(top[i])} ⟷ ${name(top[j])}`, text: '', issues: [`overlap ${ox.toFixed(0)}x${oy.toFixed(0)}`] });
    }
  return out;
}

// ---- a QA wisp with something in every place a button can be ----
const { w, tasks, goal } = await seededWisp(PORT);
const VIEWS = viewsOf({ tasks, goal });

const { chromium } = playwright();
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const failed = [];
let unhovered = 0; // buttons that couldn't be hovered or focused (covered, moved away): counted, not hidden
const runs = [];
for (const theme of THEMES) for (const width of WIDTHS) runs.push({ theme, width });
if (WIDTHS.includes(390)) runs.push({ theme: THEMES[0], width: 390, app: true });
for (const { theme, width, app } of runs) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: theme, ...(app && { userAgent: APP_UA, hasTouch: true, isMobile: true }) });
  await ctx.addInitScript(`window.__qaMeasure = ${measure}`);
  const p = await ctx.newPage();
  for (const [view, go] of Object.entries(VIEWS)) {
    if (app && NOT_IN_APP.has(view)) continue;
    const at = `${view}@${width}-${theme}${app ? '-app' : ''}`;
    try {
      // Each view from a clean page: a panel or task left open (kept in localStorage) would cover the next
      await p.evaluate(() => localStorage.clear()).catch(() => {});
      await p.goto(w.url);
      await p.waitForTimeout(900);
      // A task left open on a phone stays open over the list: back to it first.
      for (let i = 0; i < 3 && (await p.evaluate(() => document.body.classList.contains('stack-page'))); i++) await click(p, '.sh-back:visible');
      await go(p);
      await p.waitForTimeout(400);
    } catch (err) {
      failed.push(`${at}: ${String(err.message).split('\n')[0]}`);
      continue;
    }
    const rows = (await p.evaluate(() => window.__qaMeasure('rest'))).map((r) => ({ ...r, view: at }));
    results.push(...rows);
    if (QUICK) continue;
    const tiles = [];
    for (const h of await p.$$('button, [role=button], a.ghost, a.btn')) {
      const bx = await h.boundingBox().catch(() => null);
      if (!bx?.width || bx.y < 0 || bx.y + bx.height > p.viewportSize().height || bx.x < 0) continue;
      if (!(await h.isVisible().catch(() => false))) continue;
      const clip = { x: Math.max(0, bx.x - 8), y: Math.max(0, bx.y - 6), width: Math.min(bx.width + 16, 700), height: Math.min(bx.height + 12, 200) };
      const shots = [];
      try {
        shots.push(await p.screenshot({ clip }));
        await h.hover({ force: true, timeout: 500 });
        await p.waitForTimeout(160);
        results.push(...(await h.evaluate((el) => window.__qaMeasure('hover', el))).map((r) => ({ ...r, view: at })));
        shots.push(await p.screenshot({ clip }));
        await p.mouse.move(0, 0);
        await h.evaluate((el) => el.focus({ focusVisible: true }));
        await p.waitForTimeout(160);
        results.push(...(await h.evaluate((el) => window.__qaMeasure('focus', el))).map((r) => ({ ...r, view: at })));
        shots.push(await p.screenshot({ clip }));
        await h.evaluate((el) => el.blur());
      } catch {
        unhovered++;
      }
      tiles.push({ label: await h.evaluate((el) => (el.id ? `#${el.id}` : '') + [...el.classList].slice(0, 2).map((c) => `.${c}`).join('')), w: bx.width, h: bx.height, shots });
    }
    await p.mouse.move(0, 0);
    // The contact sheet: rest, hover, focus side by side for each button.
    const sheet = await ctx.newPage();
    await sheet.setViewportSize({ width: 1400, height: 900 });
    await sheet.setContent(`<body style="margin:0;font:11px system-ui;background:${theme === 'dark' ? '#333' : '#ddd'};color:${theme === 'dark' ? '#eee' : '#111'}"><div style="display:flex;flex-wrap:wrap;gap:6px;padding:6px">${tiles
      .map((t, i) => `<div style="padding:3px;background:#8882"><div>${i} ${t.label} ${Math.round(t.w)}×${Math.round(t.h)}</div>${t.shots.map((s) => `<img src="data:image/png;base64,${s.toString('base64')}" style="height:${t.h + 12}px;margin-right:4px">`).join('')}</div>`)
      .join('')}</div></body>`);
    await sheet.screenshot({ path: path.join(SHEETS, `${at}.png`), fullPage: true });
    await sheet.close();
  }
  await ctx.close();
}
await browser.close();
w.stop();

// Side by side in one bar: every box painted there (resting, lit or hovered) is the same height.
const rows = new Map();
for (const r of results) {
  if (!r.row || !r.bg || r.state === 'focus') continue;
  const k = `${r.view}|${r.row}`;
  if (!rows.has(k)) rows.set(k, new Map());
  rows.get(k).set(r.name, r.h);
}
const found = new Map();
const note = (key, where) => (found.has(key) || found.set(key, []), found.get(key).push(where));
for (const [k, m] of rows) {
  const hs = [...new Set(m.values())];
  // Menus and lists stack rows of different lengths: only bars (all on one line) count.
  if (hs.length > 1 && hs.every((h) => h <= 44)) note(`row-heights ${[...m].map(([n, h]) => `${n.split(' > ')[1]}=${h}`).sort().join(' ')}`, k.split('|')[0]);
}
for (const r of results) for (const i of r.issues) note(`${r.name} | ${i.split(' ')[0]}`, `${r.view}/${r.state} ${i}`);
const open_ = [...found].filter(([k]) => !ALLOWED.some((re) => re.test(k)));
fs.writeFileSync(path.join(OUT, 'buttons.json'), JSON.stringify({ measured: results.length, failedViews: failed, issues: Object.fromEntries(open_), results }, null, 1));
const views = new Set(results.map((r) => r.view)).size;
const n = (s) => results.filter((r) => r.state === s).length;
console.log(`\n  buttons: ${results.length} measurements in ${views} views: ${n('rest')} at rest, ${n('hover')} hovered, ${n('focus')} focused${unhovered ? ` (${unhovered} couldn't be hovered)` : ''}`);
for (const f of failed) console.log(`  ! view didn't open: ${f}`);
for (const [k, v] of open_) console.log(`  ✗ ${k}\n      ${v.slice(0, 3).join('\n      ')}${v.length > 3 ? `\n      (+${v.length - 3} more)` : ''}`);
console.log(`  ${open_.length ? `${open_.length} spacing issues` : 'no spacing issues'} · ${path.relative(process.cwd(), SHEETS)}/`);
process.exit(open_.length || failed.length ? 1 : 0);
