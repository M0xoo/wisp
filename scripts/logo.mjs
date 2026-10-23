#!/usr/bin/env node
// Draws wisp's logo, a handwritten "w" in one calligraphic stroke that ends in the orb, and writes
// every vector copy of it: the app icon (docs, web, Electron, Grid), the Play store art, the
// Android launcher layers, and prints the small brand mark for the pages' CSS.
// The PNGs (favicons, apple-touch-icon, icon.png, store icon, og images) are rendered from these
// SVGs in Chrome; rerun this, then re-render them when the shape changes.
//
//   node scripts/logo.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f = (n) => +n.toFixed(1);

// The stroke's spine as cubic beziers, in the 1024 icon's space.
const START = [262, 486];
const SEGS = [
  [[300, 470], [318, 560], [348, 640]],
  [[366, 690], [404, 700], [432, 640]],
  [[456, 590], [484, 480], [512, 480]],
  [[540, 480], [560, 590], [586, 640]],
  [[614, 700], [656, 690], [676, 630]],
  [[700, 560], [712, 470], [672, 452]],
  [[640, 440], [636, 500], [700, 500]],
  [[740, 500], [770, 480], [790, 456]],
];
const ORB = { c: [808, 438], r: 34 };
// Thin at both ends, full in the middle, like a broad nib.
const width = (s) => 22 + 58 * Math.sin(Math.PI * Math.min(1, s * 1.15));

function sample(n) {
  const pts = [START];
  let p0 = START;
  for (const [c1, c2, p3] of SEGS) {
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push([0, 1].map((k) => u*u*u*p0[k] + 3*u*u*t*c1[k] + 3*u*t*t*c2[k] + t*t*t*p3[k]));
    }
    p0 = p3;
  }
  return pts;
}

// The stroke as a filled outline with round caps, mapped through tf = { x, y, k }: p -> p * k + (x, y).
// Where the curve turns tighter than the stroke is wide the outline folds over itself and leaves a
// notch, so those spots also get discs (`dots`, painted as a second path on top).
function glyph(tf, n = 40) {
  const pts = sample(n);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = len.at(-1);
  const frame = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
    return { p, t: [dx / d, dy / d], n: [-dy / d, dx / d], r: width(len[i] / L) / 2 };
  });
  const at = ({ p, t, n, r }, cn, ct) => [p[0] + r * (n[0] * cn + t[0] * ct), p[1] + r * (n[1] * cn + t[1] * ct)];
  const cap = (fr, sign) => Array.from({ length: 9 }, (_, j) => j * Math.PI / 8).map((a) => at(fr, sign * Math.cos(a), sign * Math.sin(a)));
  const ring = [
    ...frame.map((fr) => at(fr, 1, 0)),
    ...cap(frame.at(-1), 1).slice(1, -1),
    ...frame.slice().reverse().map((fr) => at(fr, -1, 0)),
    ...cap(frame[0], -1).slice(1, -1),
  ];
  const X = (v) => f(v * tf.k + tf.x), Y = (v) => f(v * tf.k + tf.y), K = (v) => f(v * tf.k);
  const tight = frame.filter((fr, i) => {
    if (i < 2 || i > frame.length - 3) return false;
    const a = frame[i - 2].t, b = frame[i + 2].t;
    const turn = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
    return turn > 0 && (len[i + 2] - len[i - 2]) / turn < fr.r * 1.25;
  });
  return {
    outline: 'M' + ring.map((q) => `${X(q[0])},${Y(q[1])}`).join('L') + 'Z',
    dots: tight.map(({ p, r }) => `M${X(p[0] - r)},${Y(p[1])}a${K(r)},${K(r)} 0 1 0 ${K(2 * r)},0a${K(r)},${K(r)} 0 1 0 ${K(-2 * r)},0`).join(''),
  };
}
const orb = (tf) => ({ cx: f(ORB.c[0] * tf.k + tf.x), cy: f(ORB.c[1] * tf.k + tf.y), r: f(ORB.r * tf.k) });

