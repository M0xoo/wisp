// Spirits: the crew's avatars. Each crew member is a little will-o'-the-wisp drawn from a short
// code, `shape.color.eyes.mouth.extra` ("flame.teal.visor.smile.antenna"), every part picked in the
// crew editor or rolled from a seed. DOM-free (an SVG string), so the page, the site and the tests
// draw them the same way. How they move lives in css/crew.css: they breathe and blink while idle,
// float and glance around while a job runs, hop while asking, and close their eyes while paused.

export const SPIRIT = {
  shape: ['flame', 'blob', 'ghost', 'drop', 'star', 'bean'],
  color: ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'],
  eyes: ['dots', 'happy', 'wide', 'sleepy', 'visor', 'wink', 'spark'],
  mouth: ['smile', 'grin', 'o', 'flat', 'cat', 'none'],
  extra: ['none', 'halo', 'antenna', 'crown', 'headphones', 'leaf', 'horns', 'beanie', 'bolt'],
};
export const PARTS = Object.keys(SPIRIT);
export const PART_LABEL = { shape: 'Body', color: 'Glow', eyes: 'Eyes', mouth: 'Mouth', extra: 'Extra' };
const CODE = /^[a-z]+(\.[a-z]+){4}$/;

// FNV-1a: the same name always rolls the same spirit.
function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}

// A whole spirit from a seed (a name, or Math.random() for the dice). Extras are rarer than none.
export function rollSpirit(seed = Math.random()) {
  let h = hash(seed);
  const pick = (list) => {
    const v = list[h % list.length];
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return v;
  };
  const p = { shape: pick(SPIRIT.shape), color: pick(SPIRIT.color), eyes: pick(SPIRIT.eyes.filter((e) => e !== 'sleepy')), mouth: pick(SPIRIT.mouth), extra: h % 3 ? pick(SPIRIT.extra) : 'none' };
  return spiritCode(p);
}

export const isSpirit = (code) => CODE.test(String(code || ''));
export const spiritCode = (p) => PARTS.map((k) => (SPIRIT[k].includes(p[k]) ? p[k] : SPIRIT[k][0])).join('.');

// code → { shape, color, eyes, mouth, extra }; a part it doesn't know falls back to the first.
export function parseSpirit(code, seed = '') {
  const src = isSpirit(code) ? code : rollSpirit(seed || code || 'wisp');
  const bits = src.split('.');
  return Object.fromEntries(PARTS.map((k, i) => [k, SPIRIT[k].includes(bits[i]) ? bits[i] : SPIRIT[k][0]]));
}

// Where each body's head starts (its top), so extras sit on it.
const TOP = { flame: 6, blob: 12, ghost: 13, drop: 8, star: 10, bean: 12 };

function starPath(cx, cy, r1, r2) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 ? r2 : r1;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

const BODY = {
  flame: 'M31 4c2.5 8.5 9.5 11.5 13.5 18 1.8-2.8 2.2-6 1.6-9.5C52 18 55 25.5 55 33.5 55 47 44.5 57 32 57S9 47 9 33.5c0-7 3-12.5 7.5-16.5-.2 4.2.9 7.3 3 9.6C20.7 17 25 10 31 4z',
  blob: 'M32 12c13.5 0 21.5 9 21.5 22.5S44.5 57 32 57 10.5 48 10.5 34.5 18.5 12 32 12z',
  ghost: 'M13.5 34C13.5 21 22 13 32 13s18.5 8 18.5 21v22l-4.6-4-4.6 4-4.6-4-4.7 4-4.6-4-4.6 4-4.6-4-4.7 4z',
  drop: 'M32 8c8.5 12.5 19.5 22 19.5 33.5a19.5 19.5 0 0 1-39 0C12.5 30 23.5 20.5 32 8z',
  star: starPath(32, 36, 25, 14),
  bean: 'M21 14.5c9.5-4.5 23 0 27 10.5 5 12.5-1 28-14.5 31.5C21 59.5 11 51 11 38.5c0-10.5 2-20 10-24z',
};

