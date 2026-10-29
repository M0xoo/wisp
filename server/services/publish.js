// Publish an app from My Stuff to your wisp Grid (grid/sites.js): its folder goes up as one bundle
// (server/bundle.js) and the grid serves it at a link anyone can open, while this computer (or
// your cloud wisp) is off. Publishing it again, after an agent changed it, updates the same link.
//
// Where it goes: in a cloud wisp, its own grid (hostd gave it the address and a secret); elsewhere,
// a grid you signed in to (Settings → Cloud, or Machines): its cloud computer's device token.
// The item keeps { url, account, host, handle, rev, at } so the page shows the link and whether it's behind.

import { gridJson } from '../grid-client.js';
import { packDir } from '../bundle.js';
import { bad } from '../util.js';

const MAX = 200 * 1024 * 1024; // the grid says its own limit (413)

export function createPublish(app, { env = process.env } = {}) {
  const { stuff } = app;

  // Each place an app can go: { id, grid, host, handle, auth }.
  function targets() {
    const out = [];
    const grid = String(env.WISP_GRID_URL || '').replace(/\/+$/, '');
    const secret = env.WISP_TRUSTED_PROXY_SECRET;
    if (grid && secret && env.WISP_PUBLIC_URL) {
      const handle = new URL(env.WISP_PUBLIC_URL).hostname.split('.')[0];
      out.push({ id: 'box', grid, handle, auth: `Box ${handle} ${secret}` });
    }
    for (const m of app.machines?.list || []) {
      if (m.kind !== 'grid' || m.computer || !m.grid) continue;
      const token = app.secrets?.get('machines', m.id);
      if (token && !out.some((t) => t.grid === m.grid && t.handle === m.handle)) out.push({ id: m.id, grid: m.grid, handle: m.handle, auth: `Bearer ${token}` });
    }
    return out.map((t) => ({ ...t, host: new URL(t.grid).host }));
  }

  // What the page shows: where it can publish, never a token.
  const view = () => targets().map(({ id, host, handle }) => ({ id, host, handle }));

  // The one asked for, else the one it went to before (or another sign-in on that grid), else the first.
  const pick = (id, was) => {
    const all = targets();
    const t = id ? all.find((x) => x.id === id) : all.find((x) => x.id === was?.account) || all.find((x) => x.host === was?.host && x.handle === was?.handle) || all[0];
    if (!t) throw bad(all.length ? 'That grid isn’t signed in any more: Settings → Cloud.' : 'Sign in to a wisp Grid first (Settings → Cloud) to publish apps.', 409);
    return t;
  };

  const ask = async (t, method, p, opts = {}) => {
    let r;
    try {
      r = await gridJson(`${t.grid}${p}`, { method, headers: { authorization: t.auth }, timeout: 120_000, ...opts });
    } catch (err) {
      throw bad(`Couldn’t reach ${t.host}: ${err.message}`, 502);
    }
    if (r.status === 404 && method !== 'DELETE') throw bad(`${t.host} doesn’t publish apps yet (its wisp Grid is older).`, 409);
    if (r.status >= 400) throw bad(r.body.error || `${t.host} said ${r.status}.`, r.status === 401 ? 409 : r.status >= 500 ? 502 : r.status);
    return r.body;
  };

  return {
    targets: view,

    // Publish (or update) item id. account: a target's id, else the one it went to before, else the first.
    async publish(id, { account } = {}) {
      const it = stuff.get(id);
      if (!it || it.kind !== 'app') throw bad('Only apps in My Stuff can be published.', 404);
      const t = pick(account, it.published);
      let packed;
      try {
        packed = packDir(it.path, { maxBytes: MAX });
      } catch (err) {
        if (err.tooBig) throw bad('That app is too big to publish (200 MB at most).', 413);
        throw err;
      }
      const q = new URLSearchParams({ title: it.title, entry: it.entry || 'index.html' });
      const site = await ask(t, 'PUT', `/api/sites/${encodeURIComponent(it.id)}?${q}`, { raw: packed.body });
      app.telemetry?.track('stuff_publish', { update: !!it.published, files: packed.files });
      return stuff.setPublished(it.id, { url: site.url, account: t.id, host: t.host, handle: t.handle, rev: it.rev || 1, at: Date.now() });
    },

    // Take it off the grid: the link stops working; the app stays in My Stuff.
    async unpublish(id) {
      const it = stuff.get(id);
      if (!it?.published) throw bad('That app isn’t published.', 404);
      const t = targets().find((x) => x.id === it.published.account) || targets().find((x) => x.host === it.published.host && x.handle === it.published.handle);
      if (!t) {
        stuff.setPublished(it.id, null);
        throw bad(`You’re signed out of ${it.published.host}, so it’s still up there: unpublish it from your account page on ${it.published.host}.`, 409);
      }
      await ask(t, 'DELETE', `/api/sites/${encodeURIComponent(it.id)}`);
      return stuff.setPublished(it.id, null);
    },
  };
}
