// My Stuff: everything you and your agents kept from tasks (server/services/stuff.js), on one
// page in the main pane like the Org page (stacked: a page over the list, with Back). It opens from
// the box beside New task, ⌘K, or the toast after a save.
//
// Things get here three ways: Save to My Stuff on a reply's picture, video, doc or code (the
// buttons beside Copy and Download, keepCtx below), an agent's wisp_save, or files dropped (or
// pasted, or picked with Add files) on the page. The page finds them by words (titles, notes, tags,
// the task they came from, a doc's opening), by kind, by star, and lays them out as a grid of
// previews or a list, by time (Today, Yesterday, …) or by the task they came from.
//
// The list as last seen paints at once (kept in this browser); the server's follows, and the
// `stuff` event repaints every open page. Saving, starring, renaming and removing change the page
// first and roll back with a toast if the server refuses; a removal waits for its Undo toast.
//
// Spells reach it through spell-schema.js: the stuff.head slot, the stuff.* parts, and the
// stuff.page props (view, group, cardWidth).

import { copy } from '../blocks.js';
import { esc, highlight, md } from '../md.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { api, track } from '../core/api.js';
import { fmtDate, fmtSize } from '../core/format.js';
import { load, MOBILE, S, save } from '../core/state.js';
import { clampToViewport, popover, TOUCH } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { viewImage } from '../ui/viewer.js';
import { readDoc } from '../ui/reader.js';
import { copyImage } from '../ui/image.js';
import { collapse, renderFeed, reveal as revealTask } from './feed.js';
import { goBack, goHome, isSplit, isStacked, splitOpen } from './split.js';
import { cleanTitle } from '../mention-text.js';
import { boxUrl, isLoopback, previewSandbox } from '../preview-spec.js';
import { overlay } from '../ui/overlay.js';
import { leaveCrew } from './crew.js';
import { leaveOrg } from './org.js';
import { leavePlan } from './plan-view.js';
import { slotHtml, spellProp } from './spells.js';

