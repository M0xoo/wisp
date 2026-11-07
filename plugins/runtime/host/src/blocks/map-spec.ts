// The `map` block (v1 web/js/map-spec.js): places the agent names (addresses, or coordinates), shown on
// a Google map with a link that opens each in Google Maps. DOM-free: the page and the text stand-in
// (render.ts) share it.

export const MAX_PLACES = 20;
export const ROUTE_MAX = 10; // Google's directions links take an origin, a destination and 8 stops between
const ZOOM: readonly [number, number] = [1, 21];

export interface Place {
  name: string;
  address: string;
  note: string;
  lat?: number;
  lng?: number;
  q: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '');
const num = (v: unknown): number | null => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

// lat/lng, lat/lon, latitude/longitude, or [lat, lng] / "lat,lng" in `coords`.
function coords(p: Obj): { lat: number; lng: number } | null {
  let c: unknown = p['coords'] ?? p['location'] ?? null;
  if (typeof c === 'string') c = c.split(',');
  if (isObj(c)) c = [c['lat'] ?? c['latitude'], c['lng'] ?? c['lon'] ?? c['longitude']];
  const [lat, lng] = Array.isArray(c) ? (c as unknown[]).map(num) : [num(p['lat'] ?? p['latitude']), num(p['lng'] ?? p['lon'] ?? p['longitude'])];
  return lat !== null && lat !== undefined && lng !== null && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// The places in a block: `q` is what Google is asked for (the coordinates, else the address, else
// the name). A place with none of them is left out. Accepts `places` (objects or plain address
// strings), `addresses`, or one `address` / `query`.
export function mapPlaces(b: Obj = {}): Place[] {
  const places = b['places'];
  const addresses = b['addresses'];
  const raw: unknown[] = Array.isArray(places) ? places : Array.isArray(addresses) ? addresses : b['address'] || b['query'] || coords(b) ? [b] : [];
  const out: Place[] = [];
  for (const p of raw) {
    if (out.length >= MAX_PLACES) break;
    const o: Obj | null = typeof p === 'string' ? { address: p } : isObj(p) ? p : null;
    if (!o) continue;
    const self = o === b;
    const address = str(o['address'] ?? o['query'] ?? (self ? '' : o['q']));
    const name = str(o['name'] ?? o['label'] ?? (self ? '' : o['title']));
    const at = coords(o);
    const q = at ? `${at.lat},${at.lng}` : address || name;
    if (!q) continue;
    out.push({ name, address, note: str(o['note'] ?? o['detail'] ?? (self ? '' : o['caption'])), ...(at ?? {}), q: q.slice(0, 300) });
  }
  return out;
}

export const mapZoom = (b: Obj = {}): number => {
  const z = Math.round(Number(b['zoom']));
  return Number.isFinite(z) ? Math.min(ZOOM[1], Math.max(ZOOM[0], z)) : 15;
};

const enc = encodeURIComponent;

// The map in the answer: Google's embed, which needs no API key.
export const embedUrl = (p: Place, zoom = 15): string => `https://maps.google.com/maps?q=${enc(p.q)}&z=${zoom}&output=embed`;

// The place in Google Maps (the app on a phone): a search for its address, or a pin at its coordinates.
export const openUrl = (p: Place): string => `https://www.google.com/maps/search/?api=1&query=${enc(p.q)}`;

// Directions through the places in order, from the first to the last (at most ROUTE_MAX).
export function routeUrl(places: readonly Place[]): string | null {
  const ps = places.slice(0, ROUTE_MAX);
  const first = ps[0];
  const last = ps.at(-1);
  if (ps.length < 2 || !first || !last) return null;
  const mid = ps.slice(1, -1).map((p) => p.q);
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(first.q)}&destination=${enc(last.q)}${mid.length ? `&waypoints=${enc(mid.join('|'))}` : ''}`;
}
