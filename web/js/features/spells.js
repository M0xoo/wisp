// Spells on the page: what every spell that's on adds to wisp, changes in it or hides, applied
// from S.config.spells (GET /config) each time the config loads. Spells name slots and parts from
// spell-schema.js; this file maps them onto wisp's markup, so a spell never touches the DOM.
//
// Spell code (a spell's `script`) runs only in a sandboxed iframe with no network, no DOM and no
// wisp API: it gets the data wisp fetched for it and returns values. Blocks it returns are checked
// and drawn by wisp's own renderer.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { renderPresentation, setBlockFallback } from '../blocks.js';
import { draftInto, sendReply } from './composer.js';
import { CARD_HEAD_ORDER, PARTS, fillTemplate, scriptBody, whenMatches } from '../spell-schema.js';

// --- which spells apply ----------------------------------------------------------------------

let trying = null; // { spell, session }: a spell being tried in this window only (Try it)

export function activeSpells() {
  const on = (S.config.spells || []).filter((s) => s.id !== trying?.spell.id);
  return trying ? [...on, trying.spell] : on;
}
const spellById = (id) => activeSpells().find((s) => s.id === id) || null;
const summaryOf = (id) => (id ? S.sessions.get(id) || null : null);
// What {field} templates read: the task's summary, plus anything the caller adds ({args}).
const tplCtx = (session, extra = {}) => ({ ...(session || {}), ...extra });

// --- the sandbox -----------------------------------------------------------------------------

const SANDBOX_HTML = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"><script>
let fns = null;
const reply = (m) => parent.postMessage(m, '*');
addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    try { fns = new Function(m.body)() || {}; reply({ type: 'loaded', ok: true }); }
    catch (x) { reply({ type: 'loaded', ok: false, error: String((x && x.message) || x) }); }
  } else if (m.type === 'call') {
    Promise.resolve()
      .then(() => { const f = fns && fns[m.fn]; if (typeof f !== 'function') throw new Error('the script has no function ' + m.fn); return f(...m.args); })
      .then((v) => reply({ type: 'result', id: m.id, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }), (x) => reply({ type: 'result', id: m.id, error: String((x && x.message) || x) }));
  }
});
reply({ type: 'ready' });
<\/script>`;

const frames = new Map(); // spell id -> { frame, script, ready, pending, seq, fails }
const CALL_MS = 3000;

window.addEventListener('message', (e) => {
  for (const f of frames.values()) {
    if (e.source !== f.frame.contentWindow) continue;
    const m = e.data || {};
    if (m.type === 'ready') f.onReady?.();
    else if (m.type === 'loaded') f.onLoaded?.(m);
    else if (m.type === 'result') f.pending.get(m.id)?.(m);
    return;
  }
});

function sandbox(spell) {
  const have = frames.get(spell.id);
  if (have && have.script === spell.script) return have;
  have?.frame.remove();
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.className = 'sp-sandbox';
  const f = { frame, script: spell.script, pending: new Map(), seq: 0, fails: 0 };
  f.ready = new Promise((resolve, reject) => {
    f.onReady = () => frame.contentWindow.postMessage({ type: 'load', body: scriptBody(spell.script || '') }, '*');
    f.onLoaded = (m) => (m.ok ? resolve() : reject(new Error(`${spell.name}: ${m.error}`)));
    setTimeout(() => reject(new Error(`${spell.name}: its script didn't load`)), 5000);
  });
  f.ready.catch(() => {});
  frame.srcdoc = SANDBOX_HTML;
  document.body.append(frame);
  frames.set(spell.id, f);
  return f;
}

// Call one of a spell's script functions with JSON arguments. Resolves with what it returned.
export async function callSpell(spell, fn, args = []) {
  const f = sandbox(spell);
  await f.ready;
  const id = ++f.seq;
  try {
    const out = await new Promise((resolve, reject) => {
      const t = setTimeout(() => (f.pending.delete(id), reject(new Error(`${spell.name}: ${fn}() took longer than ${CALL_MS / 1000}s`))), CALL_MS);
      f.pending.set(id, (m) => (clearTimeout(t), f.pending.delete(id), m.error ? reject(new Error(`${spell.name}: ${fn}(): ${m.error}`)) : resolve(m.value)));
      f.frame.contentWindow.postMessage({ type: 'call', id, fn, args: JSON.parse(JSON.stringify(args)) }, '*');
    });
    f.fails = 0;
    return out;
  } catch (err) {
    // A spell that keeps failing goes off (or stops being tried) so it can't keep the page busy.
    if (++f.fails >= 3) {
      f.fails = 0;
      if (trying?.spell.id === spell.id) undoTry();
      else if ((S.config.spells || []).some((s) => s.id === spell.id)) {
        api(`/spells/${spell.id}`, { method: 'PATCH', body: { enabled: false } }).catch(() => {});
        toast(`Turned the spell <b>${esc(spell.name)}</b> off: it kept failing (${esc(err.message)})`, { tone: 'bad', timeout: 9000 });
      }
    }
    throw err;
  }
}