const KINDS = [
  { id: 'app', label: 'Apps', one: 'App', icon: 'app' },
  { id: 'image', label: 'Pictures', one: 'Picture', icon: 'image' },
  { id: 'video', label: 'Videos', one: 'Video', icon: 'play' },
  { id: 'doc', label: 'Docs', one: 'Doc', icon: 'file' },
  { id: 'code', label: 'Code', one: 'Code', icon: 'terminal' },
  { id: 'file', label: 'Files', one: 'File', icon: 'clip' },
  { id: 'link', label: 'Links', one: 'Link', icon: 'web' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
const CACHED = 300; // items kept in this browser for the first paint

S.stuff = load('wisp.stuff', null); // null: never loaded here (placeholders, not "nothing yet")
S.publishTo = load('wisp.publishTo', []); // the wisp Grids an app can be published to
S.stuffOpen = load('wisp.stuffOpen', false);
let query = '';
let kind = load('wisp.stuffKind', 'all');
let starred = false;
let viewPick = load('wisp.stuffView', null); // grid | list: yours, else the spell's, else grid
let groupPick = load('wisp.stuffGroup', null); // time | task
let view = null;
let tmp = 0;
const hidden = new Set(); // removed, waiting for their Undo toast to go

const all = () => (S.stuff || []).filter((x) => !hidden.has(x.id));
const layout = () => viewPick || (spellProp('stuff.page', 'view') === 'list' ? 'list' : 'grid');
const grouping = () => groupPick || (spellProp('stuff.page', 'group') === 'task' ? 'task' : 'time');
// ?r= changes when an agent updates it, so the browser shows the new one.
const fileUrl = (it, download) => `/api/stuff/${it.id}/file?r=${it.rev || 1}${download ? '&download=1' : ''}`;
const coverUrl = (it) => `/api/stuff/${it.id}/cover?r=${it.rev || 1}`;
const ext = (it) => (/\.([\w]{1,6})$/.exec(it.name || '')?.[1] || '').toUpperCase();
const texty = (it) => typeof it.excerpt === 'string';
export const stuffByKey = (key) => (key ? all().find((x) => x.from?.key === key) : null);

// --- the list -------------------------------------------------------------------------------------

export async function loadStuff() {
  try {
    const { items, publishTo = [] } = await api('/stuff');
    S.publishTo = publishTo;
    save('wisp.publishTo', publishTo);
    agentNews(items);
    // Saves still on their way stay at the top until their answer replaces them.
    setStuff([...(S.stuff || []).filter((x) => x.pending && !items.some((i) => i.from?.key && i.from.key === x.from?.key)), ...items]);
  } catch {}
}

function setStuff(list) {
  S.stuff = list;
  save('wisp.stuff', list.filter((x) => !x.pending).slice(0, CACHED));
  paintSaveButtons();
  paintStuffBlocks();
  paintStuff();
  bus.emit('stuff-list');
}

const swap = (id, next) => {
  // A save that just landed keeps its card (and its place): no second entrance.
  const card = next && next.id !== id && view?.cards.get(id);
  if (card) view.cards.delete(id), view.cards.set(next.id, card);
  // The live list may have brought it already: one copy, where the placeholder was.
  const rest = (S.stuff || []).filter((x) => x.id === id || x.id !== next?.id);
  setStuff((rest.some((x) => x.id === id) ? rest : S.stuff || []).map((x) => (x.id === id ? next : x)).filter(Boolean));
};
const drop = (id) => setStuff((S.stuff || []).filter((x) => x.id !== id));
const put = (it) => setStuff([it, ...(S.stuff || [])]);

bus.on('stuff', () => loadStuff());
queueMicrotask(loadStuff);

// --- Save to My Stuff, on a reply's blocks ----------------------------------------------------------

// The block renderers' side (blocks.js): ctx.keep.html(what) is the button, ctx.keep.bind(node, what,
// payload) wires it. `what` names the thing within its turn; the key adds the task and turn, so the
// same picture saved twice is one item, and the button shows it's in My Stuff on every page.
export function keepCtx(s, turn) {
  const keyOf = (what) => `${s.id}|${turn?.id || ''}|${what}`;
  return {
    html: (what, cls = '') => saveButtonHtml(keyOf(what), cls),
    bind(node, what, payload) {
      const key = keyOf(what);
      const btn = [...node.querySelectorAll('.stuff-save')].find((b) => b.dataset.key === key);
      if (!btn) return;
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleSave(key, typeof payload === 'function' ? payload() : payload, s, turn);
      };
    },
  };
}

function saveButtonHtml(key, cls) {
  const on = !!stuffByKey(key);
  const label = on ? 'In My Stuff: click to remove it' : 'Save to My Stuff';
  return `<button class="stuff-save ${cls} ${on ? 'on' : ''}" data-key="${esc(key)}" title="${label}" aria-label="${label}" aria-pressed="${on}">${icon('stuff')}</button>`;
}

// Every Save button on the page follows the list: one saved in another window, or removed here.
function paintSaveButtons() {
  for (const b of $$('.stuff-save[data-key]')) {
    const on = !!stuffByKey(b.dataset.key);
    if (b.classList.contains('on') === on) continue;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    b.title = on ? 'In My Stuff: click to remove it' : 'Save to My Stuff';
    b.setAttribute('aria-label', b.title);
  }
}

// payload: { path, title } a file the reply showed, or { text, name, lang, title }.
async function toggleSave(key, payload, s, turn) {
  const have = stuffByKey(key);
  if (have) return removeItem(have);
  const name = payload.name || String(payload.path || payload.src || '').split(/[\\/?#]/).filter(Boolean).pop() || '';
  const temp = { id: `tmp-${++tmp}`, pending: true, kind: payload.kind || guessKind(name, payload), title: payload.title || name || 'Saving…', name, size: payload.text ? new Blob([payload.text]).size : 0, at: Date.now(), by: 'you', from: { session: s.id, title: s.title, key }, ...(payload.text && { excerpt: payload.text.slice(0, 1400) }), ...(payload.lang && { lang: payload.lang }) };
  put(temp);
  try {
    const it = await saveRemote(payload, { s, turn, key, name });
    swap(temp.id, it);
    track('stuff_save', { kind: it.kind });
    if (!stuffShown()) toast(`${icon('stuff')}Saved to My Stuff`, { action: { label: 'Open', run: () => openStuff() } });
  } catch (err) {
    drop(temp.id);
    toastError(err);
  }
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
function guessKind(name, p) {
  if (p.lang) return 'code';
  if (p.text !== undefined) return 'doc';
  return IMAGE.test(name) ? 'image' : VIDEO.test(name) ? 'video' : 'file';
}

async function saveRemote(p, { s, turn, key, name }) {
  const base = { session: s.id, turn: turn?.id, key, title: p.title };
  if (p.text !== undefined) return api('/stuff', { method: 'POST', body: { ...base, text: p.text, name: p.name, lang: p.lang } });
  // A task on another computer, or a picture on the web: the page has the bytes, so it sends them.
  if (s.id.includes('@') || /^https?:/.test(p.src || '')) {
    const src = p.src || p.url;
    let blob;
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error();
      blob = await r.blob();
    } catch {
      // A picture another site won't hand over: its link is the next best thing.
      if (/^https?:/.test(src)) return api('/stuff', { method: 'POST', body: { ...base, url: src } });
      throw new Error('Couldn’t read that file to save it.');
    }
    return upload(blob, { name: name || 'file', type: blob.type, title: p.title, key, from: s.title });
  }
  return api('/stuff', { method: 'POST', body: { ...base, path: p.path } });
}

async function upload(file, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const r = await fetch(`/api/stuff/upload?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// --- changing an item -----------------------------------------------------------------------------

async function patch(it, body) {
  const was = it;
  swap(it.id, { ...it, ...body });
  try {
    swap(it.id, await api(`/stuff/${it.id}`, { method: 'PATCH', body }));
  } catch (err) {
    swap(it.id, was);
    toastError(err);
  }
}

// Gone at once; the file goes once the Undo toast does.
function removeItem(it) {
  if (it.pending) return;
  hidden.add(it.id);
  paintSaveButtons();
  paintStuff();
  let undone = false;
  toast(`Removed “${esc(it.title)}” from My Stuff`, {
    action: {
      label: 'Undo',
      run: () => {
        undone = true;
        hidden.delete(it.id);
        paintSaveButtons();
        paintStuff();
      },
    },
    onClose: () => {
      if (undone) return;
      api(`/stuff/${it.id}`, { method: 'DELETE' }).then(
        () => (hidden.delete(it.id), drop(it.id)),
        (err) => {
          hidden.delete(it.id);
          setStuff(S.stuff || []);
          toastError(err);
        },
      );
    },
  });
}

async function textOf(it) {
  const r = await fetch(fileUrl(it));
  if (!r.ok) throw new Error('The file is gone.');
  return r.text();
}

// Open: pictures and videos in the viewer (← → go through the others shown), docs and code in the
// reader, links and other files in a new tab.
async function openItem(it) {
  if (it.pending) return;
  if (it.kind === 'app') return launchApp(it);
  if (it.kind === 'link') return window.open(it.url, '_blank', 'noopener');
  if (it.kind === 'image' || it.kind === 'video') {
    const media = shownItems().filter((x) => (x.kind === 'image' || x.kind === 'video') && !x.pending);
    const list = media.map((x) => ({ src: fileUrl(x), alt: x.title, video: x.kind === 'video' }));
    return viewImage(fileUrl(it), it.title, { list, index: media.indexOf(it) });
  }
  if (texty(it)) {
    try {
      const text = await textOf(it);
      const body = it.kind === 'code' ? `\`\`\`${it.lang || ext(it).toLowerCase()}\n${text.replace(/\n$/, '')}\n\`\`\`` : text;
      return readDoc({ text: body, title: it.title, path: it.name }, { copy: (btn) => copy(text, btn) });
    } catch (err) {
      return toastError(err);
    }
  }
  if (it.mime === 'application/pdf') return window.open(fileUrl(it), '_blank', 'noopener');
  download(it);
}

// Launch: wisp serves the app on a port of its own (server/services/apps.js) and it opens inside
// wisp (appFrame). On a grid the port shows at its preview address; over SSH the phone app can only
// reach wisp itself.
async function launchApp(it) {
  if (MOBILE && isLoopback(location.href)) return toast('Apps open here when you connect through wisp Cloud, or in a browser on the computer running wisp.', { tone: 'bad' });
  const frame = appFrame(it);
  swap(it.id, { ...it, running: it.running || { port: 0 } });
  try {
    const { url } = await api(`/stuff/${it.id}/launch`, { method: 'POST' });
    const to = isLoopback(location.href) ? url : boxUrl(url, S.config?.preview || S.config?.grid?.preview);
    if (!to) {
      frame.close();
      await navigator.clipboard?.writeText(url).catch(() => {});
      return toast(`It’s running on the computer with wisp, at <code>${esc(url)}</code> (copied).`);
    }
    frame.show(to, await gridLink(url, to));
    track('stuff_launch');
  } catch (err) {
    frame.close();
    loadStuff();
    toastError(err);
  }
}

// Behind the grid (to is p<port>--<this wisp's address>), the frame starts at a one-time link that
// signs it in there: the phone app's page has this wisp's cookie but not the grid's sign-in that
// the preview address would send it through. An older grid lacks it: the address as it is.
async function gridLink(url, to) {
  if (!new URL(to).host.endsWith(`--${location.host}`)) return to;
  const u = new URL(url);
  try {
    const r = await fetch(`/_grid/preview?port=${u.port || 80}&path=${encodeURIComponent(u.pathname + u.search)}`, { method: 'POST', credentials: 'same-origin' });
    return (r.ok && (await r.json()).url) || to;
  } catch {
    return to;
  }
}

// An app runs inside wisp: the whole window, its name and controls in a bar on top, the app in a
// frame under it. It's on its own origin (its port), so it keeps its storage and can't reach wisp.
// Esc closes it (once the frame lets go of the keyboard: a game keeps its keys); Back on a phone.
function appFrame(it) {
  const node = el(`
    <div class="ap" role="dialog" aria-label="${esc(it.title)}">
      <header class="ap-top">
        <span class="ap-ic">${icon('app')}</span>
        <div class="ap-name"><b>${esc(it.title)}</b><span>${it.rev > 1 ? `<i>v${it.rev}</i>` : ''}<i class="ap-url">Starting…</i></span></div>
        <div class="ap-tools">
          <button class="ghost xs" data-a="reload" title="Reload the app">${icon('rerun')}<span>Reload</span></button>
          <a class="ghost xs ap-tab" target="_blank" rel="noopener" title="Open it in a browser tab" hidden>${icon('external')}<span>New tab</span></a>
          ${canPublish(it) ? `<button class="ghost xs ap-pub" data-a="publish">${icon('web')}<span></span></button>` : ''}
          <button class="ghost xs" data-a="stop" title="Stop it: wisp stops serving it">${icon('stop')}<span>Stop</span></button>
          <button class="ghost xs" data-a="close" title="Close (Esc)" aria-label="Close">${icon('x')}</button>
        </div>
      </header>
      <div class="ap-stage"><div class="ap-wait"><i></i><span>Starting ${esc(it.title)}…</span></div></div>
    </div>`);
  const stage = node.querySelector('.ap-stage');
  // Publish, Update link or Copy link, kept current while the frame is open.
  const pub = node.querySelector('.ap-pub');
  const paintPub = () => {
    const now = S.stuff?.find((x) => x.id === it.id);
    if (!pub || !now) return;
    const [label, title] = now.publishing ? ['Publishing…', 'Putting it on your wisp Grid'] : !now.published ? ['Publish', `Publish to ${S.publishTo[0]?.host || 'your wisp Grid'}: a link anyone can open`] : behind(now) ? ['Update link', 'Your public link has an older version: put this one there'] : ['Copy link', `Public at ${bare(now.published.url)}: copy the link`];
    pub.querySelector('span').textContent = label;
    pub.title = title;
    pub.disabled = !!now.publishing;
  };
  paintPub();
  if (pub) bus.on('stuff-list', paintPub, { node });
  let iframe = null;
  const close = overlay(node);
  node.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') close();
    if (a === 'reload' && iframe) iframe.src = iframe.src;
    if (a === 'publish') {
      const now = S.stuff.find((x) => x.id === it.id) || it;
      if (now.published && !behind(now)) copyPublic(now);
      else publishApp(now);
    }
    if (a === 'stop') {
      close();
      stopApp(S.stuff.find((x) => x.id === it.id) || it);
    }
  });
  return {
    close,
    show(url, src = url) {
      iframe = el(`<iframe class="ap-frame" title="${esc(it.title)}" allow="fullscreen; autoplay; clipboard-write; gamepad" sandbox="${previewSandbox(url, location.origin)} allow-modals allow-downloads allow-pointer-lock"></iframe>`);
      iframe.src = src;
      iframe.addEventListener('load', () => node.classList.add('ready'), { once: true });
      stage.append(iframe);
      node.querySelector('.ap-url').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const tab = node.querySelector('.ap-tab');
      tab.href = url;
      tab.hidden = MOBILE; // the phone's browser isn't signed in there
      requestAnimationFrame(() => iframe.focus());
    },
  };
}

