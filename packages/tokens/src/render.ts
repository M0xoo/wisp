// Turns the token JSON (tokens/*.json) into tokens.css and generated.ts. Pure: no file access, so
// the freshness test renders in memory and compares with what is committed.

export interface TokenFiles {
  readonly color: unknown;
  readonly tone: unknown;
  readonly space: unknown;
  readonly radius: unknown;
  readonly font: unknown;
  readonly shadow: unknown;
  readonly size: unknown;
  readonly motion: unknown;
  readonly z: unknown;
  readonly breakpoint: unknown;
}

export interface Rendered {
  readonly css: string;
  readonly ts: string;
}

type Flat = ReadonlyArray<readonly [name: string, value: string]>;
type Themed = ReadonlyArray<readonly [name: string, light: string, dark: string]>;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const PX = /(-?\d+(?:\.\d+)?)px/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(where: string, why: string): never {
  throw new Error(`tokens: ${where}: ${why}`);
}

/** Entries of a JSON object, skipping `$doc` keys, with every name checked. */
function entries(v: unknown, where: string): Array<[string, unknown]> {
  if (!isRecord(v)) fail(where, 'expected an object');
  const out: Array<[string, unknown]> = [];
  for (const [k, val] of Object.entries(v)) {
    if (k.startsWith('$')) continue;
    if (!NAME.test(k)) fail(where, `bad token name "${k}" (lowercase, digits and dashes)`);
    out.push([k, val]);
  }
  return out;
}

function flat(v: unknown, where: string): Flat {
  return entries(v, where).map(([k, val]) => {
    if (typeof val !== 'string' || val === '') fail(`${where}.${k}`, 'expected a non-empty string');
    return [k, val] as const;
  });
}

function themed(v: unknown, where: string): Themed {
  return entries(v, where).map(([k, val]) => {
    if (!isRecord(val)) fail(`${where}.${k}`, 'expected {light, dark}');
    const { light, dark } = val;
    // Both or none: a token that exists in one theme only is how v1 drifted (--on-accent twice in dark).
    if (typeof light !== 'string' || typeof dark !== 'string') fail(`${where}.${k}`, 'needs a light and a dark value');
    return [k, light, dark] as const;
  });
}

function px(values: Flat, where: string): Flat {
  for (const [k, v] of values) {
    if (!/^\d+(\.\d+)?px$/.test(v)) fail(`${where}.${k}`, `expected a px value, got "${v}"`);
  }
  return values;
}

interface Model {
  readonly colorGroups: ReadonlyArray<readonly [group: string, tokens: Themed]>;
  readonly tones: Flat;
  readonly space: Flat;
  readonly radius: Flat;
  readonly family: Flat;
  readonly fontSize: Flat;
  readonly weight: Flat;
  readonly lineHeight: Flat;
  readonly tracking: Flat;
  readonly shadow: Themed;
  readonly size: Flat;
  readonly duration: Flat;
  readonly ease: Flat;
  readonly z: Flat;
  readonly breakpoint: Flat;
}

