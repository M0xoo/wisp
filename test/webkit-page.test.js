// The page also runs on WebKit (the Tauri app on a Mac). CI only has Chromium, so what keeps it right
// there is held here; qa/scenarios/desktop.md has the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('the code font is the same in both engines: only WebKit knows ui-monospace', () => {
  assert.doesNotMatch(read('css/tokens.css').match(/--mono:.*/)[0], /ui-monospace/);
});

test('list rows skip layout except on WebKit, which would scroll a skipped row out of the list', () => {
  const css = read('css/responsive.css');
  const rule = css.indexOf('#feed .item:not(.open) { content-visibility');
  assert.ok(rule > 0);
  const open = css.lastIndexOf('@supports not (-webkit-nbsp-mode: space) {', rule);
  assert.ok(open > 0 && !css.slice(open, rule).includes('\n}'), 'the rule sits inside the @supports');
});

test("a flow's dashes are real px: WebKit draws nothing for a fraction of a pathLength of 1", () => {
  assert.doesNotMatch(read('css/blocks.css').match(/\.wire\.back \{.*/)[0], /stroke-dasharray/);
  assert.match(read('js/blocks.js'), /getTotalLength\(\) \* FLOW_DASH/);
});

test('the terminal has its scrollbar colour without scrollbar-color', () => {
  assert.match(read('css/term.css'), /\.tm-screen::-webkit-scrollbar-thumb \{ background-color: #3a3a3a; \}/);
});
