// web/css is one global namespace. Twice a prefix was taken by two areas, and the later stylesheet
// restyled the other's UI: the Changes panel's .cx-box wrapped Settings → Connectors (#720), and
// the crew rail's hover card (.cl-card, .cl-row, .cl-slot in crew.css) turned Settings → Cloud's
// account card into a floating popover and crushed its sign-in row (in Cloud and Machines).
// A class's own rule (`.x { … }`, `.x:hover`, `.x[hidden]`) lives in one stylesheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.join(import.meta.dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8').replace(/\r\n/g, '\n');

// One component written across two files on purpose: the composer's hint (later.css lets it
// shrink beside the time chip), the launcher's project chips (machines.css adds the row gap for
// their machine names), and the overlay (the palette and Compare place their own).
const SPLIT = new Set(['c-hint', 'l-projects', 'overlay']);
// Two components under one name, each fixed in its own PR (the project picker and Make a pane;
// a spell's card host and home's spare row). Take a name off once its fix is in.
const KNOWN = new Set(['pm-list', 'sp-card']);

function bareRules() {
  const at = new Map();
  for (const f of fs.readdirSync(path.join(WEB, 'css'))) {
    // tokens.css holds no components; responsive.css restyles every area at its widths.
    if (!f.endsWith('.css') || f === 'tokens.css' || f === 'responsive.css') continue;
    const css = read(`css/${f}`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      const sel = m[1].trim();
      if (sel.startsWith('@')) continue;
      for (const s of sel.split(/,(?![^(]*\))/)) {
        const own = s.trim().match(/^\.([a-zA-Z][\w-]*)(?:\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)*$/);
        if (!own) continue;
        if (!at.has(own[1])) at.set(own[1], new Set());
        at.get(own[1]).add(f);
      }
    }
  }
  return at;
}

test('no class has its own rule in two stylesheets', () => {
  const twice = [...bareRules()].filter(([c, files]) => files.size > 1 && !SPLIT.has(c) && !KNOWN.has(c)).map(([c, files]) => `.${c} (${[...files].join(', ')})`);
  assert.deepEqual(twice, [], `styled as two things: ${twice.join('; ')}. Give one area a prefix of its own (grep web/css first)`);
});

test('the split list only names classes that are still split', () => {
  const at = bareRules();
  for (const c of SPLIT) assert.ok(at.get(c)?.size > 1, `.${c} is in one stylesheet now: take it off the list`);
});

test('Settings → Cloud and the crew rail keep apart: cg- and cl-', () => {
  const cloud = read('js/features/cloud.js');
  assert.deepEqual([...new Set(cloud.match(/\bcl-[a-z][a-z-]*/g) || [])], [], 'cloud.js uses the crew rail’s cl- classes');
  assert.ok(/class="cg-card/.test(cloud) && /cg-signin/.test(cloud), 'the Cloud pane names its card and sign-in with cg-');
  assert.doesNotMatch(read('css/crew.css'), /\.cg-[a-z]/, 'crew.css styles a Cloud class');
  assert.doesNotMatch(read('css/machines.css'), /\.cl-[a-z]/, 'machines.css styles a crew rail class');
});
