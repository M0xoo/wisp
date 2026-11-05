// Settings → Cloud → API keys (and Connect, in a cloud computer): keys for scripting your cloud
// wisp, `Authorization: Bearer wgk_…` at its address. They live on your wisp Grid, hashed. A new one
// shows here once: it's held in `fresh` below and nowhere else, never in S, cache.js or storage,
// and goes on Done or when the pane is left. wisp can't show it again.
//
// A cloud computer asks its grid's edge (/_grid/keys) with your browser's cookie, because the box
// can't make keys; a desktop asks through its wisp (/api/cloud/keys), with its device sign-in.

import { esc } from '../md.js';
import { copy } from '../blocks.js';
import { api, reach, refused } from '../core/api.js';
import * as bus from '../core/bus.js';
import { icon } from '../core/dom.js';
import { inGrid } from '../core/state.js';
import { agoLong, timeAttrs } from '../core/format.js';
import { ask } from '../ui/confirm.js';
import { refocus } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { cloudAccounts } from './places.js';

const when = (t) => `<time ${timeAttrs(t)}>${esc(agoLong(t))}</time>`;
const newest = (a, b) => b.createdAt - a.createdAt;
const skeleton = '<span class="key-sk rec-sk"></span>';
const listHead = '<div class="sbx-list-h key-grid" aria-hidden="true"><span>Name</span><span>Created</span><span>Last used</span></div>';
let lastCount = 0; // how many rows the last look found: the next open's placeholders (a count, never a key)

