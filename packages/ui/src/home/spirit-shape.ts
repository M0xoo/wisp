// Spirits: the crew's avatars (v1 web/js/spirit.js). Each is a little will-o'-the-wisp drawn from a
// short code, `shape.color.eyes.mouth.extra` ("flame.teal.visor.smile.antenna"), every part picked in
// the crew editor or rolled from a seed. The geometry is data here; Spirit.tsx draws it as SVG
// elements (no markup strings), and css/home.css animates it by state.

export const SPIRIT = {
  shape: ['flame', 'blob', 'ghost', 'drop', 'star', 'bean'],
  color: ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'],
  eyes: ['dots', 'happy', 'wide', 'sleepy', 'visor', 'wink', 'spark'],
  mouth: ['smile', 'grin', 'o', 'flat', 'cat', 'none'],
  extra: ['none', 'halo', 'antenna', 'crown', 'headphones', 'leaf', 'horns', 'beanie', 'bolt'],
} as const;

export type SpiritPart = keyof typeof SPIRIT;
export type SpiritParts = { readonly [K in SpiritPart]: (typeof SPIRIT)[K][number] };
export const PARTS: readonly SpiritPart[] = ['shape', 'color', 'eyes', 'mouth', 'extra'];
const CODE = /^[a-z]+(\.[a-z]+){4}$/;

/** FNV-1a: the same name always rolls the same spirit. */
export function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

export const isSpirit = (code: string | undefined): boolean => CODE.test(code ?? '');

function pickFrom<K extends SpiritPart>(k: K, v: string | undefined): SpiritParts[K] {
  const list = SPIRIT[k] as readonly string[];
  return (v !== undefined && list.includes(v) ? v : list[0]) as SpiritParts[K];
}

export const spiritCode = (p: Partial<Record<SpiritPart, string>>): string => PARTS.map((k) => pickFrom(k, p[k])).join('.');

/** A whole spirit from a seed (a name). Extras are rarer than none; a rolled one is never sleepy. */
export function rollSpirit(seed: string): string {
  let h = hash(seed);
  const pick = (list: readonly string[]): string => {
    const v = list[h % list.length] ?? list[0] ?? '';
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return v;
  };
  const shape = pick(SPIRIT.shape);
  const color = pick(SPIRIT.color);
  const eyes = pick(SPIRIT.eyes.filter((e) => e !== 'sleepy'));
  const mouth = pick(SPIRIT.mouth);
  const extra = h % 3 ? pick(SPIRIT.extra) : 'none';
  return spiritCode({ shape, color, eyes, mouth, extra });
}

/** code → its parts; a part it doesn't know falls back to the first. Not a code: rolled from the seed. */
export function parseSpirit(code: string | undefined, seed = ''): SpiritParts {
  const src = code && isSpirit(code) ? code : rollSpirit(seed || code || 'wisp');
  const bits = src.split('.');
  return { shape: pickFrom('shape', bits[0]), color: pickFrom('color', bits[1]), eyes: pickFrom('eyes', bits[2]), mouth: pickFrom('mouth', bits[3]), extra: pickFrom('extra', bits[4]) };
}

/** Where each body's head starts (its top), so extras sit on it. */
export const TOP: Readonly<Record<SpiritParts['shape'], number>> = { flame: 6, blob: 12, ghost: 13, drop: 8, star: 10, bean: 12 };

function starPath(cx: number, cy: number, r1: number, r2: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 ? r2 : r1;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

export const BODY: Readonly<Record<SpiritParts['shape'], string>> = {
  flame: 'M31 4c2.5 8.5 9.5 11.5 13.5 18 1.8-2.8 2.2-6 1.6-9.5C52 18 55 25.5 55 33.5 55 47 44.5 57 32 57S9 47 9 33.5c0-7 3-12.5 7.5-16.5-.2 4.2.9 7.3 3 9.6C20.7 17 25 10 31 4z',
  blob: 'M32 12c13.5 0 21.5 9 21.5 22.5S44.5 57 32 57 10.5 48 10.5 34.5 18.5 12 32 12z',
  ghost: 'M13.5 34C13.5 21 22 13 32 13s18.5 8 18.5 21v22l-4.6-4-4.6 4-4.6-4-4.7 4-4.6-4-4.6 4-4.6-4-4.7 4z',
  drop: 'M32 8c8.5 12.5 19.5 22 19.5 33.5a19.5 19.5 0 0 1-39 0C12.5 30 23.5 20.5 32 8z',
  star: starPath(32, 36, 25, 14),
  bean: 'M21 14.5c9.5-4.5 23 0 27 10.5 5 12.5-1 28-14.5 31.5C21 59.5 11 51 11 38.5c0-10.5 2-20 10-24z',
};

/** Extras that grow out of the head go behind the body; the rest sit on it. */
export const BEHIND: ReadonlySet<string> = new Set(['antenna', 'leaf', 'horns']);

/** A stagger so a crew doesn't blink together. */
export const blinkDelay = (seed: string): number => (hash(seed) % 50) / 10;
