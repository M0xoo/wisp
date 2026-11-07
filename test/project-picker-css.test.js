// Make a pane (#591) named its list .pm-list, the project picker's own class: panel.css loads after
// palette.css, so every project picker (launcher, top bar, crew editor, sharing) drew each project
// as a bordered, centred box in a framed list. Make a pane keeps mk-, the picker keeps pm-.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8').replace(/\r\n/g, '\n');

test('Make a pane uses none of the project picker’s pm- classes', () => {
  const src = read('js/features/pane-make.js');
  assert.deepEqual([...new Set(src.match(/\bpm-[a-z][a-z-]*/g) || [])], []);
  assert.match(src, /class="mk-list"/);
});

test('only palette.css styles the project picker', () => {
  const own = new Set(read('js/features/project-list.js').match(/\bpm-[a-z][a-z-]*/g));
  assert.ok(own.has('pm-list') && own.has('pm-row'));
  for (const f of fs.readdirSync(path.join(WEB, 'css'))) {
    // responsive.css restyles every area at its widths (the search box is 16px on a phone).
    if (!f.endsWith('.css') || f === 'palette.css' || f === 'responsive.css') continue;
    const css = read(`css/${f}`);
    const clash = [...own].filter((c) => new RegExp(`\\.${c}(?![\\w-])`).test(css));
    assert.deepEqual(clash, [], `css/${f} styles ${clash.join(', ')}`);
  }
});
