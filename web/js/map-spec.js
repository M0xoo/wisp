// The `map` block: places the agent names (addresses, or coordinates), shown on a Google map with a
// link that opens each in Google Maps. DOM-free: the page (blocks.js) and the server's text stand-in
// (server/render.js) share it. Google's keyless embed shows one place at a time, so the page lists
// them all and the map follows the one picked.

export const MAX_PLACES = 20;
export const ROUTE_MAX = 10; // Google's directions links take an origin, a destination and 8 stops between
const ZOOM = [1, 21];

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '');
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

// lat/lng, lat/lon, latitude/longitude, or [lat, lng] / "lat,lng" in `coords`.
function coords(p) {
  let c = p.coords ?? p.location ?? null;
  if (typeof c === 'string') c = c.split(',');
  if (c && !Array.isArray(c) && typeof c === 'object') c = [c.lat ?? c.latitude, c.lng ?? c.lon ?? c.longitude];
  const [lat, lng] = Array.isArray(c) ? c.map(num) : [num(p.lat ?? p.latitude), num(p.lng ?? p.lon ?? p.longitude)];
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// The places in a block, each { name, address, note, lat?, lng?, q }: `q` is what Google is asked for
// (the coordinates, else the address, else the name). A place with none of them is left out.
// Accepts `places` (objects or plain address strings), `addresses`, or one `address` / `query`.
export function mapPlaces(b = {}) {
  const raw = Array.isArray(b.places) ? b.places : Array.isArray(b.addresses) ? b.addresses : b.address || b.query || coords(b) ? [b] : [];
  const out = [];
  for (const p of raw) {
    if (out.length >= MAX_PLACES) break;
    const o = typeof p === 'string' ? { address: p } : p && typeof p === 'object' ? p : null;
    if (!o) continue;
    const address = str(o.address ?? o.query ?? (o === b ? '' : o.q));
    const name = str(o.name ?? o.label ?? (o === b ? '' : o.title));
    const at = coords(o);
    const q = at ? `${at.lat},${at.lng}` : address || name;
    if (!q) continue;
    out.push({ name, address, note: str(o.note ?? o.detail ?? (o === b ? '' : o.caption)), ...(at || {}), q: q.slice(0, 300) });
  }
  return out;
}

export const mapZoom = (b = {}) => {
  const z = Math.round(Number(b.zoom));
  return Number.isFinite(z) ? Math.min(ZOOM[1], Math.max(ZOOM[0], z)) : 15;
};

const enc = encodeURIComponent;

// The map in the answer: Google's embed, which needs no API key.
export const embedUrl = (p, zoom = 15) => `https://maps.google.com/maps?q=${enc(p.q)}&z=${zoom}&output=embed`;

// The place in Google Maps (the app on a phone): a search for its address, or a pin at its coordinates.
export const openUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${enc(p.q)}`;

// Directions through the places in order, from the first to the last (at most ROUTE_MAX).
export function routeUrl(places) {
  const ps = places.slice(0, ROUTE_MAX);
  if (ps.length < 2) return null;
  const mid = ps.slice(1, -1).map((p) => p.q);
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(ps[0].q)}&destination=${enc(ps.at(-1).q)}${mid.length ? `&waypoints=${enc(mid.join('|'))}` : ''}`;
}