async function stopApp(it) {
  const { running: _r, ...rest } = it;
  swap(it.id, rest);
  try {
    await api(`/stuff/${it.id}/launch`, { method: 'DELETE' });
  } catch (err) {
    swap(it.id, it);
    toastError(err);
  }
}

async function restoreItem(it) {
  try {
    swap(it.id, await api(`/stuff/${it.id}/restore`, { method: 'POST' }));
    toast(`Back to the version of ${esc(when(it.prev.at))}`, { action: { label: 'Undo', run: () => restoreItem(S.stuff.find((x) => x.id === it.id)) } });
  } catch (err) {
    toastError(err);
  }
}

// Publish: the app goes up to your wisp Grid (server/services/publish.js) at a link anyone can
// open, while this computer is off. Again after a change: the same link, the new version.
const behind = (it) => !!it.published && (it.published.rev || 1) !== (it.rev || 1);
const canPublish = (it) => it.kind === 'app' && !it.pending && (!!it.published || S.publishTo.length > 0);

async function publishApp(it) {
  if (it.publishing) return;
  swap(it.id, { ...it, publishing: true });
  try {
    const next = await api(`/stuff/${it.id}/publish`, { method: 'POST', body: {} });
    swap(it.id, next);
    const copied = await navigator.clipboard?.writeText(next.published.url).then(
      () => true,
      () => false,
    );
    toast(`${it.published ? 'Updated' : 'Published'} at <code>${esc(bare(next.published.url))}</code>: anyone with the link can open it.${copied ? ' Link copied.' : ''}`, { action: { label: 'Open', run: () => window.open(next.published.url, '_blank', 'noopener') } });
    track('stuff_publish');
  } catch (err) {
    swap(it.id, it);
    toastError(err);
  }
}

async function unpublishApp(it) {
  const { published: _p, ...rest } = it;
  swap(it.id, rest);
  try {
    swap(it.id, await api(`/stuff/${it.id}/publish`, { method: 'DELETE' }));
    toast(`Unpublished: <code>${esc(bare(it.published.url))}</code> no longer opens.`);
  } catch (err) {
    swap(it.id, it);
    loadStuff();
    toastError(err);
  }
}

// Reset data: the app's database goes; the next time it asks, it's made again from its seed.
async function resetData(it) {
  swap(it.id, { ...it, data: false });
  try {
    swap(it.id, await api(`/stuff/${it.id}/data`, { method: 'DELETE' }));
    toast(`${esc(it.title)} starts again with ${it.published ? 'fresh data here (its public link keeps its own)' : 'fresh data'}.`);
  } catch (err) {
    swap(it.id, it);
    toastError(err);
  }
}

async function copyPublic(it, btn) {
  try {
    await navigator.clipboard.writeText(it.published.url);
    if (btn?.classList.contains('st-pub')) flash(btn, 'Copied');
    else toast(`Copied <code>${esc(bare(it.published.url))}</code>`);
  } catch {
    toast(`The link: <code>${esc(it.published.url)}</code>`);
  }
}

const bare = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
// A button says what happened for a moment, then goes back.
function flash(btn, text) {
  const span = btn.querySelector('span');
  if (!span || btn.dataset.was) return;
  btn.dataset.was = span.textContent;
  span.textContent = text;
  setTimeout(() => {
    span.textContent = btn.dataset.was;
    delete btn.dataset.was;
  }, 1200);
}

// Use in a new task: New task, with the thing mentioned in the prompt box (the agent gets its file).
export { launchApp };

