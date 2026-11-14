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

test('a_pressed_button_never_jumps_none_is_centred_by_transform_v1_782', () => {
  // the press is a transform (scale): a button centred by translate(-50%) jumps by half its width under the finger
  for (const s of sheets) {
    for (const m of s.css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, sel = '', body = ''] = m;
      if (/(button|btn|icon-button|link)/.test(sel)) expect(body, `${s.name}: ${sel.trim()}`).not.toMatch(/transform:\s*translate(X)?\(\s*-50%/);
    }
  }
});

test('the_task_heads_title_is_one_line_at_every_width_v1_778', () => {
  // a subagent's title beside its lead's is one line too on the phone: no sheet lets the head's title wrap
  const rules = sheets.flatMap((s) => [...s.css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => (m[1] ?? '').includes("[data-kit='sh-title']")).map((m) => ({ file: s.name, body: m[2] ?? '' })));
  expect(rules.length).toBeGreaterThan(0);
  for (const r of rules) expect(r.body, r.file).not.toMatch(/white-space:\s*(normal|pre-wrap)|line-clamp|text-wrap-mode:\s*wrap/);
  expect(rules.some((r) => /white-space: nowrap/.test(r.body) && /text-overflow: ellipsis/.test(r.body))).toBe(true);
});

/** Every rule of a sheet as [selector, body, the @media conditions it sits in]. */
function rulesIn(css: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const stack: string[] = [];
  let head = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const sel = head.trim();
      head = '';
      if (sel.startsWith('@')) {
        stack.push(sel);
        continue;
      }
      const end = css.indexOf('}', i);
      out.push([sel, css.slice(i + 1, end), stack.filter((x) => x.startsWith('@media')).join(' ')]);
      i = end;
    } else if (c === '}') {
      stack.pop();
      head = '';
    } else head += c;
  }
  return out;
}

test('on_touch_mark_done_keeps_its_own_column_after_the_time_and_save_for_later_leaves_v1_has_quick', () => {
  // seen at 390 (2026-11-14): on a touch screen Save for later and Mark done sat over the title, a letter peeking
  // between them. v1 parity (split.css #feed.has-quick): touch (hover: none) hides Save for later only; Mark done sits
  // in a 36px column of its own after the time, which exists only while the list sets --k-feed-done (no :has()).
  const rules = rulesIn(sheets.find((s) => s.name === 'composites.css')?.css ?? '');
  const row = "[data-kit='list-row'][data-layout='feed']";
  const quick = `${row} > [data-kit='icon-button']`;
  const touch = rules.filter(([, , media]) => /\(hover:\s*none\)/.test(media));
  const at = (sel: string): string => touch.find(([s]) => s === sel)?.[1] ?? '';
  expect(at(`${quick}:not([data-tone='good'])`)).toMatch(/display:\s*none/);
  const done = at(`${row}[data-quick] > [data-kit='icon-button'][data-tone='good']`);
  expect(done).toMatch(/right:\s*8px/);
  expect(done).toMatch(/width:\s*36px/);
  expect(done).toMatch(/opacity:\s*1/);
  // the column, the title's and the time's room for it come only from the list's var: unset, v1's three columns
  expect(at(row)).toMatch(/grid-template-columns:\s*10px minmax\(0, 1fr\) auto var\(--k-feed-done,\)/);
  expect(at(`${row} > [data-kit='list-row-title']`)).toMatch(/padding-right:\s*calc\(36px \+ var\(--k-feed-done-pad, 0px\)\)/);
  expect(touch.some(([sel, body]) => sel.includes("[data-kit='time']") && /right:\s*calc\(12px \+ var\(--k-feed-done, 0px\)\)/.test(body))).toBe(true);
  // every rule that pads the feed title for the floating quick buttons sits under (hover: hover)
  const reserve = rules.filter(([sel, body]) => sel.includes('[data-quick=') && sel.includes("[data-kit='list-row-title']") && /padding-right/.test(body));
  expect(reserve.length).toBe(6);
  for (const [sel, , media] of reserve) expect(media, sel).toMatch(/\(hover:\s*hover\)/);
});