function model(files: TokenFiles): Model {
  const colorGroups = entries(files.color, 'color').map(([g, v]) => [g, themed(v, `color.${g}`)] as const);
  const colorNames = new Set<string>();
  for (const [, tokens] of colorGroups) {
    for (const [name] of tokens) {
      if (colorNames.has(name)) fail('color', `"${name}" is defined twice`);
      colorNames.add(name);
    }
  }
  const tones = flat(files.tone, 'tone');
  for (const [tone, ref] of tones) {
    if (!colorNames.has(ref)) fail(`tone.${tone}`, `names "${ref}", which is not a colour token`);
  }
  const font = entries(files.font, 'font');
  const fontPart = (key: string): unknown => font.find(([k]) => k === key)?.[1] ?? fail('font', `missing "${key}"`);
  const motion = entries(files.motion, 'motion');
  const motionPart = (key: string): unknown => motion.find(([k]) => k === key)?.[1] ?? fail('motion', `missing "${key}"`);
  const z = flat(files.z, 'z');
  for (const [k, v] of z) if (!/^\d+$/.test(v)) fail(`z.${k}`, 'expected an integer');
  return {
    colorGroups,
    tones,
    space: px(flat(files.space, 'space'), 'space'),
    radius: px(flat(files.radius, 'radius'), 'radius'),
    family: flat(fontPart('family'), 'font.family'),
    fontSize: px(flat(fontPart('size'), 'font.size'), 'font.size'),
    weight: flat(fontPart('weight'), 'font.weight'),
    lineHeight: flat(fontPart('line-height'), 'font.line-height'),
    tracking: flat(fontPart('tracking'), 'font.tracking'),
    shadow: themed(files.shadow, 'shadow'),
    size: px(flat(files.size, 'size'), 'size'),
    duration: flat(motionPart('duration'), 'motion.duration'),
    ease: flat(motionPart('ease'), 'motion.ease'),
    z,
    breakpoint: px(flat(files.breakpoint, 'breakpoint'), 'breakpoint'),
  };
}

// CSS variable names. Colours, fonts, shadows and the easing keep v1's names (--accent, --sans,
// --shadow-2, --ease) so v1 spells imported as plugins still resolve them.
const easeVar = (k: string): string => (k === 'ease' ? '--ease' : `--ease-${k}`);

function staticVars(m: Model): string[] {
  const lines: string[] = [];
  const add = (prefix: string, values: Flat): void => {
    for (const [k, v] of values) lines.push(`${prefix}${k}: ${v};`);
  };
  add('--tone-', m.tones.map(([k, ref]) => [k, `var(--${ref})`] as const));
  add('--space-', m.space);
  add('--radius-', m.radius);
  lines.push('--radius: var(--radius-lg);');
  add('--', m.family);
  add('--fs-', m.fontSize);
  add('--fw-', m.weight);
  add('--lh-', m.lineHeight);
  add('--tracking-', m.tracking);
  add('--size-', m.size);
  add('--dur-', m.duration);
  for (const [k, v] of m.ease) lines.push(`${easeVar(k)}: ${v};`);
  add('--z-', m.z);
  add('--bp-', m.breakpoint);
  return lines;
}

function themeVars(m: Model, theme: 'light' | 'dark'): string[] {
  const pick = (t: readonly [string, string, string]): string => (theme === 'light' ? t[1] : t[2]);
  const lines: string[] = [];
  for (const [, tokens] of m.colorGroups) for (const t of tokens) lines.push(`--${t[0]}: ${pick(t)};`);
  for (const t of m.shadow) lines.push(`--shadow-${t[0]}: ${pick(t)};`);
  lines.push(`color-scheme: ${theme};`);
  return lines;
}

function block(selector: string, lines: readonly string[], indent: string): string {
  const inner = lines.map((l) => `${indent}  ${l}`).join('\n');
  return `${indent}${selector} {\n${inner}\n${indent}}`;
}

function renderCss(m: Model): string {
  const light = themeVars(m, 'light');
  const dark = themeVars(m, 'dark');
  return [
    '/* Generated by packages/tokens/src/build.ts from tokens/*.json. Edit the JSON, then `npm run build`. */',
    '/* Dark comes from the OS (Theme: System) unless [data-theme] says otherwise. [data-theme] also works on',
    '   any element, so a light preview can sit in a dark page (and the gallery shows both side by side). */',
    '@layer tokens {',
    block(':root', [...staticVars(m), ...light], '  '),
    '  @media (prefers-color-scheme: dark) {',
    block(":root:not([data-theme='light'])", dark, '    '),
    '  }',
    block("[data-theme='dark']", dark, '  '),
    block("[data-theme='light']", light, '  '),
    '}',
    '',
  ].join('\n');
}

const union = (name: string, keys: readonly string[], doc: string): string =>
  `/** ${doc} */\nexport type ${name} = ${keys.map((k) => `'${k}'`).join(' | ')};`;