export function mentionInNew(it) {
  goHome();
  const ta = $('#prompt');
  if (!ta?.mentions) return;
  const title = cleanTitle(it.title);
  if (!ta.mentions.some((m) => m.id === it.id)) ta.mentions.push({ id: it.id, title, kind: 'stuff' });
  ta.focus();
  const shown = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get.call(ta); // the box's text, not the stored form
  ta.setSelectionRange(shown.length, shown.length);
  const text = `${shown && !/\s$/.test(shown) ? ' ' : ''}@${title} `;
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// An agent saved or updated something while you weren't looking at My Stuff: say so, once.
let seen = null; // id -> rev, from the last list
function agentNews(items) {
  const before = seen;
  seen = new Map(items.map((x) => [x.id, x.rev || 1]));
  if (!before || stuffShown()) return;
  const news = items.filter((x) => x.by === 'agent' && (before.get(x.id) || 0) < (x.rev || 1)).sort((a, b) => (b.updatedAt || b.at) - (a.updatedAt || a.at))[0];
  if (!news) return;
  const updated = before.has(news.id);
  toast(`${icon('stuff')}${updated ? 'Updated' : 'Saved'} <b>${esc(news.title)}</b> in My Stuff`, {
    action: { label: news.kind === 'app' ? 'Launch' : 'Open', run: () => (news.kind === 'app' ? launchApp(news) : (openStuff(), openItem(news))) },
  });
}

// --- the @ picker (crew.js) -----------------------------------------------------------------------

export const stuffCount = () => all().filter((x) => !x.pending).length;
export const stuffSub = (it) => [KIND[it.kind]?.one, it.from?.title].filter(Boolean).join(' · ');

// What `@` + letters finds: titles starting with them first, then a word in the title, then the
// rest (name, tags, note). Nothing typed: starred, then the newest.
export function stuffMatches(q, n = 6) {
  const list = all().filter((x) => !x.pending);
  if (!q) return [...list].sort((a, b) => !!b.starred - !!a.starred).slice(0, n);
  const score = (x) => {
    const t = x.title.toLowerCase();
    if (t.startsWith(q)) return 3;
    if (t.split(/[\s\-_.,:/]+/).some((w) => w.startsWith(q))) return 2;
    return `${x.name} ${(x.tags || []).join(' ')} ${x.note || ''}`.toLowerCase().includes(q) ? 1 : 0;
  };
  return list
    .map((x) => [x, score(x)])
    .filter(([, s]) => s)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([x]) => x);
}

export function stuffThumbHtml(it) {
  const pic = it.kind === 'image' ? fileUrl(it) : it.kind === 'app' && it.cover ? coverUrl(it) : '';
  return `<span class="st-mini k-${esc(it.kind)}">${pic ? `<img src="${pic}" alt="" loading="lazy">` : icon(KIND[it.kind]?.icon || 'clip')}</span>`;
}

// --- the stuff block: something in My Stuff, in an answer -------------------------------------------

// An agent's answer points at what it saved ({ type: 'stuff', id, note }): a card with its picture,
// what it is, and its main action, Launch for an app (it opens inside wisp), Open for the rest.
// It reads the item as it is now (an update shows), and the title the server kept once it's gone.
export function stuffBlock(b) {
  const node = el(`<div class="b-stuff card" data-stuff="${esc(String(b.id || '').trim())}"></div>`);
  node.block = b;
  paintStuffBlock(node);
  node.addEventListener('click', (e) => {
    const it = all().find((x) => x.id === node.dataset.stuff);
    if (!it || it.pending) return;
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'page') return openStuff();
    if (a === 'pubcopy') return copyPublic(it, e.target.closest('button'));
    if (a === 'go' || !e.target.closest('button, a')) openItem(it);
  });
  return node;
}

function paintStuffBlock(node) {
  const b = node.block || {};
  const it = all().find((x) => x.id === node.dataset.stuff);
  const k = KIND[it?.kind || b.kind] || KIND.file;
  const title = it?.title || b.title || 'Something in My Stuff';
  const meta = it ? [k.one, it.files ? `${it.files} file${it.files === 1 ? '' : 's'}` : '', it.db ? 'with data' : '', it.size ? fmtSize(it.size) : '', it.rev > 1 ? `v${it.rev}` : ''].filter(Boolean) : [S.stuff === null ? 'Loading…' : 'No longer in My Stuff'];
  const pic = !it ? '' : it.kind === 'app' ? (it.cover ? `<img src="${coverUrl(it)}" alt="" loading="lazy">` : `<b class="sb-initial">${esc(title.trim()[0]?.toUpperCase() || '?')}</b>`) : it.kind === 'image' ? `<img src="${fileUrl(it)}" alt="" loading="lazy">` : icon(k.icon);
  const go = !it ? '' : it.kind === 'app' ? `<button class="sb-go primary sm" data-a="go">${icon('play')}<span>${it.running?.port ? 'Open' : 'Launch'}</span></button>` : `<button class="sb-go ghost sm" data-a="go">${icon(it.kind === 'link' ? 'external' : 'expand')}<span>Open</span></button>`;
  const html = `
    <span class="sb-pic k-${esc(it?.kind || b.kind || 'file')}">${pic}${it?.kind === 'app' ? '<span class="sb-bar"><i></i><i></i><i></i></span>' : ''}</span>
    <span class="sb-main">
      <b>${esc(title)}</b>
      <span class="sb-meta">${icon(k.icon)}${meta.map((m) => `<i>${esc(m)}</i>`).join('')}${it ? `<button class="link sb-page" data-a="page">In My Stuff</button>` : ''}</span>
      ${b.note ? `<span class="sb-note">${esc(b.note)}</span>` : it?.excerpt && it.kind === 'app' ? `<span class="sb-note">${esc(it.excerpt)}</span>` : ''}
      ${it?.published ? `<span class="sb-pub">${icon('web')}<a href="${esc(it.published.url)}" target="_blank" rel="noopener" title="Its public link: anyone can open it">${esc(bare(it.published.url))}</a><button class="st-pub" data-a="pubcopy" title="Copy the public link">${icon('copy')}<span>Copy link</span></button></span>` : ''}
    </span>
    ${go}`;
  node.classList.toggle('missing', !it);
  node.classList.toggle('k-app', it?.kind === 'app');
  setHtml(node, html);
}

const paintStuffBlocks = () => $$('.b-stuff[data-stuff]').forEach(paintStuffBlock);

// A My Stuff chip in a sent prompt opens it.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.mn.stuff[data-stuff]');
  if (!b) return;
  e.preventDefault();
  const it = all().find((x) => x.id === b.dataset.stuff);
  if (!it) return toast('That’s no longer in My Stuff.', { tone: 'bad' });
  if (it.kind === 'app') return launchApp(it);
  openStuff();
  openItem(it);
});

function download(it) {
  const a = el(`<a href="${fileUrl(it, true)}" download="${esc(it.name)}" hidden></a>`);
  document.body.append(a);
  a.click();
  a.remove();
}

async function copyItem(it, btn) {
  if (it.kind === 'link') return copy(it.url, btn);
  if (it.kind === 'image') return copyImage(fileUrl(it), btn);
  try {
    copy(await textOf(it), btn);
  } catch (err) {
    toastError(err);
  }
}
const canCopy = (it) => it.kind === 'link' || it.kind === 'image' || (texty(it) && it.kind !== 'app');

