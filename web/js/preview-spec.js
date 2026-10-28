// The `preview` block: a web page the agent points at, shown live in the answer at the screen size
// it picked. What size, what URL and what the frame may do, worked out here (DOM-free: the Node
// tests use it). The frame itself is drawn by web/js/preview-frame.js.

// The sizes a preview can take by name: CSS pixels, portrait for phone and tablet.
export const DEVICES = {
  mobile: { w: 390, h: 844, label: 'Phone', icon: 'phone' },
  tablet: { w: 820, h: 1180, label: 'Tablet', icon: 'tablet' },
  desktop: { w: 1440, h: 900, label: 'Desktop', icon: 'laptop' },
};
const ALIASES = { phone: 'mobile', iphone: 'mobile', android: 'mobile', tab: 'tablet', tablette: 'tablet', ipad: 'tablet', laptop: 'desktop', pc: 'desktop', computer: 'desktop', web: 'desktop' };
// Any WxH the agent asks for is kept within this, each side.
export const PREVIEW_SIZE = [240, 3840];

const clamp = (n) => Math.min(Math.max(Math.round(n), PREVIEW_SIZE[0]), PREVIEW_SIZE[1]);

// { device: 'mobile' | 'tablet' | 'desktop' | 'custom', w, h } from the block: a named device, a
// "1280x720" string (in device or size), or width / height numbers. Desktop when nothing fits.
export function previewSize(b = {}) {
  const raw = String(b.device ?? b.size ?? '').trim().toLowerCase();
  const name = DEVICES[raw] ? raw : ALIASES[raw];
  const wh = raw.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/);
  const w = Number(b.width);
  const h = Number(b.height);
  if (wh) return { device: 'custom', w: clamp(+wh[1]), h: clamp(+wh[2]) };
  if (w > 0 && h > 0) return { device: 'custom', w: clamp(w), h: clamp(h) };
  const d = DEVICES[name || 'desktop'];
  // Only a width: the named device's (or desktop's) height, at that width.
  if (w > 0) return { device: 'custom', w: clamp(w), h: d.h };
  return { device: name || 'desktop', w: d.w, h: d.h };
}

// The page to load: http(s) only, no user:password@. A bare host ("localhost:3000") gets http://.
export function previewUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

// Why a preview can't be shown, or ''.
export function previewProblem(b = {}) {
  if (!b.url) return 'It has no url.';
  if (!previewUrl(b.url)) return 'Only http:// and https:// pages can be shown.';
  return '';
}

// The frame's sandbox. Scripts and forms run so the page works, links may open a new tab, and it
// can never navigate wisp, open dialogs over it, or reach it. A page on wisp's own origin would
// share its storage and could lift its own sandbox, so it gets an opaque origin instead.
export function previewSandbox(url, wispOrigin = '') {
  const base = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {}
  return origin && origin !== wispOrigin ? `${base} allow-same-origin` : base;
}

// localhost on the agent's computer isn't localhost where the page is read (the phone, a grid).
export const isLoopback = (url) => {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

// On a wisp Grid, localhost in the box shows at its preview address (server/http/preview.js):
// "http://localhost:5173/a?b" with "https://p{port}--ada.grid.example" → "https://p5173--ada.grid.example/a?b".
// null when it isn't a loopback page or there's nowhere to show it.
export function boxUrl(url, template) {
  if (!template || !isLoopback(url)) return null;
  const u = new URL(url);
  return `${String(template).replace('{port}', u.port || '80').replace(/\/+$/, '')}${u.pathname}${u.search}${u.hash}`;
}

// "localhost:3000/settings" for the address bar: no scheme, no trailing slash.
export const shortUrl = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
