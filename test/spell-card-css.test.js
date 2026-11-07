// Home's spare-allowance row (#539) took .sp-card, the class of a spell's card host in a task
// (#119). split.css's 13px / 1fr / auto / auto grid put a spell's card panel in the 13px column,
// one word per line, and spells.css gave the spare row its 12px / 0 padding. The row is spr- now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8').replace(/\r\n/g, '\n');

test('only spells.css styles a spell’s card host', () => {
  assert.match(read('js/features/spells.js'), /class="sp-card sp-card-\$\{where\}"/);
  for (const f of fs.readdirSync(path.join(WEB, 'css'))) {
    if (!f.endsWith('.css') || f === 'spells.css') continue;
    assert.doesNotMatch(read(`css/${f}`), /\.sp-card(?![\w-])/, `css/${f} styles .sp-card`);
  }
});

test('home’s spare rows use spr-, not the spells’ sp-card', () => {
  const split = read('js/features/split.js');
  assert.doesNotMatch(split, /\bsp-(card|text|x|start)\b/);
  assert.match(split, /class="spr-card"/);
  assert.match(read('css/split.css'), /^\.spr-card \{/m);
});
