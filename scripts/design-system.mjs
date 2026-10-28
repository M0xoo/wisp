#!/usr/bin/env node
// Builds wisp's design system for Claude Design (claude.ai/design) from the real thing: the page's
// stylesheets in index.html order, its icon sprite, design/*.md, the cards in design/system/cards
// and, with --screens, static copies of real screens taken from an isolated wisp with fake agents.
// Prototypes made there use wisp's own class names, so they come back to web/ without translating.
//
//   node scripts/design-system.mjs            foundations, components, guidelines
//   node scripts/design-system.mjs --screens  also the screens (Chrome + playwright-core, see qa/README.md)
//
// Output: qa/out/design-system/ (gitignored), with manifest.json: each file's hash, so a sync to the
// Claude Design project (DesignSync) writes only what changed and deletes what's gone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'design/system');
const OUT = process.env.DS_OUT || path.join(ROOT, 'qa/out/design-system');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => {
  fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true });
  fs.writeFileSync(path.join(OUT, p), s);
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const index = read('web/index.html');
const sheets = [...index.matchAll(/<link rel="stylesheet" href="\/css\/([\w-]+\.css)">/g)].map((m) => m[1]);
const spriteStart = index.lastIndexOf('<svg', index.indexOf('<symbol'));
const sprite = index.slice(spriteStart, index.indexOf('</svg>', index.lastIndexOf('</symbol>')) + 6);
const icons = [...sprite.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1]);

// The dark tokens again as a class, so a card can show light and dark side by side.
const tokens = read('web/css/tokens.css');
const darkVars = /:root\[data-theme='dark'\] \{([^}]*)\}/.exec(tokens)[1];
const scopedDark = `/* the dark tokens on any element (Claude Design cards show both themes at once) */\n.wisp-dark {${darkVars}  background: var(--bg); color: var(--ink);\n}\n`;

fs.rmSync(OUT, { recursive: true, force: true });
write('wisp.css', `/* wisp's page stylesheets in index.html order (web/css/*.css). Generated: edit web/css, not this. */\n${sheets.map((f) => `\n/* ---- ${f} ---- */\n${read(`web/css/${f}`)}`).join('\n')}\n${scopedDark}`);
write('kit.css', read('design/system/kit.css'));
write('icons.svg', sprite.replace('<svg width="0" height="0" style="position:absolute" aria-hidden="true">', '<svg xmlns="http://www.w3.org/2000/svg">'));
fs.cpSync(path.join(ROOT, 'web/logos'), path.join(OUT, 'assets/logos'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'web/favicon.svg'), path.join(OUT, 'assets/favicon.svg'));
write('README.md', read('design/system/README.md'));
for (const f of ['README', 'ui', 'ux', 'mobile', 'copy', 'crew', 'checklist']) write(`guidelines/${f}.md`, read(`design/${f}.md`));

// One page per card. The first line is the @dsCard marker Claude Design indexes its pane by.
const page = ({ group, title, body, depth = 1, wide = false }) => {
  const up = '../'.repeat(depth);
  return `<!-- @dsCard group="${group}" -->
<!doctype html>
<html lang="en"${wide ? ' data-theme="light"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · wisp</title>
<link rel="stylesheet" href="${up}wisp.css">
<link rel="stylesheet" href="${up}kit.css">
</head>
${body.replace(/(src|href)="\/(logos)\//g, `$1="${up}assets/$2/`).replace(/<body([^>]*)>/, `<body$1>\n${sprite}`)}
</html>
`;
};

// design/system/cards → preview/, design/system/prototypes → prototypes/. The first line is
// <!-- @card group="…" title="…" [body="classes"] [single] [screen] -->: body gives the classes
// the parts need (the list's rows want body.split); single shows one theme instead of light and
// dark side by side; screen means the rest is a whole page: a copy of a screens/ file, kept as is.
const ICON_GRID = icons.map((n) => `<figure class="ds-icon"><svg class="i"><use href="#i-${n}"/></svg><figcaption>${n}</figcaption></figure>`).join('');
let cards = 0;
for (const [from, to] of [['cards', 'preview'], ['prototypes', 'prototypes']]) {
  const dir = path.join(SRC, from);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const head = /^<!-- @card ([^\n]*?) -->\n/.exec(src);
    const attr = (k) => head && new RegExp(`(?:^| )${k}(?:="([^"]*)")?(?= |$)`).exec(head[1]);
    if (!attr('group')?.[1] || !attr('title')?.[1]) throw new Error(`${from}/${f}: first line must be <!-- @card group="…" title="…" -->`);
    const html = src.slice(head[0].length).replaceAll('{{ICONS}}', ICON_GRID);
    const cls = `ds${attr('body') ? ` ${attr('body')[1]}` : ''}`;
    const body = attr('single')
      ? `<body class="${cls}">\n<main class="ds-theme">${html}</main>\n</body>`
      : `<body class="${cls}">\n<div class="ds-pair"><main class="ds-theme">${html}</main><main class="ds-theme wisp-dark" aria-hidden="true">${html}</main></div>\n</body>`;
    if (attr('screen')) write(`${to}/${f}`, `<!-- @dsCard group="${attr('group')[1]}" -->\n${html.replace(/^<!-- @dsCard[^\n]*\n/, '')}`);
    else write(`${to}/${f}`, page({ group: attr('group')[1], title: attr('title')[1], body }));
    cards++;
  }
}