// What a script may return as blocks: the built-in ones that only show things, and apps (a page
// run sandboxed, app-frame.js). Links in actions become markdown links; images, questions and
// follow-up buttons are dropped.
const SHOW_BLOCKS = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tree', 'code', 'compare', 'flow', 'chart', 'checklist', 'callout', 'terminal', 'tests', 'commits', 'map']);
export function cleanBlocks(v) {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  if (JSON.stringify(list).length > 200_000) return [{ type: 'callout', tone: 'warn', title: 'Too much to show', text: 'The spell returned more than 200 KB.' }];
  const out = [];
  for (const b of list.slice(0, 60)) {
    if (!b || typeof b !== 'object' || typeof b.type !== 'string') continue;
    if (b.type === 'actions') {
      const links = (b.items || []).filter((x) => x && /^https?:\/\//i.test(x.url || '')).map((x) => `- [${String(x.label || x.url).replace(/[[\]]/g, '')}](${String(x.url).replace(/[()\s]/g, encodeURIComponent)})`);
      if (links.length) out.push({ type: 'markdown', text: `${b.title ? `**${b.title}**\n\n` : ''}${links.join('\n')}` });
    } else if (b.type === 'markdown') out.push({ type: 'markdown', text: String(b.text || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '') });
    else if (b.type === 'app') out.push({ type: 'app', title: String(b.title || ''), html: String(b.html || ''), height: Number(b.height) || undefined, fallback: cleanBlocks(b.fallback).filter((x) => x.type !== 'app') });
    else if (SHOW_BLOCKS.has(b.type)) out.push({ ...b, type: b.type });
  }
  return out;
}

// The context blocks a spell returns render with: nothing to reply to or run. An app in them can
// still offer text to the task it's drawn for (reply, draft), and says which spell drew it.
const showCtx = { delay: 0, turn: null, session: null, isLatest: false, fileUrl: () => '', zoom: () => {}, reply: () => {}, draft: () => {} };
export const drawBlocks = (blocks, ctx = {}) => renderPresentation({ blocks: cleanBlocks(blocks) }, { ...showCtx, reply: null, draft: null, ...ctx });
const taskCtx = (spell, sessionId) => ({
  spell: spell.name,
  ...(sessionId && { session: S.sessions.get(sessionId) || null, reply: (text) => sendReply(sessionId, text), draft: (text) => draftInto(sessionId, text) }),
});

// --- data ------------------------------------------------------------------------------------

const dataCache = new Map(); // `${spell}:${name}:${session}` -> { at, value, p }

async function dataOne(spell, name, sessionId) {
  const src = spell.data?.[name];
  if (!src) throw new Error(`${spell.name} has no data source ${name}`);
  const perTask = sessionId && (src.cwd === 'task' || (src.gh || []).some((a) => a.includes('{')) || String(src.wisp || '').includes('{'));
  const key = `${spell.id}:${name}:${perTask ? sessionId : ''}`;
  const hit = dataCache.get(key);
  if (hit && Date.now() - hit.at < (src.refresh || 60) * 1000) return hit.p;
  // A spell being tried isn't installed yet: its sources go through try-data, which checks it first.
  const installed = (S.config.spells || []).some((x) => x.id === spell.id && JSON.stringify(x.data) === JSON.stringify(spell.data));
  const session = perTask ? sessionId : undefined;
  const p = (installed ? api(`/spells/${spell.id}/data/${name}`, { method: 'POST', body: { session } }) : api('/spells/try-data', { method: 'POST', body: { spell, name, session } })).then((r) => r.value);
  dataCache.set(key, { at: Date.now(), p });
  p.catch(() => dataCache.delete(key));
  return p;
}

export async function spellData(spell, names = [], sessionId = null) {
  const out = {};
  await Promise.all(names.map(async (n) => (out[n] = await dataOne(spell, n, sessionId))));
  return out;
}
const countOf = (v) => (Array.isArray(v) ? v.length : Array.isArray(v?.items) ? v.items.length : typeof v?.total_count === 'number' ? v.total_count : v ? 1 : 0);
const allData = (spell) => Object.keys(spell.data || {});

// --- actions ---------------------------------------------------------------------------------

const httpOnly = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : '');