export function mountApiKeys(box, { grid = null } = {}) {
  if (!box) return;
  // One call for both ways in, with api()'s errors. An older grid has no /_grid/keys: nothing to show.
  const call = async (p, { method = 'GET', body } = {}) => {
    if (!grid) return api(`/cloud${p}`, { method, body });
    const r = await reach(`/_grid${p}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (method === 'GET' && r.status === 404) return { grid: null, keys: [] };
    if (!r.ok) throw refused(r, j);
    return method === 'GET' ? { grid: { host: new URL(grid.url).host, handle: new URL(grid.address).hostname.split('.')[0] }, ...j } : j;
  };
  let v = null; // GET /keys
  let failed = ''; // why GET didn't answer, with nothing to show yet
  let fresh = null; // the key just made: { name, key }
  // A grid is known before GET answers: the card's frame paints at once, and rows join it.
  let coming = inGrid() || cloudAccounts().length > 0;

  // A row's labels are for the stacked layout: wide, they're the list's header, and stay for screen readers.
  const row = (k) => `<span class="sbx-name key-name"><b title="${esc(k.name)}">${esc(k.name)}</b><small class="mono">${k.pending ? '…' : `…${esc(k.hint)}`}</small></span>
      <small class="key-when"><span class="key-l">Created </span>${when(k.createdAt)}</small>
      <small class="key-when"><span class="key-l">Last used </span>${k.lastUsedAt ? when(k.lastUsedAt) : 'Never'}</small>
      <button class="ghost xs danger" data-key-revoke="${esc(k.id)}"${k.pending ? ' disabled' : ''}>Revoke</button>`;
  // The same shapes as row(), so rows land where these were.
  const placeholders = (n) => {
    const one = `<div class="sbx-row key-grid key-wait" aria-hidden="true"><span class="sbx-name">${skeleton}${skeleton}</span>${skeleton}${skeleton}${skeleton}</div>`;
    return (n ? listHead : '') + one.repeat(Math.max(1, n));
  };
  const address = () => (grid ? grid.address : `https://${v.grid.handle}.${v.grid.host}`);
  // $WISP_KEY, never the key: Copy is the one way out of this panel.
  const reveal = () =>
    fresh
      ? `<div class="key-new">
          <p><b>${esc(fresh.name)}</b> is ready. Copy it now. You won’t see it again.</p>
          <code class="mono key-full">${esc(fresh.key)}</code>
          <code class="mono key-try" title="Try it, with the key in $WISP_KEY">curl -H "Authorization: Bearer $WISP_KEY" ${esc(address())}/api/health</code>
          <div class="key-new-acts"><button class="primary sm" data-key="copy">${icon('copy')}<span class="key-copy"><span>Copy</span><span>Copied</span></span></button><button class="ghost sm" data-key="done">Done</button></div>
        </div>`
      : '';

  // The card once; after that only what changed, so a name being typed stays where it is.
  const shown = new Map(); // part -> its html (a local, not a data- attribute: it can hold the key)
  const fill = (part, html) => {
    if (shown.get(part) === html) return;
    box.querySelector(part).innerHTML = html;
    shown.set(part, html);
  };
  // Rows by id, as they are on the page: only what changed is touched, so a refresh leaves the rest
  // (and a Revoke that has focus) alone.
  const rows = new Map(); // id -> { node, html }
  const fillRows = (keys) => {
    const list = box.querySelector('.key-list');
    if (shown.has('.key-list') || !rows.size) {
      list.innerHTML = listHead;
      shown.delete('.key-list');
    }
    const ids = new Set(keys.map((k) => k.id));
    for (const [id, r] of rows) {
      if (!ids.has(id)) {
        r.node.remove();
        rows.delete(id);
      }
    }
    let at = list.firstElementChild; // the header
    for (const k of keys) {
      const html = row(k);
      let r = rows.get(k.id);
      if (!r) {
        const node = Object.assign(document.createElement('div'), { className: 'sbx-row key-grid key-row' });
        r = { node, html: null };
        rows.set(k.id, r);
      }
      if (r.html !== html) {
        r.node.innerHTML = html;
        r.html = html;
      }
      if (at.nextElementSibling !== r.node) at.after(r.node);
      at = r.node;
    }
  };
  // What the list's place says when there are no rows to show.
  const listState = () => {
    if (failed && !v?.grid)
      return `<div class="sbx-row key-grid key-msg"><span class="key-msg-t"><b>Couldn’t load your keys</b><small class="bad">${esc(failed)}</small></span><button class="ghost sm" data-key="reload">Try again</button></div>`;
    if (!v?.grid) return placeholders(lastCount);
    return '<p class="key-empty">No keys yet. Make one per script, so you can revoke one and keep the rest.</p>';
  };
  const paint = () => {
    if (!box.isConnected) return;
    if (!v?.grid && !failed && !coming) {
      box.innerHTML = '';
      shown.clear();
      rows.clear();
      return;
    }
    if (!box.querySelector('.key-card')) {
      // The form sits above the list: a new key's panel opens under it, however long the list is.
      box.innerHTML = `<div class="sx-group key-card">
          <div class="sx-row"><div class="sx-text"><b>API keys</b><small>A key lets a script do anything you can do in ${grid ? 'this' : 'your cloud'} wisp. Keep it like a password, and revoke it if it leaks.</small></div></div>
          <form class="key-add" data-key-form><input class="input" name="name" placeholder="What it’s for" aria-label="Key name" maxlength="60" autocomplete="off" spellcheck="false"><button class="ghost sm" type="submit">${icon('plus')}Create key</button></form>
          <div class="key-reveal"></div>
          <div class="key-list"></div>
        </div>`;
    }
    fill('.key-reveal', reveal());
    const keys = v?.grid ? v.keys : [];
    if (keys.length) fillRows(keys);
    else {
      rows.clear();
      fill('.key-list', listState());
    }
    box.querySelector('.key-add button').disabled = !v?.grid;
  };

  const load = () =>
    call('/keys')
      .then((x) => {
        v = x;
        failed = '';
        coming = false;
        lastCount = x.keys.length;
        if (!x.grid) fresh = null;
        paint();
      })
      .catch((err) => {
        failed = err.message;
        coming = false;
        paint();
      });

  const forget = () => {
    if (!fresh) return;
    fresh = null;
    paint();
  };

  box.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-key-form]');
    if (!form) return;
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return void form.name.focus();
    if (!v?.grid) return;
    // At once: the box empty, the row in the list. The key itself comes back from the grid.
    const pending = { id: `new-${Date.now()}`, name, hint: '', createdAt: Date.now(), lastUsedAt: null, pending: true };
    v = { ...v, keys: [pending, ...v.keys] };
    form.reset();
    paint();
    try {
      const { key, ...made } = await call('/keys', { method: 'POST', body: { name } });
      v = { ...v, keys: v.keys.map((k) => (k === pending ? made : k)) };
      fresh = { name: made.name, key };
    } catch (err) {
      v = { ...v, keys: v.keys.filter((k) => k !== pending) };
      const f = box.querySelector('[data-key-form]');
      if (f && !f.name.value) f.name.value = name;
      toastError(err);
    }
    paint();
    // Enter copies; and on a phone the keyboard goes, and the panel is what's in view.
    if (fresh) {
      box.querySelector('[data-key="copy"]')?.focus({ preventScroll: true });
      box.querySelector('.key-new')?.scrollIntoView({ block: 'nearest' });
    }
  });

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-key-revoke]');
    if (b) {
      const k = v.keys.find((x) => x.id === b.dataset.keyRevoke);
      if (!k) return;
      if (!(await ask(`Revoke ${k.name}?\n\nAnything using this key stops working right away. This can’t be undone.`, { ok: 'Revoke key', danger: true, anchor: b }))) return;
      v = { ...v, keys: v.keys.filter((x) => x !== k) };
      paint();
      const ok = await tryApi(() => call(`/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }));
      if (ok) return void toast('Revoked');
      v = { ...v, keys: [...v.keys, k].sort(newest) };
      paint();
      load(); // already gone from another device: the list says so
      return;
    }
    const a = e.target.closest('[data-key]');
    if (a?.dataset.key === 'copy' && fresh) await copy(fresh.key, a);
    else if (a?.dataset.key === 'done') {
      forget();
      refocus(box.querySelector('.key-add input'));
    } else if (a?.dataset.key === 'reload') {
      // Back to the placeholders at once, whatever the answer.
      failed = '';
      coming = true;
      paint();
      load();
    }
  });

  // Leaving the pane, however it's left (another section, Manage, closing Settings): the key goes.
  const pane = box.closest('.sx-pane');
  if (pane) new MutationObserver(() => pane.hidden && forget()).observe(pane, { attributes: true, attributeFilter: ['hidden'] });

  // Signed in to a grid (or out of one): whether there's a grid to keep keys on changed.
  const accounts = () => cloudAccounts().length;
  let seen = accounts();
  bus.on(
    'machines',
    () => {
      if (accounts() !== seen) (seen = accounts()), load();
    },
    { node: box },
  );
  paint();
  load();
}
