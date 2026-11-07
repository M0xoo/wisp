// What's shared to wisp, DOM-free: web/sw.js loads this with importScripts, the page imports it
// (features/share-in.js) and so do the tests, so it stays a plain script: no import, no export.
// The Android app applies the same caps itself (mobile/…/Shared.java).

(() => {
  const MAX_FILES = 10;
  const MAX_BYTES = 20 * 1024 * 1024;
  const CACHE = 'wisp-shared'; // not 'wisp-shell': a new build empties that one (cache.js)
  const STALE_MS = 24 * 3600 * 1000; // a share nobody opened goes with the next one
  const FILE_TYPES = ['image/*', 'text/*', 'application/pdf'];

  // In order, leaving out what doesn't fit: a small file after a huge one still goes.
  function fits(files) {
    const kept = [];
    let bytes = 0;
    for (const f of files) {
      if (kept.length >= MAX_FILES || bytes + f.size > MAX_BYTES) continue;
      kept.push(f);
      bytes += f.size;
    }
    return { kept, left: files.length - kept.length };
  }

  // What goes in the box. Apps repeat themselves: a page's address in its text, its title in both.
  function promptOf({ title, text, url } = {}) {
    const [t, x, u] = [title, text, url].map((s) => String(s || '').trim());
    const lines = [];
    if (t && !x.includes(t)) lines.push(t);
    if (x) lines.push(x);
    if (u && !x.includes(u)) lines.push(u);
    return lines.join('\n\n');
  }

  const accepted = (f) => FILE_TYPES.some((t) => (t.endsWith('/*') ? f.type.startsWith(t.slice(0, -1)) : f.type === t));

  const leftOut = (n) => `Left out ${n} file${n === 1 ? '' : 's'}: a share takes pictures, text and PDFs, ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB at most.`;
  const keyOf = (id) => `/shared/${id}`;

  // The worker: the form, capped, under a random id. One Response holds it all, files included.
  // Any site can post this form too, without a click, and the worker can't tell that from the share
  // sheet: it sees Origin but no Sec-Fetch-*, and a page with no-referrer sends Origin: null. So
  // nothing kept here acts on its own: the page shows it as from outside and sends nothing until
  // Send (features/share-in.js). The types are the manifest's, which only the share sheet honours.
  async function keep(request, store = caches, now = Date.now()) {
    const form = await request.formData();
    const out = new FormData();
    for (const k of ['title', 'text', 'url']) {
      const v = form.get(k);
      if (typeof v === 'string' && v) out.set(k, v);
    }
    // A share with no files still sends the field, empty.
    const files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size);
    const { kept } = fits(files.filter(accepted));
    const left = files.length - kept.length;
    for (const f of kept) out.append('files', f, f.name);
    out.set('left', String(left));
    const cache = await store.open(CACHE);
    for (const old of await cache.keys()) {
      const at = parseInt(old.url.split('/').pop(), 36);
      if (!(now - at < STALE_MS)) await cache.delete(old);
    }
    const id = `${now.toString(36)}-${crypto.randomUUID()}`;
    await cache.put(keyOf(id), new Response(out));
    return id;
  }

  // The page: read once, then it's gone.
  async function take(id, store = caches) {
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const cache = await store.open(CACHE);
    const hit = await cache.match(keyOf(id));
    if (!hit) return null;
    const form = await hit.formData();
    await cache.delete(keyOf(id));
    const field = (k) => form.get(k) || '';
    return { title: field('title'), text: field('text'), url: field('url'), files: form.getAll('files'), left: Number(field('left')) || 0 };
  }

  globalThis.wispShareForm = { MAX_FILES, MAX_BYTES, FILE_TYPES, CACHE, accepted, fits, promptOf, leftOut, keep, take };
})();