async function confirmExec(spell, command) {
  const key = `wisp.spellExec.${spell.id}`;
  const ok = JSON.parse(localStorage.getItem(key) || '[]');
  if (ok.includes(command)) return true;
  return new Promise((resolve) => {
    const node = el(`
      <form class="modal sp-confirm">
        <header><h2>${icon('terminal')} Run this command?</h2><button type="button" class="icon-btn close">${icon('x')}</button></header>
        <p>The spell <b>${esc(spell.name)}</b> wants to run this in the task's folder:</p>
        <pre class="code"><code>$ ${esc(command)}</code></pre>
        <footer><button type="button" class="ghost" data-a="no">Cancel</button><button class="primary" type="submit">Run it</button></footer>
      </form>`);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const close = overlay(node, { onClose: () => finish(false) });
    $('.close', node).onclick = () => {
      finish(false);
    };
    $('[data-a="no"]', node).onclick = () => {
      finish(false);
    };
    node.onsubmit = (e) => {
      e.preventDefault();
      localStorage.setItem(key, JSON.stringify([...ok, command]));
      finish(true);
    };
  });
}

// Put text into a box at its caret (the prompt box when there's no box in reach).
function insertInto(ta, text) {
  if (!ta) return;
  const at = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, at) + text + ta.value.slice(ta.selectionEnd ?? at);
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  ta.setSelectionRange(at + text.length, at + text.length);
}

// ctx: { session: id of the card's task, input: the box the click came from, args: what followed a /command }
export async function runAction(spell, action, ctx = {}) {
  if (!action) return;
  const [k, v] = Object.entries(action)[0];
  const s = summaryOf(ctx.session);
  const fill = (t) => fillTemplate(t, tplCtx(s, { args: ctx.args || '' }));
  const need = () => {
    if (!s) throw new Error('This works on a task: use it from a card, or focus one first.');
    return s;
  };
  const m = await import('./spell-actions.js');
  try {
    switch (k) {
      case 'open': {
        const url = httpOnly(fill(v));
        if (!url) throw new Error(`Not a link: ${fill(v) || '(empty)'}`);
        window.open(url, '_blank', 'noopener');
        return;
      }
      case 'openAll': {
        let urls;
        if (v.data) {
          const value = (await spellData(spell, [v.data], ctx.session))[v.data];
          urls = (Array.isArray(value) ? value : value?.items || []).map((x) => (typeof x === 'string' ? x : x?.[v.field || 'url']));
        } else {
          // A function's links count only when they're in the spell's own data (so a script can't
          // put what it read into a link of its own).
          const data = await spellData(spell, v.data?.length ? v.data : allData(spell), ctx.session);
          const seen = JSON.stringify(data);
          urls = ((await callSpell(spell, v.fn, [data, { session: s }])) || []).filter((u) => typeof u === 'string' && seen.includes(JSON.stringify(u).slice(1, -1)));
        }
        urls = [...new Set(urls.map(String).filter(httpOnly))];
        if (!urls.length) return toast(`${esc(spell.name)}: nothing to open`);
        const { opened } = await api('/open', { method: 'POST', body: { urls } });
        return toast(`Opened ${opened.length} link${opened.length === 1 ? '' : 's'}${urls.length > opened.length ? ` (the first ${opened.length} of ${urls.length})` : ''}`);
      }
      case 'panel':
        return openPanel(spell, v, ctx);
      case 'insert':
        return insertInto(ctx.input || (s && $('.reply', S.nodes.get(s.id)?.card)) || $('#prompt'), fill(v));
      case 'copy':
        await navigator.clipboard.writeText(fill(v));
        return toast('Copied');
      case 'toast':
      case 'notify':
        return toast(esc(fill(v)));
      case 'setLaunch':
        return $('#launcher')?.spellSet?.(v);
      case 'launchWith':
        return $('#launcher')?.spellLaunch?.({ ...v, text: v.text ? fill(v.text) : '' });
      case 'send':
      case 'reply':
        return m.sendTo(need().id, fill(v));
      case 'launch':
        return m.launchTask({ ...v, prompt: fill(v.prompt), cwd: v.cwd ? fill(v.cwd) : '' }, s);
      case 'rerun':
        return m.rerunOn(need(), { ...v, prompt: v.prompt ? fill(v.prompt) : '' });
      case 'fork':
        return m.forkOn(need(), { ...v, prompt: fill(v.prompt) });
      case 'recipe':
        return m.recipe(fill(v));
      case 'ship':
        return m.ship(need().id);
      case 'done':
        return m.done(need().id);
      case 'archive':
        return m.archive(need().id);
      case 'forLater':
        return m.forLater(need().id);
      case 'exec': {
        const command = fill(v);
        if (!(await confirmExec(spell, command))) return;
        return m.exec(need().id, command);
      }
      case 'webhook':
        throw new Error('Webhooks run from hooks, not buttons.');
    }
  } catch (err) {
    toastError(err);
  }
}

