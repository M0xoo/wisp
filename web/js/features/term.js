// Take over in the page: the agent's own TUI in a terminal inside wisp, for computers with no
// terminal app to open (a wisp Grid, a server, the phone app). The server runs it (server/pty.js)
// and streams its output from /sessions/:id/term; term-emu.js keeps the screen.
//
// One panel, for one task at a time. In split view it lies over the open task's reading area (the
// task's header stays above it); in the feed it's a sheet; on a phone it fills the screen with a
// row of the keys a phone keyboard lacks. Going back hides it: the agent carries on, the card says
// "In terminal", and opening it again shows the same screen. It ends when the agent exits.

import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { esc } from '../md.js';
import { keyBytes, Screen, BOLD, DIM, ITALIC, UNDER, INVERSE, HIDDEN, STRIKE } from '../term-emu.js';
import { toast, toastError } from '../ui/toast.js';
import { isSplit } from './split.js';
import { agentName } from './runners.js';
import { slotHtml, spellProp } from './spells.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const TOUCH = matchMedia('(pointer: coarse)');

// The 16 ANSI colours, for the dark screen (--term-bg).
const ANSI = ['#1e1e1e', '#f0524f', '#5fb34a', '#d9a521', '#4f8ef7', '#c26fe0', '#2fb6c4', '#c8c8c6', '#6e6e6e', '#ff7672', '#7fd667', '#f2c94c', '#7aa9ff', '#dc95f2', '#5fd6e2', '#f2f2f0'];
function color256(n) {
  if (n < 16) return ANSI[n];
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  }
  const i = n - 16;
  const c = (k) => (k ? 55 + k * 40 : 0).toString(16).padStart(2, '0');
  return `#${c(Math.floor(i / 36))}${c(Math.floor(i / 6) % 6)}${c(i % 6)}`;
}
const colorOf = (c) => (c === null ? null : typeof c === 'number' ? color256(c) : c);

const escCell = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function styleOf(p) {
  let fg = colorOf(p.fg);
  let bg = colorOf(p.bg);
  if (p.f & INVERSE) [fg, bg] = [bg || 'var(--term-bg)', fg || 'var(--term-ink)'];
  const css = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (p.f & HIDDEN) css.push('color:transparent');
  const cls = [p.f & BOLD && 'b', p.f & DIM && 'd', p.f & ITALIC && 'i', p.f & UNDER && 'u', p.f & STRIKE && 's'].filter(Boolean).join(' ');
  return `${cls ? ` class="${cls}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}`;
}

// One row as HTML: runs of cells with the same look, wide characters in a two-column box, the
// cursor at cx (or -1).
function rowHtml(r, cx) {
  let out = '';
  let run = '';
  let runPen = null;
  const flush = () => {
    if (run) out += runPen === null || (runPen.fg === null && runPen.bg === null && !runPen.f) ? run : `<span${styleOf(runPen)}>${run}</span>`;
    run = '';
  };
  for (let x = 0; x < r.c.length; x++) {
    const w = r.w[x];
    if (w === 0) continue;
    const p = r.p[x];
    const ch = escCell(r.c[x] || ' ');
    if (x === cx || w === 2) {
      flush();
      const cls = `${x === cx ? 'cur' : ''}${w === 2 ? ' w2' : ''}`.trim();
      const st = styleOf(p);
      out += st.includes('class="') ? `<span${st.replace('class="', `class="${cls} `)}>${ch}</span>` : `<span class="${cls}"${st}>${ch}</span>`;
      runPen = null;
      continue;
    }
    if (p !== runPen) flush(), (runPen = p);
    run += ch;
  }
  flush();
  return out || ' ';
}

// --- the panel ----------------------------------------------------------------------------

let panel = null;
let cur = null; // { id, screen, es, ... } the terminal shown
const terms = new Map(); // id -> terminal state, kept while it runs so reopening is instant