// The drawing's box (stroke and orb), so each copy can centre it.
const BOX = (() => {
  const xs = [], ys = [];
  for (const p of sample(40)) { xs.push(p[0]); ys.push(p[1]); }
  const pad = 40; // the widest half-stroke
  return { x0: Math.min(...xs) - 12, x1: ORB.c[0] + ORB.r, y0: Math.min(ORB.c[1] - ORB.r, Math.min(...ys) - pad), y1: Math.max(...ys) + pad };
})();
// Fit the drawing to `w` wide, centred on (cx, cy).
function fit(w, cx, cy) {
  const k = w / (BOX.x1 - BOX.x0);
  return { k, x: cx - (BOX.x0 + BOX.x1) / 2 * k, y: cy - (BOX.y0 + BOX.y1) / 2 * k };
}

const ORB_GRAD = '<radialGradient id="orb" cx="36%" cy="32%" r="68%"><stop offset="0" stop-color="#fff"/><stop offset=".16" stop-color="#d9fff6"/><stop offset=".38" stop-color="#2fd0b4"/><stop offset=".78" stop-color="#6a5cff"/><stop offset="1" stop-color="#4b3fe0"/></radialGradient>';
const DEFS = (tf) => {
  const a = f(BOX.x0 * tf.k + tf.x), b = f(BOX.x1 * tf.k + tf.x);
  return `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1c22"/><stop offset="1" stop-color="#0e0e10"/></linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#6a5cff" stop-opacity=".55"/><stop offset="1" stop-color="#6a5cff" stop-opacity="0"/></radialGradient>
    <linearGradient id="ink" x1="${a}" y1="0" x2="${b}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5fe6cf"/><stop offset=".55" stop-color="#2fd0b4"/><stop offset="1" stop-color="#8f84ff"/></linearGradient>
    ${ORB_GRAD}`;
};
const art = (tf) => {
  const o = orb(tf), g = glyph(tf);
  return `<path d="${g.outline}" fill="url(#ink)"/>
  <path d="${g.dots}" fill="url(#ink)"/>
  <circle cx="${o.cx}" cy="${o.cy}" r="${o.r}" fill="url(#orb)"/>`;
};

function icon({ bleed = false } = {}) {
  const tf = fit(640, 512, 512);
  const head = bleed
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="100 100 824 824">
  <!-- docs/assets/icon.svg, full bleed: Play rounds the corners itself. -->`
    : '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">';
  return `${head}
  <defs>
    ${DEFS(tf)}
  </defs>
  <rect x="100" y="100" width="824" height="824"${bleed ? '' : ' rx="190"'} fill="url(#bg)"/>
  <circle cx="512" cy="540" r="330" fill="url(#glow)" opacity=".6"/>
  ${art(tf)}
</svg>
`;
}

function featureGraphic() {
  const tf = fit(330, 250, 250);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <!-- Play's feature graphic. Keep text clear of the centre: Play may overlay a play button there. -->
  <defs>
    ${DEFS(tf)}
  </defs>
  <rect width="1024" height="500" fill="url(#bg)"/>
  <circle cx="250" cy="250" r="230" fill="url(#glow)"/>
  ${art(tf)}
  <g font-family="-apple-system, 'SF Pro Display', Inter, 'Segoe UI', system-ui, sans-serif" fill="#f4f4f2">
    <text x="470" y="232" font-size="104" font-weight="700" letter-spacing="-4">wisp</text>
    <text x="474" y="290" font-size="30" fill="#b9b8c2" letter-spacing="-.4">Your coding agents, in your pocket.</text>
    <text x="474" y="330" font-size="22" fill="#8a8994">Claude Code · Codex · opencode · Cursor</text>
  </g>
</svg>
`;
}