// --- panels ----------------------------------------------------------------------------------

async function panelBlocks(spell, panel, sessionId) {
  const data = await spellData(spell, panel.data || [], sessionId);
  return cleanBlocks(await callSpell(spell, panel.render, [data, { session: summaryOf(sessionId) }]));
}

// Fill `host` with the panel; unchanged blocks keep their nodes (no replayed animations).
async function paintPanel(host, spell, panel, sessionId) {
  try {
    const blocks = await panelBlocks(spell, panel, sessionId);
    const sig = JSON.stringify(blocks);
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.replaceChildren(blocks.length ? drawBlocks(blocks, taskCtx(spell, sessionId)) : el('<p class="sp-empty">Nothing to show.</p>'));
  } catch (err) {
    host.dataset.sig = '';
    host.replaceChildren(el(`<div class="sp-error">${icon('warn')}<span>${esc(err.message)}</span></div>`));
  }
}

export function openPanel(spell, panelId, ctx = {}) {
  const panel = (spell.panels || []).find((p) => p.id === panelId);
  if (!panel) return toast(`${esc(spell.name)} has no panel ${esc(panelId)}`, { tone: 'bad' });
  const node = el(`
    <div class="modal sp-panel ${panel.as === 'drawer' ? 'sp-drawer' : ''}" data-spell="${esc(spell.id)}">
      <header><h2>${panel.icon ? icon(panel.icon) : ''}${esc(panel.title || spell.name)}</h2><span class="sp-by" title="From the spell ${esc(spell.name)}">${icon('wizard')}${esc(spell.name)}</span><button class="icon-btn sp-refresh" title="Refresh">${icon('replay')}</button><button class="icon-btn close">${icon('x')}</button></header>
      <div class="sp-panel-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>
    </div>`);
  const body = $('.sp-panel-body', node);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const paint = () => {
    paintPanel(body, spell, panel, ctx.session);
  };
  $('.sp-refresh', node).onclick = () => {
    for (const k of [...dataCache.keys()]) if (k.startsWith(`${spell.id}:`)) dataCache.delete(k);
    paint();
  };
  paint();
  if (panel.refresh?.every) {
    const t = setInterval(() => (node.isConnected ? paint() : clearInterval(t)), panel.refresh.every * 1000);
  }
  for (const ev of panel.refresh?.on || []) bus.on(`spell:${ev}`, paint, { node });
}

// --- slots: the HTML for each place, and one click handler for all of them ---------------------

const items = (slot, session) =>
  activeSpells().flatMap((spell) =>
    [...(spell.buttons || []).map((b, i) => ({ spell, b, kind: 'buttons', i })), ...(spell.chips || []).map((b, i) => ({ spell, b, kind: 'chips', i }))].filter(({ b }) => b.slot === slot && (!session || whenMatches(b.when, session)) && (session || !b.when)),
  );

const badgeCache = new Map(); // `${spell}:${kind}:${i}:${session}` -> text, filled asynchronously

function badgeOf(spell, b, kind, i, session) {
  const badge = b.badge;
  if (!badge) return '';
  if (badge.text) return fillTemplate(badge.text, tplCtx(session));
  const key = `${spell.id}:${kind}:${i}:${session?.id || ''}`;
  if (!badgeCache.has(key)) {
    badgeCache.set(key, '');
    const p = badge.count ? spellData(spell, [badge.count], session?.id).then((d) => String(countOf(d[badge.count]) || '')) : spellData(spell, badge.data?.length ? badge.data : allData(spell), session?.id).then((d) => callSpell(spell, badge.fn, [d, { session }])).then((v) => (v === null || v === undefined ? '' : String(v).slice(0, 12)));
    p.then((text) => {
      badgeCache.set(key, text);
      for (const n of $$(`[data-badge="${CSS.escape(key)}"]`)) {
        n.textContent = text;
        n.hidden = !text;
      }
    }).catch(() => {});
  }
  return badgeCache.get(key);
}

const chipCache = new Map();
function chipText(spell, c, i, session) {
  if (!c.fn) return fillTemplate(c.text, tplCtx(session));
  const key = `${spell.id}:chip:${i}:${session?.id || ''}:${session?.updatedAt || ''}`;
  if (!chipCache.has(key)) {
    chipCache.set(key, chipCache.get(`${spell.id}:chip:${i}:${session?.id || ''}:last`) || '');
    spellData(spell, c.data?.length ? c.data : allData(spell), session?.id)
      .then((d) => callSpell(spell, c.fn, [d, { session }]))
      .then((v) => {
        const text = v === null || v === undefined ? '' : String(v).slice(0, 60);
        chipCache.set(key, text);
        chipCache.set(`${spell.id}:chip:${i}:${session?.id || ''}:last`, text);
        for (const n of $$(`[data-chip="${CSS.escape(`${spell.id}:${i}:${session?.id || ''}`)}"]`)) {
          $('.sp-t', n).textContent = text;
          n.hidden = !text;
        }
      })
      .catch(() => {});
  }
  return chipCache.get(key);
}