function build() {
  panel = el(`
    <section class="term" id="term" hidden>
      <div class="tm-scrim"></div>
      <div class="tm-box">
        <header class="tm-head">
          <button class="icon-btn tm-back" title="Back to the task (the agent keeps going)" aria-label="Back">${icon('back')}</button>
          <span class="tm-name"><b class="tm-title"></b><small class="tm-sub"></small></span>
          <span class="tm-acts"></span>
          <button class="ghost xs tm-end" title="End the terminal and the agent in it">${icon('stop')}<span>End</span></button>
        </header>
        <div class="tm-screen">
          <div class="tm-rows"><div class="tm-scroll"></div><div class="tm-live"></div></div>
          <textarea class="tm-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Terminal input"></textarea>
        </div>
        <div class="tm-keys" role="toolbar" aria-label="Keys">
          ${[['esc', 'Esc'], ['tab', 'Tab'], ['stab', '⇧Tab'], ['ctrl', 'Ctrl'], ['left', '←'], ['up', '↑'], ['down', '↓'], ['right', '→'], ['paste', 'Paste']].map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}
        </div>
      </div>
    </section>`);
  document.body.append(panel);
  $('.tm-back', panel).onclick = () => {
    hide();
  };
  $('.tm-scrim', panel).onclick = () => {
    hide();
  };
  $('.tm-end', panel).onclick = () => {
    end();
  };
  wireInput();
  new ResizeObserver(() => fit()).observe($('.tm-screen', panel));
  // The phone keyboard covers the bottom of the page: keep the panel (and its keys) above it.
  visualViewport?.addEventListener('resize', place);
  visualViewport?.addEventListener('scroll', place);
  // Split view: another task opened in the main pane takes the panel's place.
  new MutationObserver(() => {
    if (!cur || panel.hidden) return;
    place();
    if (isSplit() && $('#splitHead').dataset.id !== cur.id && !$('#splitHead').hidden) hide();
  }).observe($('#splitHead'), { attributes: true, attributeFilter: ['data-id', 'hidden'] });
  bus.on('spells', () => cur && !panel.hidden && (paintHead(), fit()));
}

// Where the panel goes: over the open task in split view, else a sheet (a phone: the whole screen).
function place(id = cur?.id) {
  if (!panel || panel.hidden) return;
  panel.classList.toggle('over-stage', isSplit() && !$('#splitStage').hidden && $('#splitHead').dataset.id === id);
  panel.classList.toggle('touch', TOUCH.matches || MOBILE);
  const vv = visualViewport;
  panel.style.setProperty('--vv-h', vv ? `${Math.round(vv.height)}px` : '100dvh');
  panel.style.setProperty('--vv-top', vv ? `${Math.round(vv.offsetTop)}px` : '0px');
}

function paintHead() {
  const s = S.sessions.get(cur.id) || S.full.get(cur.id) || {};
  panel.dataset.id = cur.id;
  $('.tm-title', panel).textContent = s.title || 'Terminal';
  $('.tm-sub', panel).textContent = cur.code !== null ? 'Ended' : cur.ready ? `${agentName(s.agent)} · in a terminal` : 'Starting…';
  $('.tm-end', panel).hidden = cur.code !== null;
  const acts = $('.tm-acts', panel);
  const html = slotHtml('term.head', s);
  if (acts.dataset.h !== html) (acts.innerHTML = html), (acts.dataset.h = html);
  const fs = spellProp('term', 'fontSize');
  panel.style.setProperty('--tm-fs', fs ? `${fs}px` : '');
}

function show(t) {
  if (!panel) build();
  if (cur && cur !== t) $('.tm-scroll', panel).replaceChildren(), $('.tm-live', panel).replaceChildren();
  const fresh = cur !== t;
  cur = t;
  panel.hidden = false;
  document.body.classList.add('term-open');
  place();
  paintHead();
  if (fresh) t.painted = { cleared: -1, back: 0, dropped: 0, rows: [], vers: [], cx: [] };
  fit();
  paint();
  focus();
}

export function hide() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove('term-open');
  $('.tm-input', panel).blur();
}

const focus = () => {
  if (cur?.code === null) $('.tm-input', panel)?.focus({ preventScroll: true });
};

// --- one terminal ---------------------------------------------------------------------------

function termFor(id) {
  let t = terms.get(id);
  if (t) return t;
  t = { id, es: null, code: null, ready: false, replay: false, queue: '', sending: false, size: null, painted: null };
  t.screen = new Screen(80, 24, {
    // What the terminal answers the program (cursor position and the like); not for old output replayed.
    onReply: (r) => !t.replay && send(t, r),
    colors: { fg: '#e8e8e6', bg: '#141414' },
  });
  terms.set(id, t);
  return t;
}

function connect(t) {
  t.es?.close();
  const es = new EventSource(`/api/sessions/${t.id}/term`);
  t.es = es;
  es.addEventListener('hello', () => {
    t.ready = true;
    t.screen.reset();
    t.replay = true; // the next data is what it printed so far
    t.size = null;
    fit();
    if (cur === t) paintHead();
  });
  es.addEventListener('data', (e) => {
    t.screen.write(JSON.parse(e.data));
    t.replay = false;
    schedule(t);
  });
  es.addEventListener('exit', (e) => finished(t, JSON.parse(e.data).code));
  es.addEventListener('gone', () => finished(t, t.code ?? 0));
  // EventSource retries a dropped stream itself, not a refused one (a machine's tunnel down, wisp
  // restarting): try again while the terminal is still ours.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && t.es === es && t.code === null) setTimeout(() => t.es === es && terms.get(t.id) === t && connect(t), 2000);
  };
}

