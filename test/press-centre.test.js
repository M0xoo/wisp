// On a phone a pressed button shrinks (responsive.css: `transform: scale(0.96)` on :active and
// .pressed), and that transform replaces the button's own. A button centred with
// `transform: translateX(-50%)` lost its centring as the finger went down and jumped right by
// half its width: the doc block's Read all moved away from the tap. Centre with `translate`
// (its own property, which the press leaves alone) or with layout instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'web');
const files = (dir, ext) => fs.readdirSync(path.join(WEB, dir), { recursive: true }).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8').replace(/\r\n/g, '\n');

function buttonClasses() {
  const out = new Set();
  for (const f of files('js', '.js')) {
    for (const m of read(f).matchAll(/<button\b[^>]*?\bclass="([^"$]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

test('a button is never centred by transform: a press on a phone replaces it', () => {
  const buttons = buttonClasses();
  assert.ok(buttons.has('doc-more'), 'finds the doc block’s Read all button');
  const bad = [];
  for (const f of files('css', '.css')) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|;)\s*transform\s*:[^;]*translate[XY]?\([^)]*-50%/.test(m[2])) continue;
      for (const s of m[1].split(',')) {
        const last = s.trim().split(/[\s>+~]+/).pop() || '';
        const hit = [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1]).find((c) => buttons.has(c));
        if (hit) bad.push(`${f}: ${s.trim()}`);
      }
    }
  }
  assert.deepEqual(bad, [], `centred with transform, so it jumps on a phone press: ${bad.join('; ')}. Use translate: -50% 0`);
});
