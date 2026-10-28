// scripts/design-system.mjs: the bundle wisp's Claude Design project is synced from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('builds the design system from the page itself', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-ds-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/design-system.mjs')], { env: { ...process.env, DS_OUT: out } });
  const css = fs.readFileSync(path.join(out, 'wisp.css'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  for (const [, f] of index.matchAll(/<link rel="stylesheet" href="\/css\/([\w-]+\.css)">/g)) assert.ok(css.includes(`/* ---- ${f} ---- */`), `wisp.css misses ${f}`);
  assert.match(css, /\.wisp-dark \{[^}]*--bg: #111111/, 'the dark tokens as a class');
  const cards = fs.readdirSync(path.join(out, 'preview'));
  assert.ok(cards.length >= 10);
  for (const f of cards) {
    const html = fs.readFileSync(path.join(out, 'preview', f), 'utf8');
    assert.match(html.split('\n')[0], /^<!-- @dsCard group="[^"]+" -->$/, `${f}: Claude Design reads the group from the first line`);
    assert.ok(html.includes('<symbol id="i-check"'), `${f}: has the sprite`);
    for (const [, id] of html.matchAll(/<use href="#i-([\w-]+)"/g)) assert.ok(html.includes(`<symbol id="i-${id}"`), `${f}: no icon i-${id}`);
  }
  const { files } = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.ok(files['wisp.css'] && files['README.md'] && files['guidelines/ui.md'] && files['preview/05-buttons.html']);
  fs.rmSync(out, { recursive: true, force: true });
});