function finished(t, code) {
  t.es?.close();
  t.es = null;
  if (t.code !== null) return;
  t.code = code;
  t.screen.write(`\r\n\x1b[2m[The terminal ended${code ? ` (exit ${code})` : ''}. Press any key to go back.]\x1b[0m`);
  schedule(t);
  if (cur === t) paintHead();
}

// Typed text goes out in order, batched while a send is on its way.
function send(t, data) {
  if (!data || t.code !== null) return;
  t.queue += data;
  if (t.sending) return;
  t.sending = true;
  (async () => {
    while (t.queue) {
      const chunk = t.queue;
      t.queue = '';
      try {
        await api(`/sessions/${t.id}/term`, { method: 'POST', body: { data: chunk } });
      } catch (err) {
        if (err.status === 404) finished(t, 0);
        else toastError(err);
        t.queue = '';
      }
    }
    t.sending = false;
  })();
}

// Columns and rows that fit the screen box, told to the server when they change.
let fitTimer;
function fit() {
  const t = cur;
  if (!t || panel.hidden) return;
  const box = $('.tm-screen', panel);
  const m = measureCell();
  const st = getComputedStyle(box);
  const w = box.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
  const h = box.clientHeight - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom);
  if (w <= 0 || h <= 0) return;
  const cols = Math.max(20, Math.floor(w / m.w));
  const rows = Math.max(5, Math.floor(h / m.h));
  panel.style.setProperty('--tm-lh', `${m.h}px`);
  if (t.screen.cols !== cols || t.screen.rows !== rows) {
    t.screen.resize(cols, rows);
    schedule(t);
  }
  if (!t.ready || (t.size?.cols === cols && t.size?.rows === rows)) return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    t.size = { cols, rows };
    if (t.code === null) api(`/sessions/${t.id}/term`, { method: 'POST', body: { cols, rows } }).catch(() => {});
  }, 120);
}

let cell = null;
function measureCell() {
  const fs = getComputedStyle(panel).getPropertyValue('--tm-fs') || '';
  if (cell?.fs === fs) return cell;
  const probe = el(`<span class="tm-probe">${'W'.repeat(40)}</span>`);
  $('.tm-rows', panel).append(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  const lh = parseFloat(getComputedStyle($('.tm-rows', panel)).lineHeight) || r.height;
  cell = { fs, w: r.width / 40 || 8, h: Math.ceil(lh) || 17 };
  return cell;
}

// Painting: once per frame, only rows that changed. Scrollback rows never change, so they're
// added once and dropped off the top as it trims.
const queued = new Set();
function schedule(t) {
  if (cur !== t || panel?.hidden || queued.size) return; // painted when it's shown
  queued.add(t);
  requestAnimationFrame(() => {
    queued.clear();
    paint();
  });
}

function paint() {
  const t = cur;
  if (!t || panel.hidden || !t.painted) return;
  const sc = t.screen;
  const P = t.painted;
  const box = $('.tm-screen', panel);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
  const backEl = $('.tm-scroll', panel);
  const liveEl = $('.tm-live', panel);
  backEl.hidden = !!sc.alt;
  if (P.cleared !== sc.cleared) {
    backEl.replaceChildren();
    P.cleared = sc.cleared;
    P.back = 0;
    P.dropped = sc.dropped;
  }
  // Rows trimmed off the scrollback's top, then the new ones at its end.
  let gone = Math.min(sc.dropped - P.dropped, backEl.childElementCount);
  P.dropped = sc.dropped;
  P.back -= gone;
  while (gone-- > 0) backEl.firstElementChild.remove();
  if (P.back < sc.back.length) {
    const frag = document.createDocumentFragment();
    for (let i = Math.max(0, P.back); i < sc.back.length; i++) {
      const d = document.createElement('div');
      d.innerHTML = rowHtml(sc.back[i], -1);
      frag.append(d);
    }
    backEl.append(frag);
    P.back = sc.back.length;
  }
  const rows = sc.screen;
  while (liveEl.childElementCount > rows.length) liveEl.lastElementChild.remove();
  while (liveEl.childElementCount < rows.length) liveEl.append(document.createElement('div'));
  const showCursor = sc.modes.cursor && t.code === null;
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    const cx = showCursor && y === sc.y ? Math.min(sc.x, sc.cols - 1) : -1;
    if (P.rows[y] === r && P.vers[y] === r.v && P.cx[y] === cx) continue;
    liveEl.children[y].innerHTML = rowHtml(r, cx);
    P.rows[y] = r;
    P.vers[y] = r.v;
    P.cx[y] = cx;
  }
  P.rows.length = P.vers.length = P.cx.length = rows.length;
  if (atBottom || sc.alt) box.scrollTop = box.scrollHeight;
  placeInput();
}