const keys = (values: Flat | Themed): string[] => values.map((v) => v[0]);

const pascal = (s: string): string => s.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());

function pxNumbers(values: Flat): number[] {
  const out = new Set<number>();
  for (const [, v] of values) for (const match of v.matchAll(PX)) out.add(Number(match[1]));
  return [...out].sort((a, b) => a - b);
}

function renderTs(m: Model): string {
  const colorUnions = m.colorGroups.map(([g, tokens]) => union(`${pascal(g)}Color`, keys(tokens), `Colour tokens in the ${g} group.`));
  const scale = pxNumbers([...m.space, ...m.radius, ...m.fontSize, ...m.size]);
  const bps = m.breakpoint.map(([k, v]) => `  ${/^[a-z]\w*$/.test(k) ? k : `'${k}'`}: ${parseFloat(v)},`);
  const split = m.breakpoint.find(([k]) => k === 'split') ?? fail('breakpoint', 'missing "split" (SPLIT_MIN_WIDTH)');
  const list = (name: string, values: readonly string[], type: string): string =>
    `export const ${name}: readonly ${type}[] = [${values.map((v) => `'${v}'`).join(', ')}];`;
  return [
    '// Generated by packages/tokens/src/build.ts from tokens/*.json. Edit the JSON, then `npm run build`.',
    '// A token that does not exist is a type error: props take these unions, never raw values.',
    '',
    ...colorUnions,
    `/** Every colour token. */\nexport type ColorToken = ${m.colorGroups.map(([g]) => `${pascal(g)}Color`).join(' | ')};`,
    union('Tone', keys(m.tones), 'What something means: pills, banners, buttons, text.'),
    union('Space', keys(m.space), 'The spacing scale (gap, padding, margin).'),
    union('Radius', keys(m.radius), 'Corner radii.'),
    union('FontFamily', keys(m.family), 'Font stacks.'),
    union('FontSize', keys(m.fontSize), 'The type scale.'),
    union('FontWeight', keys(m.weight), 'Font weights.'),
    union('LineHeight', keys(m.lineHeight), 'Line heights.'),
    union('Tracking', keys(m.tracking), 'Letter spacing.'),
    union('Shadow', keys(m.shadow), 'Shadows, for floating things only.'),
    union('Size', keys(m.size), 'Fixed sizes: controls, icons, avatars, caps on floating widths.'),
    union('Duration', keys(m.duration), 'Motion durations.'),
    union('Easing', keys(m.ease), 'Easing curves.'),
    union('ZLayer', keys(m.z), 'Stacking layers.'),
    union('Breakpoint', keys(m.breakpoint), 'Layout widths.'),
    '',
    list('TONES', keys(m.tones), 'Tone'),
    list('SPACES', keys(m.space), 'Space'),
    list('RADII', keys(m.radius), 'Radius'),
    list('FONT_SIZES', keys(m.fontSize), 'FontSize'),
    list('COLORS', m.colorGroups.flatMap(([, t]) => keys(t)), 'ColorToken'),
    '',
    '/** Layout widths in px, for JS (matchMedia, ResizeObserver). */',
    `export const BREAKPOINTS = {\n${bps.join('\n')}\n} as const;`,
    '/** At or over this width the list and the open task sit side by side; under it they stack. */',
    `export const SPLIT_MIN_WIDTH = ${parseFloat(split[1])};`,
    '/** Every px value in the scale (space, radius, font size, size). The kit\'s CSS may use no other. */',
    `export const PX_SCALE: readonly number[] = [${scale.join(', ')}];`,
    '/** Breakpoint px values: allowed in @media and @container conditions only. */',
    `export const BREAKPOINT_PX: readonly number[] = [${pxNumbers(m.breakpoint).join(', ')}];`,
    '',
  ].join('\n');
}

export function render(files: TokenFiles): Rendered {
  const m = model(files);
  return { css: renderCss(m), ts: renderTs(m) };
}
