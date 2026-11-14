import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, type TokenFiles } from '../src/render.ts';
import { readTokenFiles } from '../src/build.ts';
import { BREAKPOINTS, PX_SCALE, SPLIT_MIN_WIDTH, SPACES, TONES } from '../src/index.ts';
import { spaceVar, toneVar } from '../src/vars.ts';

const files = readTokenFiles();
const { css } = render(files);
const with_ = (patch: Partial<TokenFiles>): TokenFiles => ({ ...files, ...patch });

/** The declarations inside the first block whose selector is `selector`. */
function blockOf(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)) out.set(m[1] ?? '', m[2] ?? '');
  return out;
}

test('everything sits in @layer tokens', () => {
  assert.match(css, /\*\/\n@layer tokens \{\n  :root \{/);
  assert.ok(css.trimEnd().endsWith('}'));
});

test('light, system dark and forced dark define the same colour set', () => {
  const light = blockOf(':root');
  const system = blockOf(":root:not([data-theme='light'])");
  const forced = blockOf("[data-theme='dark']");
  const island = blockOf("[data-theme='light']");
  const themed = [...system.keys()];
  assert.deepEqual([...island.keys()], themed);
  assert.deepEqual([...forced.keys()], themed);
  for (const k of themed) assert.ok(light.has(k), `${k} missing from light`);
  assert.equal(light.get('color-scheme'), 'light');
  assert.equal(forced.get('color-scheme'), 'dark');
  assert.equal(light.get('--accent'), '#2f5bea');
  assert.equal(forced.get('--accent'), '#6d8dff');
});

test('the system dark block is inside prefers-color-scheme and yields to [data-theme=light]', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {4}:root:not\(\[data-theme='light'\]\) \{/);
});

test('v1 names survive for spells: --accent, --sans, --shadow-2, --ease, --radius', () => {
  const light = blockOf(':root');
  for (const name of ['--accent', '--ink', '--line-2', '--sans', '--mono', '--shadow-2', '--ease', '--radius', '--pc-violet']) {
    assert.ok(light.has(name), name);
  }
});

test('the spacing scale is about eight steps of px, starting at 0', () => {
  assert.deepEqual(SPACES, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(blockOf(':root').get('--space-4'), '8px');
  assert.equal(spaceVar('4'), 'var(--space-4)');
});

test('tones map onto colour tokens', () => {
  assert.deepEqual(TONES, ['neutral', 'accent', 'good', 'warn', 'bad', 'info']);
  assert.equal(blockOf(':root').get('--tone-bad'), 'var(--bad)');
  assert.equal(toneVar('good'), 'var(--tone-good)');
});

test('SPLIT_MIN_WIDTH is 900 and every breakpoint is a number', () => {
  assert.equal(SPLIT_MIN_WIDTH, 900);
  assert.equal(BREAKPOINTS.split, 900);
  assert.equal(BREAKPOINTS.phone, 720);
});

test('PX_SCALE holds the scale and nothing else', () => {
  assert.ok(PX_SCALE.includes(8) && PX_SCALE.includes(1) && PX_SCALE.includes(99));
  assert.ok(!PX_SCALE.includes(13.5));
  assert.deepEqual([...PX_SCALE], [...PX_SCALE].sort((a, b) => a - b));
});

test('a colour with only a light value is refused', () => {
  const color = { extra: { only: { light: '#fff' } } };
  assert.throws(() => render(with_({ color })), /color\.extra\.only: needs a light and a dark value/);
});

test('a colour defined in two groups is refused', () => {
  const color = { a: { x: { light: '#000', dark: '#fff' } }, b: { x: { light: '#000', dark: '#fff' } } };
  assert.throws(() => render(with_({ color, tone: {} })), /"x" is defined twice/);
});

test('a tone that names a missing colour is refused', () => {
  assert.throws(() => render(with_({ tone: { odd: 'nope' } })), /tone\.odd: names "nope"/);
});

test('a space step that is not px is refused', () => {
  assert.throws(() => render(with_({ space: { '1': '0.5rem' } })), /space\.1: expected a px value/);
});

test('token names are lowercase with dashes', () => {
  assert.throws(() => render(with_({ radius: { Big: '4px' } })), /bad token name "Big"/);
});

test('$doc keys are documentation, not tokens', () => {
  assert.ok(!css.includes('$doc') && !css.includes('--space-$'));
});

test('a missing split breakpoint is refused: the shell needs SPLIT_MIN_WIDTH', () => {
  assert.throws(() => render(with_({ breakpoint: { phone: '720px' } })), /missing "split"/);
});