const attrs = (spell, kind, i, extra = '') => `data-sp="${esc(spell.id)}" data-spk="${kind}" data-spi="${i}" ${extra}`;
const tip = (spell, b) => esc(`${b.title || b.label || ''}${b.title || b.label ? ' · ' : ''}spell: ${spell.name}`);

// The markup of one slot. session: the card's task summary, for card slots.
export function slotHtml(slot, session = null) {
  const list = items(slot, session);
  if (!list.length) return '';
  return list
    .map(({ spell, b, kind, i }) => {
      if (kind === 'chips') {
        const text = chipText(spell, b, i, session);
        const k = `${spell.id}:${i}:${session?.id || ''}`;
        const tag = b.do ? 'button' : 'span';
        return `<${tag} class="sp-chip tone-${b.tone}" ${attrs(spell, kind, i, `data-chip="${esc(k)}"`)} title="${tip(spell, b)}" ${text ? '' : 'hidden'}>${b.icon ? icon(b.icon) : ''}<span class="sp-t">${esc(text)}</span></${tag}>`;
      }
      const badge = badgeOf(spell, b, kind, i, session);
      const bkey = `${spell.id}:${kind}:${i}:${session?.id || ''}`;
      const n = b.badge ? `<b class="sp-n" data-badge="${esc(bkey)}" ${badge ? '' : 'hidden'}>${esc(badge)}</b>` : '';
      const label = b.label ? `<span>${esc(b.label)}</span>` : '';
      const ic = b.icon ? icon(b.icon) : '';
      switch (slot) {
        case 'topbar':
          return `<button class="auto-btn sp-btn" ${attrs(spell, kind, i)} title="${tip(spell, b)}">${ic || icon('wizard')}${label}${n}</button>`;
        case 'float':
          return `<button class="sp-fab${b.primary ? ' primary' : ''}" ${attrs(spell, kind, i)} title="${tip(spell, b)}" aria-label="${esc(b.label || b.icon)}">${ic || icon('wizard')}${b.label ? `<span class="sp-fab-l">${esc(b.label)}</span>` : ''}${n}</button>`;
        case 'card.hover':
          return `<button class="it-quick sp-quick" ${attrs(spell, kind, i)} title="${tip(spell, b)}" aria-label="${esc(b.label || b.icon)}">${ic || icon('wizard')}</button>`;
        case 'launcher.chips':
        case 'composer.chips':
          return `<button type="button" class="sp-qr" ${attrs(spell, kind, i)} title="${tip(spell, b)}">${ic}${label || esc(b.icon)}${n}</button>`;
        default:
          return `<button type="button" class="ghost sm sp-btn${ic ? ' has-i' : ''}" ${attrs(spell, kind, i)} title="${tip(spell, b)}">${ic}${label}${n}</button>`;
      }
    })
    .join('');
}

// Every spell element on the page answers here: the card it's in is the task it works on.
document.addEventListener(
  'click',
  (e) => {
    const n = e.target.closest?.('[data-sp]');
    if (!n || n.closest('.sp-preview')) return;
    const spell = spellById(n.dataset.sp);
    const item = spell?.[n.dataset.spk]?.[Number(n.dataset.spi)];
    if (!item?.do) return;
    e.preventDefault();
    e.stopPropagation();
    const card = n.closest('.item[data-id], #splitHead[data-id], #term[data-id], #sidePanel[data-id]');
    const input = n.closest('.composer')?.querySelector('.reply') || n.closest('#launcher')?.querySelector('#prompt') || null;
    n.closest('.menu')?.close?.();
    runAction(spell, item.do, { session: card?.dataset.id || n.dataset.task || (n.closest('.sp-float, #topbar') ? null : S.focus), input });
  },
  true,
);

// A floating group opens and closes on its own button.
document.addEventListener('click', (e) => {
  const fan = e.target.closest?.('.sp-fan-btn');
  for (const f of $$('.sp-fan.open')) if (!fan || f !== fan.parentElement) f.classList.remove('open');
  if (!fan) return;
  const f = fan.parentElement;
  f.classList.toggle('open');
  fan.setAttribute('aria-expanded', f.classList.contains('open'));
});

