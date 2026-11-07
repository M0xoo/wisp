// The `map` block's places and links (v1 web/js/map-spec.js), DOM-free: places the agent names
// (addresses, or coordinates), Google's keyless embed for the one picked, a link that opens each in
// Google Maps, and a route through them in order.
import { list, obj } from './read.ts';

export const MAX_PLACES = 20;
/** Google's directions links take an origin, a destination and 8 stops between. */
export const ROUTE_MAX = 10;
const ZOOM: readonly [number, number] = [1, 21];

export interface Place {
  readonly name: string;
  readonly address: string;
  readonly note: string;
  readonly lat?: number;
  readonly lng?: number;
  /** what Google is asked for: the coordinates, else the address, else the name */
  readonly q: string;
}

type Rec = Readonly<Record<string, unknown>>;

const text = (v: unknown): string => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).replace(/\s+/g, ' ').trim() : '');
const numOf = (v: unknown): number | undefined => {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || typeof v === 'object') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** lat/lng, lat/lon, latitude/longitude, or [lat, lng] / "lat,lng" / {lat, lng} in `coords` or `location`. */
export function coords(p: Rec): { lat: number; lng: number } | undefined {
  let c: unknown = p['coords'] ?? p['location'];
  if (typeof c === 'string') c = c.split(',');
  if (c !== null && typeof c === 'object' && !Array.isArray(c)) {
    const o = obj(c);
    c = [o['lat'] ?? o['latitude'], o['lng'] ?? o['lon'] ?? o['longitude']];
  }
  const [lat, lng] = Array.isArray(c) ? [numOf(c[0]), numOf(c[1])] : [numOf(p['lat'] ?? p['latitude']), numOf(p['lng'] ?? p['lon'] ?? p['longitude'])];
  return lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

function rawPlaces(b: Rec): readonly unknown[] {
  if (Array.isArray(b['places'])) return list(b['places']);
  if (Array.isArray(b['addresses'])) return list(b['addresses']);
  return b['address'] || b['query'] || coords(b) ? [b] : [];
}

/**
 * The places in a block (at most MAX_PLACES). Accepts `places` (objects or plain address strings),
 * `addresses`, or one `address` / `query` on the block itself. A place with nothing to ask for is left out.
 */
export function mapPlaces(b: Rec): Place[] {
  const out: Place[] = [];
  for (const p of rawPlaces(b)) {
    if (out.length >= MAX_PLACES) break;
    const o: Rec | undefined = typeof p === 'string' ? { address: p } : typeof p === 'object' && p !== null && !Array.isArray(p) ? obj(p) : undefined;
    if (!o) continue;
    const self = o === b;
    const address = text(o['address'] ?? o['query'] ?? (self ? '' : o['q']));
    const name = text(o['name'] ?? o['label'] ?? (self ? '' : o['title']));
    const at = coords(o);
    const q = at ? `${at.lat},${at.lng}` : address || name;
    if (!q) continue;
    out.push({ name, address, note: text(o['note'] ?? o['detail'] ?? (self ? '' : o['caption'])), ...(at ?? {}), q: q.slice(0, 300) });
  }
  return out;
}

export function mapZoom(b: Rec): number {
  const z = Math.round(Number(b['zoom']));
  return Number.isFinite(z) ? Math.min(ZOOM[1], Math.max(ZOOM[0], z)) : 15;
}

const enc = encodeURIComponent;

/** The map in the answer: Google's embed, which needs no API key. */
export const embedUrl = (p: Place, zoom = 15): string => `https://maps.google.com/maps?q=${enc(p.q)}&z=${zoom}&output=embed`;

/** The place in Google Maps (the app, on a phone): a search for its address, or a pin at its coordinates. */
export const placeUrl = (p: Place): string => `https://www.google.com/maps/search/?api=1&query=${enc(p.q)}`;

/** Directions through the places in order, first to last (at most ROUTE_MAX); undefined under two. */
export function routeUrl(places: readonly Place[]): string | undefined {
  const ps = places.slice(0, ROUTE_MAX);
  const first = ps[0];
  const last = ps[ps.length - 1];
  if (ps.length < 2 || !first || !last) return undefined;
  const mid = ps.slice(1, -1).map((p) => p.q);
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(first.q)}&destination=${enc(last.q)}${mid.length ? `&waypoints=${enc(mid.join('|'))}` : ''}`;
}

/** What a place's row shows under its name: its address, else (with no name) what was asked, else its coordinates. */
export function placeLine(p: Place): string {
  if (p.address) return p.address;
  if (!p.name) return p.q;
  return '';
}
