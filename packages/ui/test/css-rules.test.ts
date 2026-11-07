/// <reference types="vite/client" />
// The kit's CSS rules (plan §5), checked on every file in src/css: one layer order, every rule in
// a layer, px only from the token scale, no :has(), no :is(), no hard-coded colours.
import { expect, test } from 'vitest';
import { BREAKPOINT_PX, PX_SCALE } from '@wisp/tokens';

const files = import.meta.glob<string>('../src/css/*.css', { query: '?raw', import: 'default', eager: true });
const sheets = Object.entries(files).map(([path, raw]) => ({ name: path.replace('../src/css/', ''), css: raw.replace(/\/\*[^]*?\*\//g, '') }));

test('there are stylesheets to check', () => {
  expect(sheets.length).toBeGreaterThan(5);
});

test('the layer order is declared once, in index.css, with plugins last', () => {
  const orders = sheets.flatMap((s) => [...s.css.matchAll(/@layer\s+[\w\s,]+;/g)].map((m) => ({ file: s.name, text: m[0] })));
  expect(orders).toEqual([{ file: 'index.css', text: '@layer reset, tokens, kit, plugins;' }]);
  const index = sheets.find((s) => s.name === 'index.css');
  expect(index?.css.trim().startsWith('@layer reset, tokens, kit, plugins;')).toBe(true);
});

test('every other sheet is one @layer kit or @layer reset block', () => {
  for (const s of sheets.filter((x) => x.name !== 'index.css')) {
    const body = s.css.trim();
    expect(body, s.name).toMatch(/^@layer (kit|reset) \{/);
    // The opening brace closes only at the very end: nothing sits outside the layer.
    let depth = 0;
    let closedAt = -1;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '{') depth++;
      if (body[i] === '}' && --depth === 0) {
        closedAt = i;
        break;
      }
    }
    expect(closedAt, s.name).toBe(body.length - 1);
  }
});

/** Each px literal with whether it sits in an @media / @container condition. */
function pxUses(css: string): Array<{ px: number; inQuery: boolean }> {
  const out: Array<{ px: number; inQuery: boolean }> = [];
  for (const m of css.matchAll(/(@media|@container)[^{]*\{|(-?\d*\.?\d+)px/g)) {
    if (m[1]) {
      for (const q of m[0].matchAll(/(\d*\.?\d+)px/g)) out.push({ px: Number(q[1]), inQuery: true });
    } else if (m[2]) {
      out.push({ px: Math.abs(Number(m[2])), inQuery: false });
    }
  }
  return out;
}

test('px values come from the token scale (breakpoints only in @media / @container)', () => {
  const scale = new Set(PX_SCALE);
  const bps = new Set(BREAKPOINT_PX);
  const bad: string[] = [];
  for (const s of sheets) {
    for (const u of pxUses(s.css)) {
      const ok = u.px === 0 || (u.inQuery ? bps.has(u.px) : scale.has(u.px));
      if (!ok) bad.push(`${s.name}: ${u.px}px${u.inQuery ? ' (in a query)' : ''}`);
    }
  }
  expect(bad).toEqual([]);
});

test('no :has() and no :is() (they make every style recalc walk large boxes)', () => {
  for (const s of sheets) {
    expect(s.css, s.name).not.toMatch(/:has\(/);
    expect(s.css, s.name).not.toMatch(/:is\(/);
  }
});

test('no hard-coded colours: every colour is a token', () => {
  for (const s of sheets.filter((x) => x.name !== 'index.css')) {
    expect(s.css, s.name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s.css, s.name).not.toMatch(/\brgba?\(/);
    expect(s.css, s.name).not.toMatch(/:\s*(white|black)\b/);
  }
});

test('the kit styles by data-kit attributes, never by class names', () => {
  for (const s of sheets) {
    // A class selector starts a selector or follows a combinator; decimals (0.5) never do.
    expect(s.css, s.name).not.toMatch(/(^|[\s,>+~(])\.[a-zA-Z_-][\w-]*\s*[{,:[]/m);
  }
});

test('nothing wraps a row but Wrap: flex-wrap: wrap appears only in its rule (design/layout.md §5)', () => {
  const wraps = sheets.flatMap((s) => [...s.css.matchAll(/([^{}]+)\{[^{}]*flex-wrap:\s*wrap/g)].map((m) => `${s.name}: ${(m[1] ?? '').trim()}`));
  expect(wraps).toEqual(["layout.css: [data-kit='wrap'], [data-layout='wrap']"]);
});

test('control text never gets white-space: normal', () => {
  for (const s of sheets) expect(s.css, s.name).not.toMatch(/white-space:\s*normal/);
  const layout = sheets.find((x) => x.name === 'content.css')?.css ?? '';
  expect(layout).toMatch(/\[data-text='control'\]\s*\{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
});

test('a bar has a token height and never wraps', () => {
  const css = sheets.find((x) => x.name === 'composites.css')?.css ?? '';
  const rule = /\[data-kit='toolbar'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(rule).toMatch(/height: var\(--bar-h\)/);
  expect(rule).toMatch(/flex-wrap: nowrap/);
});