const INK = 'fill="var(--spirit-eye)"';
const STROKE = 'fill="none" stroke="var(--spirit-eye)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
// Trims stick out past the body, onto the page: their own colour, so they show in dark mode too.
const TRIM = 'fill="none" stroke="var(--spirit-trim)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';

function eyes(kind, sleep) {
  if (sleep) return `<path d="M21.5 35q3.5 3.2 7 0M35.5 35q3.5 3.2 7 0" ${STROKE}/>`;
  switch (kind) {
    case 'happy':
      return `<path d="M21.5 36.5q3.5-4.5 7 0M35.5 36.5q3.5-4.5 7 0" ${STROKE}/>`;
    case 'wide':
      return `<circle cx="25" cy="34.5" r="4.6" fill="var(--spirit-shine)"/><circle cx="39" cy="34.5" r="4.6" fill="var(--spirit-shine)"/><g class="sp-pupil"><circle cx="25.6" cy="35" r="2.3" ${INK}/><circle cx="39.6" cy="35" r="2.3" ${INK}/></g>`;
    case 'sleepy':
      return `<path d="M21.5 34.5h7M35.5 34.5h7" ${STROKE}/><path d="M22.5 35.5q2.5 2.4 5 0M36.5 35.5q2.5 2.4 5 0" ${STROKE} stroke-width="1.8"/>`;
    case 'visor':
      return `<rect x="17.5" y="30.5" width="29" height="9" rx="4.5" ${INK}/><rect class="sp-scan" x="20" y="33.6" width="7" height="2.8" rx="1.4" fill="var(--sp-a)"/>`;
    case 'wink':
      return `<circle cx="25" cy="35" r="3.1" ${INK}/><path d="M35.5 36q3.5-4 7 0" ${STROKE}/>`;
    case 'spark':
      return `<path d="M25 30.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3zM39 30.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z" ${INK}/>`;
    default:
      return `<g class="sp-pupil"><circle cx="25" cy="35" r="3.1" ${INK}/><circle cx="39" cy="35" r="3.1" ${INK}/></g>`;
  }
}

function mouth(kind) {
  switch (kind) {
    case 'grin':
      return `<path d="M27 42.5h10q-.8 5.5-5 5.5t-5-5.5z" ${INK}/>`;
    case 'o':
      return `<circle cx="32" cy="44.5" r="2.3" ${INK}/>`;
    case 'flat':
      return `<path d="M29 44.5h6" ${STROKE}/>`;
    case 'cat':
      return `<path d="M27 43q2.5 3 5 0 2.5 3 5 0" ${STROKE} stroke-width="2"/>`;
    case 'none':
      return '';
    default:
      return `<path d="M28 43q4 4 8 0" ${STROKE}/>`;
  }
}

function extra(kind, t) {
  const gold = 'fill="var(--spirit-gold)"';
  switch (kind) {
    case 'halo':
      return `<ellipse class="sp-halo" cx="32" cy="${t - 4}" rx="10.5" ry="3.2" fill="none" stroke="var(--spirit-gold)" stroke-width="2.4"/>`;
    case 'antenna':
      return `<path d="M32 ${t + 1}V${t - 7}" ${TRIM} stroke-width="2"/><circle class="sp-beacon" cx="32" cy="${t - 9}" r="3" fill="var(--sp-a)" stroke="var(--spirit-trim)" stroke-width="1.6"/>`;
    case 'crown':
      return `<path d="M22.5 ${t + 3}l2-9.5 4.5 5.5 3-8 3 8 4.5-5.5 2 9.5z" ${gold} stroke="var(--spirit-trim)" stroke-width="1.2" stroke-linejoin="round"/>`;
    case 'headphones':
      return `<path d="M14.5 36C14.5 ${t - 5} 49.5 ${t - 5} 49.5 36" fill="none" stroke="var(--spirit-trim)" stroke-width="3" stroke-linecap="round"/><rect x="10" y="30" width="8" height="12" rx="3.5" fill="var(--spirit-trim)"/><rect x="46" y="30" width="8" height="12" rx="3.5" fill="var(--spirit-trim)"/>`;
    case 'leaf':
      return `<path d="M32 ${t + 2}q0-5 2-8" ${TRIM} stroke-width="2"/><path class="sp-leaf" d="M34 ${t - 6}c3-6 10-6 12-4-2 5-8 7-12 4z" fill="var(--spirit-leaf)" stroke="var(--spirit-trim)" stroke-width="1.2"/>`;
    case 'horns':
      return `<path d="M22 ${t + 6}c-5-3-6-9-3-13 1 4 3 6 7 8zM42 ${t + 6}c5-3 6-9 3-13-1 4-3 6-7 8z" fill="var(--sp-b)" stroke="var(--spirit-trim)" stroke-width="1.3" stroke-linejoin="round"/>`;
    case 'beanie':
      return `<path d="M16 ${t + 11}c0-11 7-15 16-15s16 4 16 15z" fill="var(--spirit-trim)"/><path d="M15 ${t + 11}h34" stroke="var(--spirit-trim)" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="${t - 5}" r="3.6" fill="var(--spirit-shine)" stroke="var(--spirit-trim)" stroke-width="1.2"/>`;
    case 'bolt':
      return `<path class="sp-bolt" d="M47 ${t - 6}l-6 9h4.5l-2.5 7 7-10h-4.5z" ${gold} stroke="var(--spirit-trim)" stroke-width="1.1" stroke-linejoin="round"/>`;
    default:
      return '';
  }
}