// The floating stack: one button per spell button, folded into a fan-out per `group`.
function floatHtml() {
  const list = items('float');
  if (!list.length) return '';
  const groups = new Map();
  const loose = [];
  for (const x of list) (x.b.group ? groups.get(x.b.group)?.push(x) || groups.set(x.b.group, [x]) : loose.push(x));
  return [
    ...[...groups].map(
      ([name, xs]) => `<div class="sp-fan" data-fan="${esc(name)}"><div class="sp-fan-items">${xs.map(renderFab).join('')}</div><button class="sp-fab sp-fan-btn" aria-expanded="false" title="${esc(name)}">${icon('wizard')}<span class="sp-fab-l">${esc(name)}</span></button></div>`,
    ),
    ...loose.map(renderFab),
  ].join('');
}
function renderFab({ spell, b, kind, i }) {
  const badge = badgeOf(spell, b, kind, i, null);
  const bkey = `${spell.id}:${kind}:${i}:`;
  return `<button class="sp-fab${b.primary ? ' primary' : ''}" ${attrs(spell, kind, i)} title="${tip(spell, b)}" aria-label="${esc(b.label || b.icon)}">${b.icon ? icon(b.icon) : icon('wizard')}${b.label ? `<span class="sp-fab-l">${esc(b.label)}</span>` : ''}${b.badge ? `<b class="sp-n" data-badge="${esc(bkey)}" ${badge ? '' : 'hidden'}>${esc(badge)}</b>` : ''}</button>`;
}

// --- parts: style, props, order, hide, tokens ------------------------------------------------

// A card head's pieces in the order a spell asks for (unlisted ones after, the chevron last).
function orderCss(order) {
  return ['#feed .it-side > * { order: 500; }', ...order.map((k, i) => `#feed .it-side > ${CARD_HEAD_ORDER[k]} { order: ${i + 1}; }`), '#feed .it-side > .chev { order: 999; }'].join('\n');
}

function styleSheet(spells) {
  const css = [];
  const root = [];
  const dark = [];
  for (const s of spells) {
    for (const [k, v] of Object.entries(s.ui?.tokens || {})) root.push(`${k}: ${v};`);
    for (const [k, v] of Object.entries(s.ui?.dark || {})) dark.push(`${k}: ${v};`);
    for (const h of s.ui?.hide || []) if (PARTS[h]) css.push(`${PARTS[h]} { display: none !important; }`);
    for (const [name, p] of Object.entries(s.parts || {})) {
      const sel = PARTS[name];
      if (!sel) continue;
      if (p.style && Object.keys(p.style).length) css.push(`${sel} { ${Object.entries(p.style).map(([k, v]) => `${k}: ${v} !important;`).join(' ')} }`);
      if (p.props?.monospace) css.push(`${sel} { font-family: var(--mono) !important; }`);
      if (p.props?.fontSize) css.push(`${sel} { font-size: ${p.props.fontSize}px !important; }`);
      if (p.props?.rows) css.push(`${sel} { min-height: calc(${p.props.rows} * 1.5em + 12px) !important; }`);
      if (p.props?.lines) css.push(`${sel} { white-space: normal !important; display: -webkit-box !important; -webkit-line-clamp: ${p.props.lines}; -webkit-box-orient: vertical; overflow: hidden; }`);
      if (p.order?.length) css.push(orderCss(p.order));
    }
  }
  if (root.length) css.unshift(`:root, :root[data-theme] { ${root.join(' ')} }`);
  if (dark.length) css.push(`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ${dark.join(' ')} } }`, `:root[data-theme='dark'] { ${dark.join(' ')} }`);
  return css.join('\n');
}

// A prop a part has from the spells that are on (the last spell wins).
export function spellProp(part, key) {
  let v;
  for (const s of activeSpells()) if (s.parts?.[part]?.props?.[key] !== undefined) v = s.parts[part].props[key];
  return v;
}

// --- applying it all -------------------------------------------------------------------------

let lastSig = '';
let launcherSig = '';

// Called after every config load and when trying a spell. Repaints only what spells touch.
export function applySpells({ force = false } = {}) {
  const spells = S.config.spellsSafe ? [] : activeSpells();
  const sig = JSON.stringify(spells);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  badgeCache.clear();
  let style = $('#spell-style');
  if (!style) (style = document.createElement('style')), (style.id = 'spell-style'), document.head.append(style);
  style.textContent = styleSheet(spells);
  document.body.classList.toggle('sp-compact', spellProp('card', 'density') === 'compact');
  document.body.classList.toggle('sp-comfy', spellProp('card', 'density') === 'comfortable');

  // App slots.
  const top = $('#spTop');
  if (top) top.innerHTML = slotHtml('topbar');
  const fl = $('#spFloat');
  if (fl) {
    fl.innerHTML = floatHtml();
    fl.hidden = !fl.innerHTML;
    fl.classList.toggle('left', items('float').some(({ b }) => b.corner === 'bottom-left'));
  }
  paintFeedTop(spells);
  // The launcher and the open cards' boxes and heads.
  const lsig = JSON.stringify(spells.map((s) => [s.buttons?.filter((b) => b.slot.startsWith('launcher')), s.chips?.filter((c) => c.slot.startsWith('launcher')), s.parts?.['launcher.input']]));
  if (lsig !== launcherSig) {
    launcherSig = lsig;
    bus.emit('spells:launcher');
  }
  for (const id of S.open) paintCard(id);
  bus.emit('spells');
}