async function showInFolder(it) {
  try {
    await api(`/stuff/${it.id}/reveal`, { method: 'POST' });
  } catch (err) {
    if (err.status !== 409) return toastError(err);
    // Through a proxy, the file is on the computer running wisp: its path is what's useful here.
    const { path } = await fetch(`/api/stuff/${it.id}/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' } }).then((r) => r.json());
    await navigator.clipboard?.writeText(path).catch(() => {});
    toast(`The file is on the computer running wisp. Copied its path: <code>${esc(path)}</code>`);
  }
}

// Rename, note and tags, in one small form by the card.
function editItem(it, anchor) {
  const node = el(`
    <form class="menu st-edit" role="dialog" aria-label="Edit details">
      <label>Title<input class="input" name="title" maxlength="140" value="${esc(it.title)}"></label>
      <label>Note<textarea class="textarea" name="note" rows="3" maxlength="2000" placeholder="What it is, to find it by later">${esc(it.note || '')}</textarea></label>
      <label>Tags<input class="input" name="tags" value="${esc((it.tags || []).join(', '))}" placeholder="logo, brand"></label>
      <div class="st-edit-bar"><button type="button" class="ghost sm" data-a="cancel">Cancel</button><button class="primary sm">Save</button></div>
    </form>`);
  const r = anchor.getBoundingClientRect();
  const close = popover(node, { anchor });
  clampToViewport(node, r.left, r.bottom + 6);
  node.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(node);
    const tags = String(f.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
    close();
    patch(it, { title: String(f.get('title') || '').trim() || it.title, note: String(f.get('note') || ''), tags });
  };
  node.querySelector('[data-a="cancel"]').onclick = () => {
    close();
  };
  requestAnimationFrame(() => node.querySelector('input').select());
}

function itemMenu(it, at, anchor = null) {
  const task = it.from?.session && S.sessions.get(it.from.session);
  const app = it.kind === 'app';
  const rows = [
    app ? ['open', 'play', it.running ? 'Open again' : 'Launch'] : ['open', it.kind === 'link' ? 'external' : 'expand', it.kind === 'link' ? 'Open link' : 'Open'],
    app && it.running && ['stop', 'stop', 'Stop'],
    app && !it.published && S.publishTo.length && ['publish', 'web', `Publish to ${S.publishTo[0].host}`],
    app && it.published && ['pubcopy', 'copy', 'Copy public link'],
    app && it.published && ['pubopen', 'external', 'Open public link'],
    app && behind(it) && ['publish', 'update', 'Update public link'],
    app && it.published && ['unpublish', 'x', 'Unpublish'],
    app && it.db && it.data && ['resetdata', 'rerun', 'Reset data'],
    ['mention', 'agent', 'Use in a new task'],
    canCopy(it) && ['copy', 'copy', it.kind === 'link' ? 'Copy link' : 'Copy'],
    !app && it.kind !== 'link' && !MOBILE && ['download', 'download', 'Download'],
    ['star', 'star', it.starred ? 'Unstar' : 'Star'],
    ['edit', 'pen', 'Edit details…'],
    it.prev && ['restore', 'rerun', `Restore the version of ${when(it.prev.at)}`],
    task && ['task', 'arrow', 'Open the task'],
    it.kind !== 'link' && !MOBILE && ['folder', 'folder', 'Show in folder'],
    ['remove', 'trash', 'Remove'],
  ].filter(Boolean);
  const node = el(`<div class="menu st-menu" role="menu">${rows.map(([a, ic, label]) => `<button role="menuitem" data-a="${a}" class="${a === 'remove' ? 'danger' : ''}">${icon(ic)}${label}</button>`).join('')}</div>`);
  const close = popover(node, { anchor });
  clampToViewport(node, at.x, at.y);
  node.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    close();
    act(a, it, anchor || $(`.st-card[data-id="${it.id}"] .st-more`, view?.node));
  };
  node.querySelector('button')?.focus();
}

function act(a, it, btn) {
  if (a === 'open' || a === 'launch') return openItem(it);
  if (a === 'stop') return stopApp(it);
  if (a === 'publish') return publishApp(it);
  if (a === 'unpublish') return unpublishApp(it);
  if (a === 'resetdata') return resetData(it);
  if (a === 'pubcopy') return copyPublic(it, btn);
  if (a === 'pubopen') return window.open(it.published.url, '_blank', 'noopener');
  if (a === 'mention') return mentionInNew(it);
  if (a === 'restore') return restoreItem(it);
  if (a === 'copy') return copyItem(it, btn?.classList.contains('st-copy') ? btn : null);
  if (a === 'download') return download(it);
  if (a === 'star') return patch(it, { starred: !it.starred });
  if (a === 'edit') return editItem(it, btn || $(`.st-card[data-id="${it.id}"]`, view?.node));
  if (a === 'task') return revealTask(it.from.session);
  if (a === 'folder') return showInFolder(it);
  if (a === 'remove') return removeItem(it);
}

// Files dropped, pasted or picked: each shows at once, filling in when it's in.
function addFiles(files) {
  for (const f of files) {
    const temp = { id: `tmp-${++tmp}`, pending: true, kind: guessKind(f.name, {}), title: f.name.replace(/\.[^.]+$/, '') || f.name, name: f.name, size: f.size, at: Date.now(), by: 'you' };
    put(temp);
    upload(f, { name: f.name, type: f.type }).then(
      (it) => swap(temp.id, it),
      (err) => {
        drop(temp.id);
        toastError(err);
      },
    );
  }
  if (files.length) track('stuff_add', { files: files.length });
}

// ⌘K: each thing kept (the newest first), opened over the page.
export function stuffPalette() {
  return all()
    .filter((x) => !x.pending)
    .slice(0, 200)
    .map((it) => ({
      group: 'My Stuff',
      label: it.title,
      sub: [KIND[it.kind]?.one, it.from?.title].filter(Boolean).join(' · '),
      icon: KIND[it.kind]?.icon || 'stuff',
      keywords: `stuff saved kept ${it.name} ${it.note || ''} ${(it.tags || []).join(' ')} ${it.url || ''}`,
      run: () => {
        openStuff();
        openItem(it);
      },
    }));
}

// --- opening and closing --------------------------------------------------------------------------

export const stuffShown = () => isSplit() && S.stuffOpen && !splitOpen() && !S.crewOpen && !S.orgOpen && !S.planOpen;

export function openStuff() {
  leaveCrew();
  leaveOrg();
  leavePlan();
  for (const id of [...S.open]) collapse(id);
  S.stuffOpen = true;
  save('wisp.stuffOpen', true);
  loadStuff();
  renderFeed(); // the list's selection, then the pane (paintSplit → paintStuff)
  if (!TOUCH.matches) requestAnimationFrame(() => $('.stuff-view .sf-q')?.focus({ preventScroll: true }));
}

export function leaveStuff() {
  if (!S.stuffOpen) return;
  S.stuffOpen = false;
  save('wisp.stuffOpen', false);
}

$('#splitStuff')?.addEventListener('click', () => {
  if (stuffShown()) goBack();
  else openStuff();
});

// --- what's shown -----------------------------------------------------------------------------------

function matches(it, words) {
  if (!words.length) return true;
  const hay = `${it.title} ${it.name} ${it.note || ''} ${(it.tags || []).map((t) => `#${t}`).join(' ')} ${it.from?.title || ''} ${it.url || ''} ${KIND[it.kind]?.label || ''} ${it.lang || ''} ${(it.excerpt || '').slice(0, 600)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function shownItems() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all().filter((x) => (kind === 'all' || x.kind === kind) && (!starred || x.starred) && matches(x, words));
}

// Today, Yesterday, This week, then months; or by the task each came from (newest first).
function groups(list) {
  const out = new Map();
  const add = (k, label, it, extra = {}) => {
    if (!out.has(k)) out.set(k, { key: k, label, items: [], ...extra });
    out.get(k).items.push(it);
  };
  if (grouping() === 'task') {
    for (const it of list) {
      const id = it.from?.session;
      if (!id) add('you', 'Added by you', it);
      else add(`t:${id}`, S.sessions.get(id)?.title || it.from.title || 'A task', it, { task: S.sessions.has(id) ? id : null });
    }
    return [...out.values()];
  }
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  for (const it of list) {
    const t = it.at;
    if (t >= today) add('today', 'Today', it);
    else if (t >= today - 864e5) add('yesterday', 'Yesterday', it);
    else if (t >= today - 6 * 864e5) add('week', 'This week', it);
    else {
      const d = new Date(t);
      const k = `${d.getFullYear()}-${d.getMonth()}`;
      add(k, fmtDate(t, d.getFullYear() === day.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' }), it);
    }
  }
  return [...out.values()];
}

// --- painting ---------------------------------------------------------------------------------------

function build() {
  const node = el(`<section class="stuff-view" id="stuffView" hidden>
      <header class="cv-top stuff-top"></header>
      <div class="sf-bar">
        <label class="field sf-search">${icon('search')}<input class="sf-q" type="search" placeholder="Search titles, notes, #tags, tasks…" aria-label="Search My Stuff" autocomplete="off" spellcheck="false">${MOBILE ? '' : '<kbd>/</kbd>'}</label>
        <div class="sf-kinds" role="tablist" aria-label="Kind"></div>
        <div class="sf-opts"></div>
      </div>
      <div class="sf-body">
        <div class="sf-groups"></div>
        <div class="sf-empty" hidden></div>
      </div>
      <div class="sf-drop" aria-hidden="true"><div>${icon('stuff')}<b>Drop to keep it</b><span>Files go into My Stuff</span></div></div>
      <input class="sf-file" type="file" multiple hidden>
    </section>`);
  const q = $('.sf-q', node);
  q.addEventListener('input', () => {
    query = q.value;
    paintBody();
    paintKinds();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) {
      e.stopPropagation();
      q.value = query = '';
      paintBody();
      paintKinds();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('.st-card', node)?.focus();
    }
  });
  $('.sf-file', node).addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  node.addEventListener('click', onClick);
  node.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.st-card');
    const it = card && all().find((x) => x.id === card.dataset.id);
    if (!it || it.pending) return;
    e.preventDefault();
    itemMenu(it, { x: e.clientX, y: e.clientY });
  });
  node.addEventListener('keydown', onKey);
  // Hovering a video's card plays it, muted, the way a file browser previews one.
  node.addEventListener('pointerover', (e) => {
    const v = e.target.closest('.st-card.k-video:not(.pending)')?.querySelector('video');
    if (v && e.pointerType === 'mouse') v.play().catch(() => {});
  });
  node.addEventListener('pointerout', (e) => {
    const card = e.target.closest('.st-card.k-video');
    if (card && !card.contains(e.relatedTarget)) card.querySelector('video')?.pause();
  });
  // Drop files anywhere on the page.
  let depth = 0;
  const files = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  node.addEventListener('dragenter', (e) => {
    if (!files(e)) return;
    depth++;
    node.classList.add('dropping');
  });
  node.addEventListener('dragleave', () => {
    if (--depth <= 0) (depth = 0), node.classList.remove('dropping');
  });
  node.addEventListener('dragover', (e) => {
    if (files(e)) e.preventDefault();
  });
  node.addEventListener('drop', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    depth = 0;
    node.classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });
  // Pasting a file (a screenshot) while the page is open keeps it.
  document.addEventListener('paste', (e) => {
    if (!stuffShown() || e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    const list = [...(e.clipboardData?.files || [])];
    if (!list.length) return;
    e.preventDefault();
    addFiles(list.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
  });
  return { node, cards: new Map(), sections: new Map() };
}

function itemOf(target) {
  const card = target.closest('.st-card');
  return card && all().find((x) => x.id === card.dataset.id);
}

function onClick(e) {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'close') return goBack();
  if (a === 'add') return $('.sf-file', view.node).click();
  if (a === 'kind') {
    kind = e.target.closest('[data-k]').dataset.k;
    save('wisp.stuffKind', kind);
    return paintStuff();
  }
  if (a === 'starred') return (starred = !starred), paintStuff();
  if (a === 'layout') {
    viewPick = e.target.closest('[data-v]').dataset.v;
    save('wisp.stuffView', viewPick);
    return paintStuff();
  }
  if (a === 'group') {
    groupPick = grouping() === 'time' ? 'task' : 'time';
    save('wisp.stuffGroup', groupPick);
    return paintStuff();
  }
  if (a === 'clear') {
    query = '';
    $('.sf-q', view.node).value = '';
    kind = 'all';
    starred = false;
    save('wisp.stuffKind', kind);
    return paintStuff();
  }
  if (a === 'open-task') return revealTask(e.target.closest('[data-task]').dataset.task);
  const it = itemOf(e.target);
  if (!it || it.pending) return;
  if (a === 'more') {
    const r = e.target.closest('button').getBoundingClientRect();
    return itemMenu(it, { x: r.right - 200, y: r.bottom + 4 }, e.target.closest('button'));
  }
  if (a === 'from') return revealTask(it.from.session);
  if (a) return act(a, it, e.target.closest('button'));
  if (!e.target.closest('button, a, input')) openItem(it);
}

function onKey(e) {
  if (e.target.closest('input, textarea')) return;
  const it = itemOf(e.target);
  if (!it || !e.target.classList.contains('st-card')) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openItem(it);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const next = e.target.nextElementSibling || e.target.previousElementSibling;
    removeItem(it);
    next?.focus?.();
  } else if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    patch(it, { starred: !it.starred });
  } else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    // Through the cards in reading order; up and down by a row of the grid.
    e.preventDefault();
    const cards = $$('.st-card', view.node);
    const i = cards.indexOf(e.target);
    const cols = layout() === 'list' ? 1 : Math.max(1, Math.round(e.target.parentNode.clientWidth / e.target.offsetWidth));
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    const to = cards[Math.max(0, Math.min(cards.length - 1, i + step))];
    if (e.key === 'ArrowUp' && i < cols) return $('.sf-q', view.node).focus();
    to?.focus();
  }
}