// Extras that grow out of the head go behind the body; the rest sit on it.
const BEHIND = new Set(['antenna', 'leaf', 'horns']);

// The spirit as an <svg>. state: idle | live | asks | sleep (its classes animate it; sleep closes
// its eyes). small: a dot-sized spirit (a card's), without its extra.
export function spiritSvg(code, { state = 'idle', seed = '', small = false, label = '' } = {}) {
  const p = parseSpirit(code, seed);
  // The same spirit draws the same markup (a repaint that compares HTML leaves it alone): its glow
  // is one of spiritDefs()'s gradients, shared by every spirit of its colour.
  const id = `sp-grad-${p.color}`;
  const t = TOP[p.shape];
  const blink = (hash(code || seed) % 50) / 10; // they don't all blink together
  return `<svg class="spirit c-${p.color} st-${state} sh-${p.shape}" viewBox="0 0 64 64" style="--blink:${blink}s" ${label ? `role="img" aria-label="${label.replace(/[<>&"]/g, '')}"` : 'aria-hidden="true"'}>
    <g class="sp-float">
      ${!small && BEHIND.has(p.extra) ? extra(p.extra, t) : ''}
      <path class="sp-body" d="${BODY[p.shape]}" fill="url(#${id})"/>
      <ellipse class="sp-shine" cx="24" cy="24" rx="5" ry="3" transform="rotate(-30 24 24)" fill="var(--spirit-shine)" opacity="0.45"/>
      <ellipse cx="20" cy="41" rx="3" ry="1.8" fill="var(--spirit-blush)" opacity="0.55"/><ellipse cx="44" cy="41" rx="3" ry="1.8" fill="var(--spirit-blush)" opacity="0.55"/>
      <g class="sp-eyes">${eyes(p.eyes, state === 'sleep')}</g>
      ${small ? '' : mouth(p.mouth)}
      ${!small && !BEHIND.has(p.extra) ? extra(p.extra, t) : ''}
    </g>
  </svg>`;
}

// The glows, one gradient per colour, for the page to hold once (an <svg> that isn't display: none,
// or Chrome won't paint gradients from it).
export const spiritDefs = () =>
  `<svg class="spirit-defs" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs>${SPIRIT.color
    .map((c) => `<radialGradient id="sp-grad-${c}" class="spirit-grad c-${c}" cx="38%" cy="32%" r="72%"><stop offset="0" style="stop-color:var(--sp-a)"/><stop offset="1" style="stop-color:var(--sp-b)"/></radialGradient>`)
    .join('')}</defs></svg>`;

// What an avatar is: a spirit code, an emoji someone picked, or nothing (rolled from the name).
export const isEmojiAvatar = (a) => !!a && !isSpirit(a);
