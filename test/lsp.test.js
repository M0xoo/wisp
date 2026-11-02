// The editor's language intelligence: server/lsp.js talking LSP to a language server (a fake one here).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { ask, findServer, langOf, stopAll } from '../server/lsp.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));
after(stopAll);

test('lsp: definition, references, hover and diagnostics, from the editor’s copy', async () => {
  process.env.WISP_LSP_TS = `${process.execPath} ${FAKE}`;
  const root = fs.realpathSync(tmp('lsp-'));
  const a = path.join(root, 'math.js');
  const b = path.join(root, 'use.js');
  fs.writeFileSync(a, 'export function add(a, b) {\n  return a + b; // TODO tests\n}\n');
  fs.writeFileSync(b, "import { add } from './math.js';\nconst twice = (x) => add(x, x);\n");
  const d = await ask(root, null, 'diagnostics', a, fs.readFileSync(a, 'utf8'));
  assert.equal(d.lsp, 'TypeScript');
  assert.deepEqual(d.diagnostics.map((x) => [x.line, x.severity, x.message]), [[2, 'warning', 'Something is left to do']]);
  const def = await ask(root, null, 'definition', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.deepEqual(def.hits.map((h) => [h.path, h.line, h.col]), [['math.js', 1, 17]]);
  assert.match(def.hits[0].text, /export function add/);
  const refs = await ask(root, null, 'references', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.deepEqual(refs.hits.map((h) => `${h.path}:${h.line}`).sort(), ['math.js:1', 'use.js:1', 'use.js:2']);
  const hover = await ask(root, null, 'hover', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.match(hover.hover, /function add\(a: number, b: number\): number/);
  const comp = await ask(root, null, 'completion', b, fs.readFileSync(b, 'utf8'), 2, 23);
  assert.deepEqual(comp.items.map((x) => x.insert), ['add', 'addAll']);
  // Rename: every place, in every file it knows, written
  const ren = await ask(root, null, 'rename', b, fs.readFileSync(b, 'utf8'), 2, 23, { newName: 'sum' });
  assert.deepEqual(ren.files.sort(), ['math.js', 'use.js']);
  assert.equal(ren.count, 3);
  assert.match(fs.readFileSync(a, 'utf8'), /export function sum\(a, b\)/);
  assert.equal(fs.readFileSync(b, 'utf8'), "import { sum } from './math.js';\nconst twice = (x) => sum(x, x);\n");
  // Unsaved edits are what it reads
  const edited = await ask(root, null, 'diagnostics', a, 'export function add(a, b) {\n  return a + b;\n}\n');
  assert.equal(edited.lsp, 'TypeScript');
  delete process.env.WISP_LSP_TS;
});

test('lsp: no server for the language, or none installed: the page keeps its text search', async () => {
  assert.equal(langOf('a.tsx'), 'ts');
  assert.equal(langOf('a.py'), 'py');
  assert.equal(langOf('README.md'), null);
  const root = tmp('lsp-none-');
  fs.writeFileSync(path.join(root, 'x.md'), '# hi');
  assert.deepEqual(await ask(root, null, 'hover', path.join(root, 'x.md'), '# hi'), { lsp: null, lang: null, install: null });
  const saved = process.env.PATH;
  process.env.PATH = root; // nothing installed anywhere
  try {
    assert.equal(findServer('go', root, null), null);
    const r = await ask(root, null, 'definition', path.join(root, 'x.py'), 'x = 1');
    assert.deepEqual(r, { lsp: null, lang: 'py', install: 'Python' }, 'Python: wisp can install pyright');
  } finally {
    process.env.PATH = saved;
  }
});