// '/' searches while the page is open (keys.js leaves it to us then).
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || !stuffShown() || e.metaKey || e.ctrlKey || e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  $('.stuff-view .sf-q')?.focus();
}, true);

export function paintStuff() {
  // Something else took the pane (a task, a member, the Org page): the page goes.
  if (S.stuffOpen && isSplit() && (splitOpen() || S.crewOpen || S.orgOpen || S.planOpen)) leaveStuff();
  paintButton();
  if (!stuffShown()) {
    if (view) view.node.hidden = true;
    return;
  }
  view ||= build();
  const { node } = view;
  if (node.parentNode !== $('#splitMain')) $('#splitMain').append(node);
  node.hidden = false;
  node.classList.toggle('list', layout() === 'list');
  const w = Number(spellProp('stuff.page', 'cardWidth'));
  node.style.setProperty('--st-w', w >= 160 && w <= 1600 ? `${w}px` : '');
  paintTop();
  paintKinds();
  paintOpts();
  paintBody();
}

// The box beside New task: pressed while the page is open.
function paintButton() {
  const b = $('#splitStuff');
  if (!b) return;
  b.classList.toggle('on', stuffShown());
  b.setAttribute('aria-pressed', stuffShown());
}

function setHtml(node, html) {
  if (node.dataset.h !== html) (node.innerHTML = html), (node.dataset.h = html);
}