if (process.argv.includes('--screens')) await screens();

// What's in the bundle and each file's hash: a sync compares it with the project's copy and
// writes only what changed.
const files = {};
const walk = (d) => {
  for (const e of fs.readdirSync(path.join(OUT, d), { withFileTypes: true })) {
    const rel = d ? `${d}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel);
    else if (rel !== 'manifest.json') files[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, rel))).digest('hex').slice(0, 16);
  }
};
walk('');
write('manifest.json', `${JSON.stringify({ files }, null, 1)}\n`);
console.log(`design system → ${path.relative(ROOT, OUT)} (${cards} cards, ${icons.length} icons, ${sheets.length} stylesheets, ${Object.keys(files).length} files)`);

// Real screens, frozen: an isolated wisp with fake agents, its DOM after it painted, scripts out.
async function screens() {
  const { startWisp, playwright, CHROME, api } = await import('../qa/lib.mjs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const w = await startWisp({ port: Number(process.env.DS_PORT) || 4498, extraEnv: { FAKE_DELAY: '1200' } });
  const shots = [];
  try {
    const ask = (prompt, extra = {}) => api(w.url, '/api/sessions', { prompt, cwd: w.repo, agent: 'claude', ...extra });
    await ask('Fix the failing test in math.js');
    await sleep(3500);
    const { chromium } = playwright();
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const grab = async (name, title, { width, height = 900, dark = false, mobile = false, open = false, menu = false }) => {
      const ctx = await browser.newContext({
        viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2,
        ...(mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 14) wispMobile', hasTouch: true, isMobile: true } : {}),
      });
      const p = await ctx.newPage();
      await p.goto(w.url);
      await sleep(1200);
      if (open) {
        await p.locator('#secNeeds .item .it-head').first().click();
        await sleep(1200);
      }
      if (menu) {
        await p.locator('#secNeeds .item .it-head').first().click({ button: 'right' });
        await sleep(500);
      }
      await p.mouse.move(0, height - 1);
      await sleep(300);
      const body = await p.evaluate((dark) => {
        const b = document.body.cloneNode(true);
        b.querySelectorAll('script, symbol, input[type=file]').forEach((n) => n.remove());
        b.querySelectorAll('svg > defs:empty').forEach((n) => n.parentElement.remove());
        b.querySelectorAll('[data-h]').forEach((n) => n.removeAttribute('data-h'));
        // Freeze entry animations: a static copy should open as it looked, not replay them.
        b.querySelectorAll('[style*="animation"]').forEach((n) => n.style.removeProperty('animation'));
        const theme = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
        return { html: b.outerHTML, theme, cls: document.documentElement.className };
      }, dark);
      const file = `screens/${name}.html`;
      // The QA repo's random name would change every file on every sync.
      const html = body.html.replace(/wisp-repo-\w+/g, 'wisp').replace(/<body/, `<body data-width="${width}"`);
      write(file, page({ group: 'Screens', title, depth: 1, wide: true, body: html })
        .replace(` data-theme="light"`, ` data-theme="${body.theme}" class="${esc(body.cls)} ds-screen" style="--ds-w: ${width}px"`));
      await p.screenshot({ path: path.join(OUT, `screens/${name}.png`) });
      shots.push(name);
      await ctx.close();
    };
    await grab('home-1440', 'Home, side by side', { width: 1440 });
    await grab('home-1440-dark', 'Home, side by side, dark', { width: 1440, dark: true });
    await grab('task-1440', 'A finished task, side by side', { width: 1440, open: true });
    await grab('menu-1440', 'Right-click menu on a task', { width: 1440, menu: true });
    await grab('list-390', 'Phone: the list', { width: 390, height: 844, mobile: true });
    await grab('task-390', 'Phone: a task page', { width: 390, height: 844, mobile: true, open: true });
    await browser.close();
  } finally {
    await w.stop?.();
  }
  console.log(`screens: ${shots.join(', ')}`);
}
