// What a framed web page may be (v1 web/js/preview-spec.js): the size it's shown at, the URL it
// loads and what its sandbox allows. Shared by the preview frame, an app launched in wisp and a
// pane. Pure.

import type { IconName } from '@wisp/ui';

export type DeviceId = 'mobile' | 'tablet' | 'desktop';
export interface Device {
  readonly w: number;
  readonly h: number;
  readonly label: string; // i18n key
  readonly icon: IconName;
}

/** The sizes a preview can take by name: CSS pixels, portrait for phone and tablet. */
export const DEVICES: Readonly<Record<DeviceId, Device>> = {
  mobile: { w: 390, h: 844, label: 'stuff.preview.phone', icon: 'phone' },
  tablet: { w: 820, h: 1180, label: 'stuff.preview.tablet', icon: 'tablet' },
  desktop: { w: 1440, h: 900, label: 'stuff.preview.desktop', icon: 'laptop' },
};
const ALIASES: Readonly<Record<string, DeviceId>> = { phone: 'mobile', iphone: 'mobile', android: 'mobile', tab: 'tablet', tablette: 'tablet', ipad: 'tablet', laptop: 'desktop', pc: 'desktop', computer: 'desktop', web: 'desktop' };
/** Any WxH asked for is kept within this, each side. */
export const PREVIEW_SIZE = [240, 3840] as const;

export interface PreviewSize {
  device: DeviceId | 'custom';
  w: number;
  h: number;
}

const clamp = (n: number): number => Math.min(Math.max(Math.round(n), PREVIEW_SIZE[0]), PREVIEW_SIZE[1]);
const isDevice = (s: string): s is DeviceId => Object.hasOwn(DEVICES, s);

/** A named device, an alias, "1280x720", or width/height numbers; desktop when nothing fits. */
export function previewSize(b: { device?: unknown; size?: unknown; width?: unknown; height?: unknown } = {}): PreviewSize {
  const raw = String(b.device ?? b.size ?? '').trim().toLowerCase();
  const name: DeviceId | undefined = isDevice(raw) ? raw : ALIASES[raw];
  const wh = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(raw);
  const w = Number(b.width);
  const h = Number(b.height);
  if (wh) return { device: 'custom', w: clamp(Number(wh[1])), h: clamp(Number(wh[2])) };
  if (w > 0 && h > 0) return { device: 'custom', w: clamp(w), h: clamp(h) };
  const d = DEVICES[name ?? 'desktop'];
  if (w > 0) return { device: 'custom', w: clamp(w), h: d.h };
  return { device: name ?? 'desktop', w: d.w, h: d.h };
}

/** The page to load: http(s) only, no user:password@. A bare localhost gets http://. */
export function previewUrl(raw: unknown): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

/** The i18n key of why a preview can't be shown, or ''. */
export function previewProblem(b: { url?: unknown } = {}): string {
  if (!b.url) return 'stuff.preview.noUrl';
  if (!previewUrl(b.url)) return 'stuff.preview.badUrl';
  return '';
}

/**
 * The frame's sandbox. Scripts and forms run, links may open a new tab; it never navigates wisp or
 * opens dialogs over it. A page on wisp's own origin would share its storage and could lift its
 * own sandbox, so it gets an opaque origin instead.
 */
export function previewSandbox(url: string, wispOrigin = ''): string {
  const base = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }
  return origin && origin !== wispOrigin && origin !== 'null' ? `${base} allow-same-origin` : base;
}

/** localhost on the agent's computer isn't localhost where the page is read (the phone, a grid). */
export function isLoopback(url: string): boolean {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** On a wisp Grid, the box's localhost shows at its preview address; null when it isn't loopback or there's nowhere. */
export function boxUrl(url: string, template: string | null | undefined): string | null {
  if (!template || !isLoopback(url)) return null;
  const u = new URL(url);
  return `${String(template).replace('{port}', u.port || '80').replace(/\/+$/, '')}${u.pathname}${u.search}${u.hash}`;
}

/** "localhost:3000/settings" for an address bar: no scheme, no trailing slash. */
export const shortUrl = (url: string): string => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');

/**
 * Where a page wisp serves on this computer opens from here: as it is when you're on this computer,
 * else at the grid's preview address, else nowhere (null: it says where it runs instead).
 */
export function reachable(url: string, page: string, template: string | null | undefined): string | null {
  return isLoopback(page) ? url : boxUrl(url, template);
}

/** How far a w×h page scales down to fit `availW` × `maxH` (never up), and the label under it. */
export function fitScale(size: { w: number; h: number }, availW: number, maxH: number): number {
  if (availW <= 0) return 1;
  return Math.max(0.1, Math.min(1, availW / size.w, maxH / size.h));
}