// The hidden input sits on the cursor, so the IME's suggestions show up next to it.
function placeInput() {
  const t = cur;
  const m = cell;
  if (!t || !m) return;
  const ta = $('.tm-input', panel);
  const live = $('.tm-live', panel);
  ta.style.left = `${live.offsetLeft + Math.min(t.screen.x, t.screen.cols - 1) * m.w}px`;
  ta.style.top = `${live.offsetTop + t.screen.y * m.h}px`;
}

// --- input ----------------------------------------------------------------------------------

let ctrlOnce = false; // the key row's Ctrl: applies to the next key
function wireInput() {
  const ta = $('.tm-input', panel);
  const screen = $('.tm-screen', panel);
  let composing = false;
  let compSent = ''; // on a phone, composed text is sent as it's typed and corrected as it changes
  const typed = (data) => {
    const t = cur;
    if (!t) return;
    if (t.code !== null) return hide();
    if (ctrlOnce && data.length === 1) {
      const b = keyBytes({ key: data, ctrlKey: true });
      ctrlOnce = false;
      paintCtrl();
      if (b) data = b;
    }
    $('.tm-screen', panel).scrollTop = 1e9;
    send(t, data);
  };
  const diff = (now) => {
    let i = 0;
    while (i < compSent.length && i < now.length && compSent[i] === now[i]) i++;
    const out = '\x7f'.repeat([...compSent.slice(i)].length) + now.slice(i);
    compSent = now;
    return out;
  };
  ta.addEventListener('keydown', (e) => {
    const t = cur;
    if (!t || e.isComposing || e.keyCode === 229) return;
    e.stopPropagation(); // wisp's own keys (Esc, J/K, …) stay out of the terminal
    if (t.code !== null) return void (e.preventDefault(), hide());
    // ⌃C copies when text is selected (Windows, Linux); ⌘ keys stay the browser's (copy, paste, …).
    if (e.ctrlKey && !MAC && e.key.toLowerCase() === 'c' && String(getSelection())) return;
    if (e.ctrlKey && e.shiftKey && ['c', 'v'].includes(e.key.toLowerCase())) return;
    let b = keyBytes(e, { appCursor: t.screen.modes.appCursor, mac: MAC });
    if (b === null && ctrlOnce && e.key.length === 1) b = keyBytes({ key: e.key, ctrlKey: true });
    if (b === null) return;
    e.preventDefault();
    if (ctrlOnce) (ctrlOnce = false), paintCtrl();
    typed(b);
  });
  ta.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertCompositionText' || (composing && e.inputType.startsWith('delete'))) return;
    e.preventDefault();
    if (e.inputType === 'insertText' && e.data) typed(e.data);
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') typed('\r');
    else if (e.inputType === 'deleteContentBackward') typed('\x7f');
    else if (e.inputType === 'insertFromPaste' && e.dataTransfer) typed(pasted(e.dataTransfer.getData('text/plain')));
  });
  ta.addEventListener('compositionstart', () => {
    composing = true;
    compSent = '';
  });
  ta.addEventListener('input', () => {
    if (!composing) return void (ta.value = '');
    if (TOUCH.matches || MOBILE) typed(diff(ta.value));
  });
  ta.addEventListener('compositionend', (e) => {
    composing = false;
    typed(TOUCH.matches || MOBILE ? diff(e.data || '') : e.data || '');
    compSent = '';
    ta.value = '';
  });
  ta.addEventListener('paste', (e) => {
    e.preventDefault();
    typed(pasted(e.clipboardData?.getData('text/plain') || ''));
  });
  ta.addEventListener('focus', () => panel.classList.add('focused'));
  ta.addEventListener('blur', () => panel.classList.remove('focused'));
  // A click puts the keys in the terminal, unless it selected text to copy.
  screen.addEventListener('mouseup', () => {
    if (!String(getSelection())) focus();
  });
  screen.addEventListener('click', () => {
    if (cur?.code !== null) hide();
  });
  // Full-screen programs (the alternate screen) get the wheel as arrow keys or mouse events.
  screen.addEventListener(
    'wheel',
    (e) => {
      const t = cur;
      if (!t?.screen.alt || t.code !== null) return;
      e.preventDefault();
      const n = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40)));
      const up = e.deltaY < 0;
      const { mouse, sgrMouse, appCursor } = t.screen.modes;
      if (mouse && sgrMouse) send(t, `\x1b[<${up ? 64 : 65};1;1M`.repeat(n));
      else send(t, (up ? (appCursor ? '\x1bOA' : '\x1b[A') : appCursor ? '\x1bOB' : '\x1b[B').repeat(n));
    },
    { passive: false },
  );
  // The key row: it mustn't take the focus (the phone keyboard would close).
  const keys = $('.tm-keys', panel);
  keys.addEventListener('pointerdown', (e) => e.target.closest('button') && e.preventDefault());
  keys.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    const t = cur;
    if (!k || !t) return;
    if (k === 'ctrl') return void ((ctrlOnce = !ctrlOnce), paintCtrl(), focus());
    if (k === 'paste') {
      try {
        typed(pasted(await navigator.clipboard.readText()));
      } catch {
        toast('Long-press in the terminal to paste.');
      }
      return focus();
    }
    const app = t.screen.modes.appCursor;
    const seq = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: app ? '\x1bOA' : '\x1b[A', down: app ? '\x1bOB' : '\x1b[B', right: app ? '\x1bOC' : '\x1b[C', left: app ? '\x1bOD' : '\x1b[D' }[k];
    if (ctrlOnce) (ctrlOnce = false), paintCtrl();
    typed(seq);
    focus();
  });
}