function paintTop() {
  const list = all();
  const bytes = list.reduce((n, x) => n + (x.size || 0), 0);
  const stacked = isStacked();
  const sub = list.length ? `${list.length} thing${list.length > 1 ? 's' : ''}${bytes ? ` · ${fmtSize(bytes)}` : ''}` : '';
  setHtml(
    $('.stuff-top', view.node),
    `${stacked ? `<button class="icon-btn sh-back" data-a="close" title="Back to tasks" aria-label="Back to tasks">${icon('back')}</button>` : ''}
    <span class="org-ic sf-ic">${icon('stuff')}</span>
    <div class="cv-who"><h2 class="sh-title">My Stuff</h2><span class="cv-role">What you and your agents kept</span></div>
    <span class="cv-state">${esc(sub)}</span>
    <span class="sh-acts">
      ${slotHtml('stuff.head', null)}
      <button class="ghost sm sf-add" data-a="add" title="Add files from this computer (or drop them here)">${icon('plus')}<span>Add files</span></button>
      ${stacked ? '' : `<button class="icon-btn" data-a="close" title="Close: back to New task (Esc)" aria-label="Close">${icon('x')}</button>`}
    </span>`,
  );
}

// All, then each kind there's something of, with how many match the words.
function paintKinds() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const base = all().filter((x) => (!starred || x.starred) && matches(x, words));
  const n = (k) => base.filter((x) => x.kind === k).length;
  const have = KINDS.filter((k) => all().some((x) => x.kind === k.id));
  if (kind !== 'all' && !have.some((k) => k.id === kind)) kind = 'all';
  const chip = (id, label, count, ic) => `<button role="tab" class="sf-kind ${kind === id ? 'on' : ''}" data-a="kind" data-k="${id}" aria-selected="${kind === id}">${ic ? icon(ic) : ''}<span>${label}</span><i>${count}</i></button>`;
  setHtml($('.sf-kinds', view.node), have.length > 1 || kind !== 'all' ? chip('all', 'All', base.length) + have.map((k) => chip(k.id, k.label, n(k.id), k.icon)).join('') : '');
}

function paintOpts() {
  const any = all().some((x) => x.starred);
  const v = layout();
  setHtml(
    $('.sf-opts', view.node),
    `${any || starred ? `<button class="sf-opt sf-star ${starred ? 'on' : ''}" data-a="starred" aria-pressed="${starred}" title="Only starred">${icon('star')}<span>Starred</span></button>` : ''}
    <button class="sf-opt" data-a="group" title="Group by ${grouping() === 'time' ? 'the task each came from' : 'when you kept it'}">${icon(grouping() === 'time' ? 'clock' : 'agent')}<span>${grouping() === 'time' ? 'By time' : 'By task'}</span></button>
    <span class="sf-seg" role="group" aria-label="Layout"><button class="${v === 'grid' ? 'on' : ''}" data-a="layout" data-v="grid" aria-pressed="${v === 'grid'}" title="Grid of previews">${icon('grid')}</button><button class="${v === 'list' ? 'on' : ''}" data-a="layout" data-v="list" aria-pressed="${v === 'list'}" title="List">${icon('menu')}</button></span>`,
  );
}

function paintBody() {
  const { node } = view;
  const box = $('.sf-groups', node);
  const empty = $('.sf-empty', node);
  // Never loaded here: the page's shape, quiet, until the list comes.
  if (S.stuff === null) {
    empty.hidden = true;
    setHtml(box, `<section class="sf-group"><h3 class="sf-head"><i class="sk sk-line short"></i></h3><div class="sf-grid">${'<div class="st-card skel"><div class="st-thumb"></div><div class="st-meta"><i class="sk sk-line"></i><i class="sk sk-line short"></i></div></div>'.repeat(6)}</div></section>`);
    return;
  }
  if (box.dataset.h) (box.innerHTML = ''), delete box.dataset.h; // the placeholders go
  const list = shownItems();
  node.classList.toggle('blank', !all().length);
  empty.hidden = !!list.length;
  if (!list.length) setHtml(empty, all().length ? emptySearch() : emptyShelf());
  const gs = list.length ? groups(list) : [];
  // Sections and cards stay in place across repaints; only what changed is touched or moved.
  const keepS = new Set(gs.map((g) => g.key));
  for (const [k, sec] of view.sections) if (!keepS.has(k)) (sec.remove(), view.sections.delete(k));
  const keepC = new Set(list.map((x) => x.id));
  for (const [id, c] of view.cards) if (!keepC.has(id)) (c.remove(), view.cards.delete(id));
  gs.forEach((g, i) => {
    let sec = view.sections.get(g.key);
    if (!sec) view.sections.set(g.key, (sec = el(`<section class="sf-group"><h3 class="sf-head"></h3><div class="sf-grid"></div></section>`)));
    setHtml($('.sf-head', sec), `<span>${esc(g.label)}</span><i>${g.items.length}</i>${g.task ? `<button class="link sf-task" data-a="open-task" data-task="${esc(g.task)}">Open the task${icon('arrow')}</button>` : ''}`);
    if (box.children[i] !== sec) box.insertBefore(sec, box.children[i] || null);
    const grid = $('.sf-grid', sec);
    g.items.forEach((it, j) => {
      let card = view.cards.get(it.id);
      if (!card) {
        card = el(`<article class="st-card" tabindex="0"></article>`);
        view.cards.set(it.id, card);
      }
      paintCard(card, it);
      if (grid.children[j] !== card) grid.insertBefore(card, grid.children[j] || null);
    });
    while (grid.children.length > g.items.length) grid.lastElementChild.remove();
  });
}