function paintFeedTop(spells) {
  const host = $('#spFeedTop');
  if (!host) return;
  const panels = spells.flatMap((spell) => (spell.panels || []).filter((p) => p.as === 'feed').map((p) => ({ spell, p })));
  const keep = new Set(panels.map(({ spell, p }) => `${spell.id}:${p.id}`));
  for (const n of $$('.sp-feed', host)) if (!keep.has(n.dataset.k)) n.remove();
  for (const { spell, p } of panels) {
    const k = `${spell.id}:${p.id}`;
    let n = $(`.sp-feed[data-k="${CSS.escape(k)}"]`, host);
    if (!n) {
      n = el(`<section class="sp-feed card" data-k="${esc(k)}"><header>${p.icon ? icon(p.icon) : icon('wizard')}<b>${esc(p.title || spell.name)}</b><span class="sp-by">${esc(spell.name)}</span></header><div class="sp-feed-body"></div></section>`);
      host.append(n);
      if (p.refresh?.every) {
        const t = setInterval(() => (n.isConnected ? paintPanel($('.sp-feed-body', n), spell, p, null) : clearInterval(t)), p.refresh.every * 1000);
      }
    }
    paintPanel($('.sp-feed-body', n), spell, p, null);
  }
  host.hidden = !panels.length;
}

// A card's spell parts: its box's chips and bar buttons, and panels at its top and bottom.
export function paintCard(id) {
  const n = S.nodes.get(id);
  const s = S.sessions.get(id);
  if (!n?.body || !s) return;
  const comp = $('.composer', n.body);
  if (comp) {
    let chips = $('.sp-cchips', comp);
    if (!chips) (chips = el('<div class="sp-cchips"></div>')), $('.reply', comp)?.closest('.mention-wrap, .composer > *')?.before(chips) || comp.prepend(chips);
    const ch = slotHtml('composer.chips', s);
    if (chips.dataset.h !== ch) (chips.innerHTML = ch), (chips.dataset.h = ch);
    chips.hidden = !ch;
    let bar = $('.sp-cbar', comp);
    if (!bar) (bar = el('<span class="sp-cbar"></span>')), $('.send', comp)?.before(bar);
    const bh = slotHtml('composer.bar', s);
    if (bar.dataset.h !== bh) (bar.innerHTML = bh), (bar.dataset.h = bh);
    const ph = spellProp('composer.input', 'placeholder');
    const ta = $('.reply', comp);
    if (ta && ph && !ta.disabled && !s.ask) ta.placeholder = ph;
  }
  for (const where of ['top', 'bottom']) {
    let host = $(`.sp-card-${where}`, n.body);
    const panels = activeSpells().flatMap((spell) => (spell.panels || []).filter((p) => p.as === 'card' && p.slot === `card.${where}` && whenMatches(p.when, s)).map((p) => ({ spell, p })));
    if (!host) {
      if (!panels.length) continue;
      host = el(`<div class="sp-card sp-card-${where}"></div>`);
      if (where === 'top') $('.it-bar', n.body)?.after(host);
      else $('.it-dock', n.body)?.before(host);
    }
    const keep = new Set(panels.map(({ spell, p }) => `${spell.id}:${p.id}`));
    for (const x of $$('.sp-cpanel', host)) if (!keep.has(x.dataset.k)) x.remove();
    for (const { spell, p } of panels) {
      const k = `${spell.id}:${p.id}`;
      let x = $(`.sp-cpanel[data-k="${CSS.escape(k)}"]`, host);
      if (!x) {
        x = el(`<section class="sp-cpanel" data-k="${esc(k)}"><header>${p.icon ? icon(p.icon) : icon('wizard')}<b>${esc(p.title || spell.name)}</b><span class="sp-by">${esc(spell.name)}</span></header><div class="sp-cpanel-body"></div></section>`);
        host.append(x);
      }
      paintPanel($('.sp-cpanel-body', x), spell, p, id);
    }
    host.hidden = !panels.length;
  }
}

