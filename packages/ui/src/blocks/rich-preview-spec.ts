// The `preview` block's size, URL and sandbox (v1 web/js/preview-spec.js), DOM-free.
import { str } from './read.ts';

export type DeviceId = 'mobile' | 'tablet' | 'desktop';
export type PreviewDevice = DeviceId | 'custom';

export interface Device {
  readonly w: number;
  readonly h: number;
}

/** The sizes a preview can take by name: CSS pixels, portrait for phone and tablet. */
export const DEVICES: Readonly<Record<DeviceId, Device>> = {
  mobile: { w: 390, h: 844 },
  tablet: { w: 820, h: 1180 },
  desktop: { w: 1440, h: 900 },
};
export const DEVICE_IDS: readonly DeviceId[] = ['mobile', 'tablet', 'desktop'];

const ALIASES: Readonly<Record<string, DeviceId>> = {
  mobile: 'mobile', phone: 'mobile', iphone: 'mobile', android: 'mobile',
  tablet: 'tablet', tab: 'tablet', tablette: 'tablet', ipad: 'tablet',
  desktop: 'desktop', laptop: 'desktop', pc: 'desktop', computer: 'desktop', web: 'desktop',
};

/** Any WxH the agent asks for is kept within this, each side. */
export const PREVIEW_SIZE: readonly [number, number] = [240, 3840];
/** px around the screen for each frame: [left + right, top + bottom] (bezel, or a window's title bar). */
export const BEZEL: Readonly<Record<PreviewDevice, readonly [number, number]>> = { mobile: [20, 20], tablet: [28, 28], desktop: [2, 33], custom: [2, 33] };

const clamp = (n: number): number => Math.min(Math.max(Math.round(n), PREVIEW_SIZE[0]), PREVIEW_SIZE[1]);

export interface PreviewSize {
  readonly device: PreviewDevice;
  readonly w: number;
  readonly h: number;
}

/** A named device, a "1280x720" string (in device or size), or width / height numbers. Desktop when nothing fits. */
export function previewSize(b: Readonly<Record<string, unknown>>): PreviewSize {
  const raw = (str(b['device']) || str(b['size'])).trim().toLowerCase();
  const name = Object.hasOwn(ALIASES, raw) ? ALIASES[raw] : undefined;
  const wh = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(raw);
  const w = Number(b['width']);
  const h = Number(b['height']);
  if (wh) return { device: 'custom', w: clamp(Number(wh[1])), h: clamp(Number(wh[2])) };
  if (w > 0 && h > 0) return { device: 'custom', w: clamp(w), h: clamp(h) };
  const d = DEVICES[name ?? 'desktop'];
  // Only a width: the named device's (or desktop's) height, at that width.
  if (w > 0) return { device: 'custom', w: clamp(w), h: d.h };
  return { device: name ?? 'desktop', w: d.w, h: d.h };
}

/** The page to load: http(s) only, no user:password@. A bare loopback host ("localhost:3000") gets http://. */
export function pageUrl(raw: unknown): string | undefined {
  let s = str(raw).trim();
  if (!s) return undefined;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password) return undefined;
  return u.href;
}

/** Why a preview can't be shown: 'noUrl', 'badUrl', or undefined when it can. */
export function previewProblem(b: Readonly<Record<string, unknown>>): 'noUrl' | 'badUrl' | undefined {
  if (!str(b['url']).trim()) return 'noUrl';
  return pageUrl(b['url']) ? undefined : 'badUrl';
}

/**
 * The frame's sandbox. Scripts and forms run so the page works, links may open a new tab, and it can
 * never navigate wisp, open dialogs over it or reach it. A page on wisp's own origin would share its
 * storage and could lift its own sandbox, so it gets an opaque origin instead.
 */
export function previewSandbox(url: string, wispOrigin = ''): string {
  const base = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }
  return origin && origin !== 'null' && origin !== wispOrigin ? `${base} allow-same-origin` : base;
}

/** localhost on the agent's computer isn't localhost where the page is read (the phone, a grid). */
export function isLoopback(url: string): boolean {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** "localhost:3000/settings" for the address bar: no scheme, no trailing slash. */
export const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** The scale a page is drawn at to fit `availW` × `maxH` (bezel included), never above 1. */
export function fitScale(size: PreviewSize, availW: number, maxH: number): number {
  const [bx, by] = BEZEL[size.device];
  if (availW - bx <= 0) return 1;
  return Math.max(0.1, Math.min(1, (availW - bx) / size.w, (maxH - by) / size.h));
}

/** The device button a size lights up: the one it is, or the one it is turned sideways. */
export function deviceOf(size: PreviewSize, asked: PreviewSize): PreviewDevice | undefined {
  const all: Array<[PreviewDevice, Device]> = [...DEVICE_IDS.map((id): [PreviewDevice, Device] => [id, DEVICES[id]]), ...(asked.device === 'custom' ? [['custom', asked] as [PreviewDevice, Device]] : [])];
  const hit = all.find(([, d]) => d.w === size.w && d.h === size.h) ?? all.find(([, d]) => d.w === size.h && d.h === size.w);
  return hit?.[0];
}
