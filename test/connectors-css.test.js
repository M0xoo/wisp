// Settings → Connectors and the Changes panel once shared the cx- prefix: panel.css's 13px Viewed
// checkbox (.cx-box) wrapped the whole pane, and its file rows (.cx-row, .cx-list, .cx-edit)
// restyled the connector rows and the editor. The pane keeps a prefix of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8').replace(/\r\n/g, '\n');
const PREFIX = 'cn-';

// What the Connectors UI is made of: its module, its stylesheet, the pane's box in Settings and
// the connector card a turn shows.
function connectorSources() {
  const turns = read('js/features/turns.js');
  const card = turns.slice(turns.indexOf('function renderConnectorCard'));
  const settings = read('js/features/settings.js');
  return {
    'js/features/connectors.js': read('js/features/connectors.js'),
    'css/connectors.css': read('css/connectors.css'),
    'settings.js connectors pane': settings.split('\n').filter((l) => /connectors/i.test(l)).join('\n'),
    'turns.js renderConnectorCard': card.slice(0, card.indexOf('\nfunction ', 1)),
  };
}

test('the Connectors UI uses none of the Changes panel’s cx- classes', () => {
  for (const [name, src] of Object.entries(connectorSources())) {
    const hits = [...new Set(src.match(/\bcx-[a-z][a-z-]*/g) || [])];
    assert.deepEqual(hits, [], `${name} uses ${hits.join(', ')}`);
  }
});

test('no other stylesheet styles a Connectors class', () => {
  const own = new Set();
  for (const src of Object.values(connectorSources())) for (const m of src.matchAll(/\bcn-[a-z][a-z-]*/g)) own.add(m[0]);
  assert.ok(own.has('cn-box') && own.has('cn-row'), 'the pane box and its rows use the prefix');
  for (const f of fs.readdirSync(path.join(WEB, 'css'))) {
    if (!f.endsWith('.css') || f === 'connectors.css') continue;
    const css = read(`css/${f}`);
    const clash = [...own].filter((c) => new RegExp(`\\.${c}(?![\\w-])`).test(css));
    assert.deepEqual(clash, [], `css/${f} styles ${clash.join(', ')}`);
  }
  // And the prefix is the pane's alone: nothing else in web/ names a class with it.
  const others = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name) && !/features[\\/](connectors|settings|turns)\.js$/.test(p) && !/spell-schema\.js$/.test(p)) {
        if (new RegExp(`\\b${PREFIX}[a-z]`).test(fs.readFileSync(p, 'utf8'))) others.push(path.relative(WEB, p));
      }
    }
  };
  walk(path.join(WEB, 'js'));
  assert.deepEqual(others, [], `${others.join(', ')} use ${PREFIX}`);
});