// The launcher asks for its spell parts when it renders (features/launcher.js).
export function launcherParts(box) {
  const bar = $('.l-bar', box);
  const send = $('#launch', box);
  if (bar && send) send.insertAdjacentHTML('beforebegin', `<span class="sp-lbar">${slotHtml('launcher.bar')}</span>`);
  const chips = slotHtml('launcher.chips');
  if (chips) bar?.insertAdjacentHTML('afterend', `<div class="sp-lchips">${chips}</div>`);
  const ta = $('#prompt', box);
  const rows = spellProp('launcher.input', 'rows');
  if (ta && rows) ta.rows = rows;
}

// --- agent blocks: types spells add, drawn through their render function ---------------------

const blockCache = new Map(); // JSON of the block -> rendered blocks

setBlockFallback((b, ctx) => {
  const spell = activeSpells().find((s) => (s.blocks || []).some((x) => x.type === b.type));
  if (!spell) {
    const node = el(`<div class="sp-block sp-off card"><div class="sp-off-head">${icon('wizard')}<span>A <b>${esc(b.type)}</b> block from a spell that isn't on</span><button class="link xs">Show data</button></div><pre class="code" hidden><code>${esc(JSON.stringify(b, null, 2))}</code></pre></div>`);
    $('button', node).onclick = () => {
      $('pre', node).hidden = !$('pre', node).hidden;
    };
    return node;
  }
  const def = spell.blocks.find((x) => x.type === b.type);
  const node = el(`<div class="sp-block" data-spell="${esc(spell.id)}" title="Drawn by the spell ${esc(spell.name)}"></div>`);
  const key = `${spell.id}:${JSON.stringify(b)}`;
  const draw = (blocks) => node.replaceChildren(drawBlocks(blocks, { ...ctx, delay: 0, spell: spell.name }));
  if (blockCache.has(key)) draw(blockCache.get(key));
  else {
    node.append(el(`<div class="it-loading"><span class="orb tiny"></span>${esc(spell.name)}…</div>`));
    callSpell(spell, def.render, [b, { block: b }])
      .then((v) => {
        const blocks = cleanBlocks(v);
        blockCache.set(key, blocks);
        if (blockCache.size > 300) blockCache.delete(blockCache.keys().next().value);
        draw(blocks);
      })
      .catch((err) => node.replaceChildren(el(`<div class="sp-error">${icon('warn')}<span>${esc(err.message)}</span></div>`)));
  }
  return node;
});

// --- trying a spell --------------------------------------------------------------------------

export function tryOn(spell, session = null) {
  trying = { spell, session };
  for (const k of [...dataCache.keys()]) if (k.startsWith(`${spell.id}:`)) dataCache.delete(k);
  applySpells({ force: true });
  let bar = $('#spTry');
  if (!bar) (bar = el('<div class="sp-try" id="spTry" role="status"></div>')), document.body.append(bar);
  bar.innerHTML = `${icon('wizard')}<span>Trying <b>${esc(spell.name)}</b> in this window</span><button class="primary sm" data-a="keep">Keep</button><button class="ghost sm" data-a="undo">Undo</button>`;
  bar.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'keep') keep(spell, session);
    if (a === 'undo') undoTry();
  };
}

export function undoTry() {
  trying = null;
  $('#spTry')?.remove();
  applySpells({ force: true });
}

export const tryingId = () => trying?.spell.id || null;

// Install and turn on (only ever from a click). Optimistic: the spell applies at once.
export async function keep(spell, session = null) {
  const was = S.config.spells || [];
  S.config.spells = [...was.filter((s) => s.id !== spell.id), spell];
  trying = null;
  $('#spTry')?.remove();
  applySpells({ force: true });
  try {
    await api('/spells', { method: 'POST', body: { spell, enable: true, source: { kind: session ? 'cast' : 'local', ...(session && { session }) } } });
    toast(`${icon('wizard')} <b>${esc(spell.name)}</b> is on`, { action: { label: 'Spells', run: () => import('./settings.js').then((m) => m.openSettings({ pane: 'spells' })) } });
    bus.emit('spells:changed');
    return true;
  } catch (err) {
    S.config.spells = was;
    applySpells({ force: true });
    toastError(err);
    return false;
  }
}

export async function setOn(id, on) {
  const was = S.config.spells || [];
  if (!on) {
    S.config.spells = was.filter((s) => s.id !== id);
    applySpells({ force: true });
  }
  const r = await tryApi(() => api(`/spells/${id}`, { method: 'PATCH', body: { enabled: on } }));
  if (!r && !on) (S.config.spells = was), applySpells({ force: true });
  bus.emit('spells:changed');
  return r;
}

// Live events the spells' panels refresh on.
bus.on('config', () => bus.emit('spell:config'));
export const spellEvent = (name) => bus.emit(`spell:${name}`);