function paintCard(card, it) {
  const cls = `st-card k-${it.kind}${it.pending ? ' pending' : ''}${it.starred ? ' starred' : ''}`;
  if (card.className !== cls) card.className = cls;
  card.dataset.id = it.id;
  const k = KIND[it.kind] || KIND.file;
  const task = it.from?.session && S.sessions.get(it.from.session);
  const fromTitle = task?.title || it.from?.title;
  const meta = [k.one + (it.lang ? ` · ${it.lang}` : it.kind === 'file' || it.kind === 'doc' ? (ext(it) ? ` · ${ext(it)}` : '') : ''), it.files ? `${it.files} file${it.files === 1 ? '' : 's'}` : '', it.size ? fmtSize(it.size) : '', it.kind === 'link' ? it.name : ''].filter(Boolean);
  // Updated since it was kept (an agent's wisp_save with its id): which version, and when.
  const ver = it.rev > 1 ? `<i class="st-v" title="Updated ${esc(fmtDate(it.updatedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}${it.prev ? ': the version before is kept (⋯ → Restore)' : ''}">v${it.rev}</i>` : '';
  const tools = it.pending
    ? ''
    : `<div class="st-tools">
        ${canCopy(it) ? `<button class="st-copy" data-a="copy" title="${it.kind === 'link' ? 'Copy link' : 'Copy'}" aria-label="Copy">${icon('copy')}</button>` : ''}
        ${it.kind !== 'link' && it.kind !== 'app' && !MOBILE ? `<button data-a="download" title="Download" aria-label="Download">${icon('download')}</button>` : ''}
        <button class="st-more" data-a="more" title="More" aria-label="More" aria-haspopup="menu">${icon('dots')}</button>
        <button class="st-star ${it.starred ? 'on' : ''}" data-a="star" title="${it.starred ? 'Unstar (S)' : 'Star (S)'}" aria-label="${it.starred ? 'Unstar' : 'Star'}" aria-pressed="${!!it.starred}">${icon('star')}</button>
      </div>`;
  const html = `
    <div class="st-thumb">${thumb(it)}${it.kind === 'app' && !it.pending ? launchBtn(it) : ''}${it.by === 'agent' ? `<span class="st-by" title="Saved by an agent">${icon('spark')}</span>` : ''}${it.pending ? '<span class="st-saving"><i></i></span>' : ''}</div>
    ${tools}
    <div class="st-meta">
      <b class="st-title" title="${esc(it.title)}">${esc(it.title)}</b>
      <span class="st-sub">${icon(k.icon)}<span>${esc(meta.join(' · '))}</span>${ver}${pubPill(it)}<time title="${esc(fmtDate(it.at, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}">${esc(when(it.at))}</time></span>
      ${it.note ? `<span class="st-note">${esc(it.note)}</span>` : ''}
      ${it.tags?.length ? `<span class="st-tags">${it.tags.map((t) => `<i>#${esc(t)}</i>`).join('')}</span>` : ''}
      ${fromTitle && grouping() !== 'task' ? `<button class="st-from" data-a="${task ? 'from' : ''}" ${task ? '' : 'disabled'} title="${task ? 'Open the task it came from' : 'The task it came from is gone'}">${icon('agent')}<span>${esc(fromTitle)}</span></button>` : ''}
    </div>`;
  setHtml(card, html);
  card.setAttribute('aria-label', `${k.one}: ${it.title}`);
}

// Published (or on its way): the pill copies the link. Behind: the grid has an older version.
const pubPill = (it) =>
  it.publishing
    ? `<i class="st-pub busy">${icon('web')}<span>Publishing…</span></i>`
    : it.published
      ? `<button class="st-pub${behind(it) ? ' old' : ''}" data-a="pubcopy" title="${behind(it) ? `Public at ${esc(bare(it.published.url))}, with an older version (⋯ → Update public link). Copy the link` : `Public at ${esc(bare(it.published.url))}: copy the link`}">${icon('web')}<span>Public</span></button>`
      : '';

const when = (t) => {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtDate(t, { hour: '2-digit', minute: '2-digit' });
  return fmtDate(t, d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
};

// What a card shows of the thing itself: the picture, the video's first frame, a doc's opening as a
// page, a snippet's first lines, a link's site, else a label of the file's type.
function thumb(it) {
  const glyph = it.kind === 'image' || it.kind === 'video' ? '' : `<span class="st-glyph">${icon(KIND[it.kind]?.icon || 'clip')}</span>`;
  return glyph + thumbBody(it);
}

// An app's main action, on its preview: Launch, or Open while it runs.
const launchBtn = (it) =>
  it.running
    ? `<button class="st-launch on" data-a="launch" title="It’s running: open it again">${it.running.port ? '<i class="st-dot"></i>' : ''}<span>${it.running.port ? 'Running' : 'Starting…'}</span>${icon('expand')}</button>`
    : `<button class="st-launch" data-a="launch" title="Launch it in wisp">${icon('play')}<span>Launch</span></button>`;

function thumbBody(it) {
  // An app: its picture (the agent's screenshot) in a window, else its initial and what it is.
  if (it.kind === 'app')
    return `<div class="st-win"><div class="st-win-bar"><i></i><i></i><i></i><span>${esc(it.name || 'app')}</span></div>${
      it.cover ? `<img src="${coverUrl(it)}" alt="" loading="lazy" decoding="async" draggable="false">` : `<div class="st-win-body"><b>${esc((it.title || '?').trim()[0]?.toUpperCase() || '?')}</b>${it.excerpt ? `<span>${esc(it.excerpt)}</span>` : ''}</div>`
    }</div>`;
  if (it.pending && it.kind !== 'doc' && it.kind !== 'code') return `<div class="st-ph">${icon(KIND[it.kind]?.icon || 'clip')}</div>`;
  if (it.kind === 'image') return `<img src="${fileUrl(it)}" alt="" loading="lazy" decoding="async" draggable="false">`;
  if (it.kind === 'video') return `<video src="${fileUrl(it)}#t=0.1" preload="metadata" muted playsinline loop></video><span class="st-play">${icon('play')}</span>`;
  if (it.kind === 'doc' && texty(it)) return `<div class="st-paper"><div class="prose">${md(it.excerpt.slice(0, 700))}</div></div>`;
  if (it.kind === 'code' && texty(it)) {
    const lang = it.lang || ext(it).toLowerCase();
    return `<pre class="st-code"><code>${it.excerpt.split('\n').slice(0, 14).map((l) => highlight(l, lang) || ' ').join('\n')}</code></pre><span class="st-lang">${esc(lang || 'text')}</span>`;
  }
  if (it.kind === 'link') {
    let path = '';
    try {
      const u = new URL(it.url);
      path = (u.pathname + u.search).replace(/^\/$/, '');
    } catch {}
    return `<div class="st-link">${icon('web')}<b>${esc(it.name)}</b>${path ? `<span>${esc(path)}</span>` : ''}</div>`;
  }
  return `<div class="st-ext">${icon('file')}<b>${esc(ext(it) || 'FILE')}</b></div>`;
}

function emptyShelf() {
  return `<div class="sf-shelf" aria-hidden="true">
      <span class="sf-tile t1">${icon('image')}</span><span class="sf-tile t2"><i></i><i></i><i></i><i class="short"></i></span><span class="sf-tile t3">${icon('terminal')}</span>
    </div>
    <h3>Keep what your agents make</h3>
    <p>Hover a picture, video, doc or code in a reply and press ${icon('stuff')} to keep it here, or ask an agent: <q>save that to my stuff</q>. Agents can build you apps too, <q>make me slides on …</q>, that launch from here.</p>
    <p>Type <b>@</b> in any prompt to hand an agent something you kept.</p>
    <p class="sf-or">${MOBILE ? '' : 'Drop files here, paste a screenshot, or '}<button class="link" data-a="add">add files</button>.</p>`;
}

function emptySearch() {
  const what = [query && `“${esc(query)}”`, kind !== 'all' && KIND[kind]?.label.toLowerCase(), starred && 'starred'].filter(Boolean).join(', ');
  return `<p class="sf-none">${icon('search')}Nothing in My Stuff matches ${what}.</p><button class="ghost sm" data-a="clear">Show everything</button>`;
}

// A spell's props (view, group, cardWidth) and its stuff.head buttons.
bus.on('spells', () => paintStuff());