const paintCtrl = () => $('[data-k="ctrl"]', panel)?.classList.toggle('on', ctrlOnce);

// Pasted text as one block: the program knows it's a paste (bracketed paste) when it asked to.
function pasted(text) {
  const t = cur;
  const body = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, '\r');
  if (!body) return '';
  return t?.screen.modes.paste ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : body;
}

// --- what the rest of the page calls ---------------------------------------------------------

// Show task id's terminal, connecting to it if this page hasn't yet. starting: the server is still
// opening it (the take over is on its way).
export function openTerm(id, { starting = false } = {}) {
  let t = terms.get(id);
  if (t && t.code !== null) (terms.delete(id), (t = null));
  t = termFor(id);
  show(t);
  if (!starting && !t.es) connect(t);
  return t;
}

// The take over answered: stream it, or (it went to a terminal app after all) put the panel away.
export function termStarted(id, inline) {
  const t = terms.get(id);
  if (!inline) {
    if (t && !t.es) (terms.delete(id), cur === t && hide());
    return;
  }
  connect(t || openTerm(id, { starting: true }));
}

// The take over failed: put back what it showed.
export function termFailed(id) {
  const t = terms.get(id);
  if (t && !t.es) {
    terms.delete(id);
    if (cur === t) hide();
  }
}

// The cell size a new terminal would get, so the server starts it at the right size.
export function termSize(id) {
  if (!panel) build();
  const was = panel.hidden;
  panel.hidden = false;
  panel.style.visibility = 'hidden';
  place(id);
  const box = $('.tm-screen', panel);
  const m = measureCell();
  const st = getComputedStyle(box);
  const cols = Math.floor((box.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight)) / m.w);
  const rows = Math.floor((box.clientHeight - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom)) / m.h);
  panel.hidden = was;
  panel.style.visibility = '';
  return cols > 0 && rows > 0 ? { cols, rows } : {};
}

async function end() {
  const t = cur;
  if (!t || (t.code === null && !confirm('End the terminal? The agent in it stops.'))) return;
  hide();
  terms.delete(t.id);
  t.es?.close();
  t.code = 0;
  try {
    await api(`/sessions/${t.id}/term`, { method: 'DELETE' });
  } catch (err) {
    toastError(err);
  }
}

// The card's "In terminal" pill opens it. In the feed, instead of the head's own click (which
// folds the card); in split view, after it: the task opens in the main pane, the terminal over it.
document.addEventListener(
  'click',
  (e) => {
    const p = e.target.closest?.('[data-term]');
    if (!p) return;
    const id = p.dataset.term;
    if (isSplit() && p.closest('#feed')) return void setTimeout(() => openTerm(id));
    e.stopPropagation();
    e.preventDefault();
    openTerm(id);
  },
  true,
);

export const termPill = (s) => (s.term ? `<button class="pill st-term" data-term="${esc(s.id)}" title="Taken over in a terminal: open it">${icon('terminal')}In terminal</button>` : '');