// Android's adaptive icon: 108dp, with what matters inside the 66dp safe circle.
function androidForeground() {
  const tf = fit(62, 54, 54), o = orb(tf);
  const a = f(BOX.x0 * tf.k + tf.x), b = f(BOX.x1 * tf.k + tf.x);
  return `<!-- wisp's logo (scripts/logo.mjs), kept inside the adaptive icon's 66dp safe circle. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- glow -->
    <path android:pathData="M16,56a38,38 0,1 0,76 0a38,38 0,1 0,-76 0z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="radial"
                android:centerX="54"
                android:centerY="56"
                android:gradientRadius="38">
                <item android:offset="0" android:color="#596A5CFF" />
                <item android:offset="1" android:color="#006A5CFF" />
            </gradient>
        </aapt:attr>
    </path>
    <!-- the w -->
${Object.values(glyph(tf, 24)).map((d) => `    <path android:pathData="${d}">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="${a}"
                android:startY="0"
                android:endX="${b}"
                android:endY="0">
                <item android:offset="0" android:color="#FF5FE6CF" />
                <item android:offset="0.55" android:color="#FF2FD0B4" />
                <item android:offset="1" android:color="#FF8F84FF" />
            </gradient>
        </aapt:attr>
    </path>`).join('\n')}
    <!-- orb -->
    <path android:pathData="M${f(o.cx - o.r)},${o.cy}a${o.r},${o.r} 0,1 0,${f(o.r * 2)} 0a${o.r},${o.r} 0,1 0,${f(-o.r * 2)} 0z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="radial"
                android:centerX="${f(o.cx - o.r * 0.28)}"
                android:centerY="${f(o.cy - o.r * 0.36)}"
                android:gradientRadius="${f(o.r * 1.36)}">
                <item android:offset="0" android:color="#FFFFFFFF" />
                <item android:offset="0.16" android:color="#FFD9FFF6" />
                <item android:offset="0.38" android:color="#FF2FD0B4" />
                <item android:offset="0.78" android:color="#FF6A5CFF" />
                <item android:offset="1" android:color="#FF4B3FE0" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;
}

function androidMono(comment, size, w, fill = '#FFFFFFFF') {
  const tf = fit(w, size / 2, size / 2), o = orb(tf);
  return `${comment}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${size}dp"
    android:height="${size}dp"
    android:viewportWidth="${size}"
    android:viewportHeight="${size}">
${[...Object.values(glyph(tf, size > 30 ? 24 : 12)), `M${f(o.cx - o.r)},${o.cy}a${o.r},${o.r} 0,1 0,${f(o.r * 2)} 0a${o.r},${o.r} 0,1 0,${f(-o.r * 2)} 0z`].map((d) => `    <path
        android:fillColor="${fill}"
        android:pathData="${d}" />`).join('\n')}
</vector>
`;
}

// The small mark beside the word "wisp", in one colour: pages use it as a CSS mask and paint it
// from the text colour into the accent, so the orb at the end of the stroke picks up the accent.
function mark() {
  const h = 24, w = Math.round(h * (BOX.x1 - BOX.x0) / (BOX.y1 - BOX.y0));
  const tf = fit(w, w / 2, h / 2), o = orb(tf);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${Object.values(glyph(tf, 12)).map((d) => `<path d="${d}"/>`).join('')}<circle cx="${o.cx}" cy="${o.cy}" r="${o.r}"/></svg>`;
}

const write = (file, text) => { fs.writeFileSync(path.join(ROOT, file), text); console.log('wrote', file); };
const RES = 'mobile/android/app/src/main/res/drawable';
for (const file of ['docs/assets/icon.svg', 'web/favicon.svg', 'electron/icon.svg', 'grid/assets/icon.svg']) write(file, icon());
write('mobile/store/icon.svg', icon({ bleed: true }));
write('mobile/store/feature-graphic.svg', featureGraphic());
write(`${RES}/ic_launcher_foreground.xml`, androidForeground());
write(`${RES}/ic_launcher_monochrome.xml`, androidMono('<!-- Android 13+ themed icons: the logo as one colour (the launcher tints it). -->', 108, 62));
write(`${RES}/ic_stat_wisp.xml`, androidMono('<!-- The status bar icon: the logo, white on transparent as Android wants. -->', 24, 22));
// Pasted as the mask in web/css/base.css (.orb.tiny), mobile/www/app.css (.orb), docs/style.css and grid/pages.js (.mark).
console.log(`\nmark: url("data:image/svg+xml,${encodeURIComponent(mark()).replace(/%20/g, ' ').replace(/%2C/g, ',').replace(/%3D/g, '=').replace(/%2F/g, '/').replace(/%3A/g, ':')}")`);
