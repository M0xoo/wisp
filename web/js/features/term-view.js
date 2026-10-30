// One terminal on the page: a Screen (term-emu.js) fed by the server's event stream, painted into
// a box, with the keys, the mouse, a phone's composing and the key row going back to it. Take over
// (term.js: the agent's own TUI) and the side panel's shell (panel.js: yours, in the task's folder)
// each paint theirs in a TermView of their own; a terminal's state outlives the view showing it.

import { api } from '../core/api.js';
import { $, el } from '../core/dom.js';
import { MOBILE } from '../core/state.js';
import { keyBytes, Screen, BOLD, DIM, ITALIC, UNDER, INVERSE, HIDDEN, STRIKE } from '../term-emu.js';
import { toast, toastError } from '../ui/toast.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const TOUCH = matchMedia('(pointer: coarse)');

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

// Scrollback rows painted at once when many come in; the rest follow in chunks while idle.
const BACK_NOW = 300;
const BACK_CHUNK = 500;
const SYNC_MS = 150; // the longest a frame the program began (synchronized output) waits to be painted

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

// The screen, its hidden input and the phone's key row: what a TermView paints into.
export const SCREEN_HTML = `
  <div class="tm-screen">
    <div class="tm-wait" aria-live="polite"><span class="tm-wait-l"></span><i></i><i></i><i></i><i></i></div>
    <div class="tm-rows"><div class="tm-scroll"></div><div class="tm-live"></div></div>
    <textarea class="tm-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Terminal input"></textarea>
  </div>
  <div class="tm-keys" role="toolbar" aria-label="Keys">
    ${[['esc', 'Esc'], ['ctrlc', '^C'], ['tab', 'Tab'], ['stab', '⇧Tab'], ['ctrl', 'Ctrl'], ['left', '←'], ['up', '↑'], ['down', '↓'], ['right', '→'], ['paste', 'Paste']].map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}
  </div>`;

// --- one terminal ---------------------------------------------------------------------------

// A terminal's state: url is where it streams from and takes input (/sessions/:id/term or /shell).
// onHello / onExit(code): it (re)connected, it ended. stick: the view follows new output (until you
// scroll up). drawn: something's on screen yet.
const newSender = () => Math.random().toString(36).slice(2, 10);

export function termState(id, url, { onHello = () => {}, onExit = () => {} } = {}) {
  const t = { id, url, es: null, code: null, ready: false, replay: false, queue: '', sending: 0, seq: 0, from: newSender(), size: null, painted: null, stick: true, drawn: false, view: null, onHello, onExit };
  t.screen = new Screen(80, 24, {
    // What the terminal answers the program (cursor position and the like); not for old output replayed.
    onReply: (r) => !t.replay && send(t, r),
    colors: { fg: '#e8e8e6', bg: '#141414' },
  });
  return t;
}

export function connect(t) {
  t.es?.close();
  const es = new EventSource(`/api${t.url}`);
  t.es = es;
  es.addEventListener('hello', (e) => {
    t.ready = true;
    t.ordered = !!JSON.parse(e.data).ordered; // an older wisp over there: one send at a time
    // Maybe a new terminal over there (wisp restarted): its count starts again, so does ours.
    t.from = newSender();
    t.seq = 0;
    t.screen.reset();
    t.drawn = false;
    t.replay = true; // the next data is what it printed so far
    t.size = null;
    t.view?.fit();
    t.onHello(t);
  });
  es.addEventListener('data', (e) => {
    t.screen.write(JSON.parse(e.data));
    t.replay = false;
    t.view?.schedule(t);
  });
  es.addEventListener('exit', (e) => finished(t, JSON.parse(e.data).code));
  es.addEventListener('gone', () => finished(t, t.code ?? 0));
  // EventSource retries a dropped stream itself, not a refused one (a machine's tunnel down, wisp
  // restarting): try again while the terminal is still ours.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && t.es === es && t.code === null) setTimeout(() => t.es === es && t.code === null && connect(t), 2000);
  };
}

export function finished(t, code) {
  t.es?.close();
  t.es = null;
  if (t.code !== null) return;
  t.code = code;
  t.onExit(t, code);
  t.view?.schedule(t);
}

// Typed text goes out at once, without waiting for the last send to answer (a round trip to a
// cloud computer would hold up every key behind it). Sends are numbered and the server puts them
// back in order; keys from one event go together, and at most IN_FLIGHT are on their way (one
// before the server said it orders them).
const IN_FLIGHT = 4;
export function send(t, data) {
  if (!data || t.code !== null) return;
  t.queue += data;
  if (t.batching) return;
  t.batching = true;
  queueMicrotask(() => {
    t.batching = false;
    pump(t);
  });
}

function pump(t) {
  while (t.queue && t.sending < (t.ordered ? IN_FLIGHT : 1) && t.code === null) {
    const body = { data: t.queue, seq: t.seq++, from: t.from };
    t.queue = '';
    t.sending++;
    api(t.url, { method: 'POST', body })
      .catch((err) => {
        if (err.status === 404) finished(t, 0);
        else toastError(err);
      })
      .finally(() => {
        t.sending--;
        pump(t);
      });
  }
}

// --- the view ---------------------------------------------------------------------------------

export class TermView {
  // root holds SCREEN_HTML and gets .focused while the keys go to it. shown(): whether it's on
  // screen now. onEndedKey(): a key or click on a terminal that has ended.
  constructor(root, { shown = () => true, onEndedKey = () => {} } = {}) {
    Object.assign(this, { root, shown, onEndedKey });
    this.cur = null;
    this.cell = null;
    this.lastTop = 0; // the screen's scrollTop after the last paint or scroll
    this.ctrlOnce = false; // the key row's Ctrl: applies to the next key
    this.queued = false;
    this.fitTimer = null;
    this.wire();
    new ResizeObserver(() => this.fit()).observe($('.tm-screen', root));
  }

  // Show terminal t here (null: none). Its screen is painted afresh.
  show(t) {
    if (this.cur && this.cur !== t) {
      if (this.cur.view === this) this.cur.view = null;
      $('.tm-scroll', this.root).replaceChildren();
      $('.tm-live', this.root).replaceChildren();
    }
    const fresh = this.cur !== t;
    this.cur = t;
    if (!t) return;
    t.view = this;
    if (fresh) (t.painted = { cleared: -1, from: 0, back: 0, dropped: 0, rows: [], vers: [], cx: [] }), (this.lastTop = 0);
    this.fit();
    this.paint();
  }

  focus() {
    if (this.cur?.code === null) $('.tm-input', this.root)?.focus({ preventScroll: true });
  }

  blur() {
    $('.tm-input', this.root).blur();
  }

  // Columns and rows that fit the screen box, told to the server when they change.
  fit() {
    const t = this.cur;
    if (!t || !this.shown()) return;
    const size = this.size();
    if (!size.cols) return;
    const { cols, rows } = size;
    this.root.style.setProperty('--tm-lh', `${this.cell.h}px`);
    if (t.screen.cols !== cols || t.screen.rows !== rows) {
      t.screen.resize(cols, rows);
      this.schedule(t);
    }
    if (!t.ready || (t.size?.cols === cols && t.size?.rows === rows)) return;
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      t.size = { cols, rows };
      if (t.code === null) api(t.url, { method: 'POST', body: { cols, rows } }).catch(() => {});
    }, 120);
  }

  // The cell grid the box holds now ({} when it has no size: hidden).
  size() {
    const box = $('.tm-screen', this.root);
    const m = this.measureCell();
    const st = getComputedStyle(box);
    const w = box.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
    const h = box.clientHeight - parseFloat(st.paddingTop) - parseFloat(st.paddingBottom);
    if (w <= 0 || h <= 0) return {};
    return { cols: Math.max(20, Math.floor(w / m.w)), rows: Math.max(5, Math.floor(h / m.h)) };
  }

  measureCell() {
    const fs = getComputedStyle(this.root).getPropertyValue('--tm-fs') || '';
    if (this.cell?.fs === fs && this.cell.w) return this.cell;
    const probe = el(`<span class="tm-probe">${'W'.repeat(40)}</span>`);
    $('.tm-rows', this.root).append(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    const lh = parseFloat(getComputedStyle($('.tm-rows', this.root)).lineHeight) || r.height;
    this.cell = { fs, w: r.width / 40 || 0, h: Math.ceil(lh) || 17 };
    return { ...this.cell, w: this.cell.w || 8 };
  }

  // Painting: once per frame, only rows that changed. Scrollback rows never change, so they're
  // added once and dropped off the top as it trims.
  schedule(t) {
    if (this.cur !== t || !this.shown() || this.queued) return; // painted when it's shown
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      // Mid-frame (synchronized output): wait for the rest, so a frame split across two chunks of
      // output never shows half drawn. Painted anyway after SYNC_MS.
      const wait = t.screen.modes.sync ? SYNC_MS - (Date.now() - t.screen.syncAt) : 0;
      if (wait > 0) return void (this.syncTimer ||= setTimeout(() => ((this.syncTimer = null), this.schedule(t)), wait));
      this.paint();
    });
  }

  paint() {
    const t = this.cur;
    if (!t || !this.shown() || !t.painted) return;
    const sc = t.screen;
    const P = t.painted;
    const box = $('.tm-screen', this.root);
    const backEl = $('.tm-scroll', this.root);
    const liveEl = $('.tm-live', this.root);
    backEl.hidden = !!sc.alt;
    if (P.cleared !== sc.cleared) {
      backEl.replaceChildren();
      P.cleared = sc.cleared;
      P.from = P.back = 0;
      P.dropped = sc.dropped;
    }
    // The page holds scrollback rows from..back. Rows trimmed off the scrollback's top go, then
    // the new ones are added at its end.
    const drop = sc.dropped - P.dropped;
    P.dropped = sc.dropped;
    if (drop > 0) {
      P.from -= drop;
      P.back = Math.max(0, P.back - drop);
      let gone = Math.min(-P.from, backEl.childElementCount);
      while (gone-- > 0) backEl.firstElementChild.remove();
      P.from = Math.max(0, P.from);
    }
    if (P.back < sc.back.length) {
      // Many at once (a reopened terminal, a flood of output): the last screenfuls now, the older
      // ones above them once the page is idle.
      if (sc.back.length - P.back > BACK_NOW) {
        backEl.replaceChildren();
        P.from = P.back = sc.back.length - BACK_NOW;
        this.fillBack();
      }
      let html = '';
      for (let i = P.back; i < sc.back.length; i++) html += `<div>${rowHtml(sc.back[i], -1)}</div>`;
      backEl.insertAdjacentHTML('beforeend', html);
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
    if (t.stick || sc.alt) box.scrollTop = box.scrollHeight;
    this.lastTop = box.scrollTop;
    if (!t.drawn && (sc.back.length || rows.some((r) => r.c.some((c) => c !== ' ')))) t.drawn = true;
    $('.tm-wait', this.root).hidden = t.drawn || t.code !== null;
    this.placeInput();
  }

  // The scrollback rows above what's painted, a chunk per idle moment, keeping the view in place.
  fillBack() {
    if (this.filling) return;
    this.filling = true;
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 16));
    const step = () => {
      const t = this.cur;
      const P = t?.painted;
      if (!P || P.from <= 0 || !this.shown()) return void (this.filling = false);
      const sc = t.screen;
      const box = $('.tm-screen', this.root);
      const backEl = $('.tm-scroll', this.root);
      const start = Math.max(0, P.from - BACK_CHUNK);
      let html = '';
      for (let i = start; i < P.from; i++) html += `<div>${rowHtml(sc.back[i], -1)}</div>`;
      const h = box.scrollHeight;
      backEl.insertAdjacentHTML('afterbegin', html);
      P.from = start;
      if (t.stick || sc.alt) box.scrollTop = box.scrollHeight;
      else box.scrollTop += box.scrollHeight - h;
      this.lastTop = box.scrollTop;
      idle(step);
    };
    idle(step);
  }

  // The hidden input sits on the cursor, so the IME's suggestions show up next to it.
  placeInput() {
    const t = this.cur;
    const m = this.cell;
    if (!t || !m) return;
    const ta = $('.tm-input', this.root);
    const live = $('.tm-live', this.root);
    ta.style.left = `${live.offsetLeft + Math.min(t.screen.x, t.screen.cols - 1) * m.w}px`;
    ta.style.top = `${live.offsetTop + t.screen.y * m.h}px`;
  }

  paintCtrl() {
    $('[data-k="ctrl"]', this.root)?.classList.toggle('on', this.ctrlOnce);
  }

  // Pasted text as one block: the program knows it's a paste (bracketed paste) when it asked to.
  pasted(text) {
    const body = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, '\r');
    if (!body) return '';
    return this.cur?.screen.modes.paste ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : body;
  }

  // Type data into the terminal shown (the view jumps to the bottom).
  type(data) {
    const t = this.cur;
    if (!t) return;
    if (t.code !== null) return this.onEndedKey();
    t.stick = true;
    $('.tm-screen', this.root).scrollTop = 1e9;
    send(t, data);
  }

  // --- input ------------------------------------------------------------------------------------

  wire() {
    const root = this.root;
    const ta = $('.tm-input', root);
    const screen = $('.tm-screen', root);
    let composing = false;
    let compSent = ''; // on a phone, composed text is sent as it's typed and corrected as it changes
    const typed = (data) => {
      const t = this.cur;
      if (!t) return;
      if (t.code !== null) return this.onEndedKey();
      if (this.ctrlOnce && data.length === 1) {
        const b = keyBytes({ key: data, ctrlKey: true });
        this.ctrlOnce = false;
        this.paintCtrl();
        if (b) data = b;
      }
      this.type(data);
    };
    const diff = (now) => {
      let i = 0;
      while (i < compSent.length && i < now.length && compSent[i] === now[i]) i++;
      const out = '\x7f'.repeat([...compSent.slice(i)].length) + now.slice(i);
      compSent = now;
      return out;
    };
    ta.addEventListener('keydown', (e) => {
      const t = this.cur;
      if (!t || e.isComposing || e.keyCode === 229) return;
      // ⌃` leaves the terminal (panel.js listens on the document): the one key it doesn't take.
      if (e.ctrlKey && e.key === '`') return;
      e.stopPropagation(); // wisp's own keys (Esc, J/K, …) stay out of the terminal
      if (t.code !== null) return void (e.preventDefault(), this.onEndedKey());
      // ⌃C copies when text is selected (Windows, Linux); ⌘ keys stay the browser's (copy, paste, …).
      if (e.ctrlKey && !MAC && e.key.toLowerCase() === 'c' && String(getSelection())) return;
      if (e.ctrlKey && e.shiftKey && ['c', 'v'].includes(e.key.toLowerCase())) return;
      let b = keyBytes(e, { appCursor: t.screen.modes.appCursor, mac: MAC });
      if (b === null && this.ctrlOnce && e.key.length === 1) b = keyBytes({ key: e.key, ctrlKey: true });
      if (b === null) return;
      e.preventDefault();
      if (this.ctrlOnce) (this.ctrlOnce = false), this.paintCtrl();
      typed(b);
    });
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertCompositionText' || (composing && e.inputType.startsWith('delete'))) return;
      e.preventDefault();
      if (e.inputType === 'insertText' && e.data) typed(e.data);
      else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') typed('\r');
      else if (e.inputType === 'deleteContentBackward') typed('\x7f');
      else if (e.inputType === 'insertFromPaste' && e.dataTransfer) typed(this.pasted(e.dataTransfer.getData('text/plain')));
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
      typed(this.pasted(e.clipboardData?.getData('text/plain') || ''));
    });
    // Programs that asked (claude, codex) are told when the terminal gets and loses the keys.
    const focusReport = (seq) => {
      const t = this.cur;
      if (t && t.code === null && t.ready && t.screen.modes.focus) send(t, seq);
    };
    ta.addEventListener('focus', () => {
      root.classList.add('focused');
      focusReport('\x1b[I');
    });
    ta.addEventListener('blur', () => {
      root.classList.remove('focused');
      focusReport('\x1b[O');
    });
    // A click puts the keys in the terminal, unless it selected text to copy.
    screen.addEventListener('mouseup', () => {
      if (!String(getSelection())) this.focus();
    });
    // A program that takes the mouse (claude's full screen: jump to bottom, select, …) gets clicks,
    // taps and drags as SGR mouse events at the cell under the pointer. Shift keeps the page's own
    // text selection, as in other terminals.
    const cellAt = (e) => {
      const r = $('.tm-live', root).getBoundingClientRect();
      const m = this.measureCell();
      const sc = this.cur.screen;
      return [Math.max(1, Math.min(sc.cols, Math.floor((e.clientX - r.left) / m.w) + 1)), Math.max(1, Math.min(sc.rows, Math.floor((e.clientY - r.top) / m.h) + 1))];
    };
    const mouseOn = (e) => this.cur && this.cur.code === null && this.cur.screen.modes.mouse && this.cur.screen.modes.sgrMouse && !e.shiftKey && e.button === 0;
    let pressed = null;
    screen.addEventListener('pointerdown', (e) => {
      if (!mouseOn(e) || e.pointerType === 'touch') return; // a touch may be a swipe: sent on tap (click)
      e.preventDefault();
      pressed = cellAt(e);
      send(this.cur, `\x1b[<0;${pressed[0]};${pressed[1]}M`);
      this.focus();
    });
    screen.addEventListener('pointermove', (e) => {
      if (!pressed || !this.cur || this.cur.screen.modes.mouse < 1002) return;
      const at = cellAt(e);
      if (at[0] === pressed[0] && at[1] === pressed[1]) return;
      pressed = at;
      send(this.cur, `\x1b[<32;${at[0]};${at[1]}M`);
    });
    addEventListener('pointerup', (e) => {
      if (!pressed || !this.cur) return;
      const at = cellAt(e);
      pressed = null;
      send(this.cur, `\x1b[<0;${at[0]};${at[1]}m`);
    });
    screen.addEventListener('click', (e) => {
      if (!mouseOn(e) || e.pointerType !== 'touch') return;
      const [x, y] = cellAt(e);
      send(this.cur, `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
    });
    screen.addEventListener('click', () => {
      if (this.cur && this.cur.code !== null) this.onEndedKey();
    });
    // Scrolled up, the view stays where you put it while output comes in; back at the bottom, it
    // follows again. Only a move up counts: new output and trimmed scrollback move it too.
    screen.addEventListener(
      'scroll',
      () => {
        const t = this.cur;
        if (!t) return;
        if (screen.scrollTop < this.lastTop - 1) t.stick = false;
        else if (screen.scrollHeight - screen.scrollTop - screen.clientHeight < (this.cell?.h || 17)) t.stick = true;
        this.lastTop = screen.scrollTop;
      },
      { passive: true },
    );
    // Full-screen programs (claude, codex, opencode, vim, less: the alternate screen) scroll
    // themselves: the wheel, or a swipe on a phone, goes to them as mouse wheel events (or arrow
    // keys when they don't take the mouse). At the cell under the pointer: opencode scrolls the pane that's there.
    const wheelTo = (t, steps, up, at) => {
      const { mouse, sgrMouse, appCursor } = t.screen.modes;
      if (mouse && sgrMouse) send(t, `\x1b[<${up ? 64 : 65};${at[0]};${at[1]}M`.repeat(steps));
      else send(t, (up ? (appCursor ? '\x1bOA' : '\x1b[A') : appCursor ? '\x1bOB' : '\x1b[B').repeat(steps));
    };
    const appScrolls = (t) => t && t.code === null && (t.screen.alt || t.screen.modes.mouse);
    screen.addEventListener(
      'wheel',
      (e) => {
        const t = this.cur;
        if (!appScrolls(t)) return;
        e.preventDefault();
        wheelTo(t, Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40))), e.deltaY < 0, cellAt(e));
      },
      { passive: false },
    );
    let swipeY = null;
    screen.addEventListener(
      'touchstart',
      (e) => {
        swipeY = e.touches.length === 1 ? e.touches[0].clientY : null;
      },
      { passive: true },
    );
    screen.addEventListener(
      'touchmove',
      (e) => {
        const t = this.cur;
        if (swipeY === null || !appScrolls(t)) return;
        e.preventDefault();
        const y = e.touches[0].clientY;
        const step = (this.cell?.h || 17) * 1.5; // a finger moves further than a wheel notch
        const n = Math.trunc((y - swipeY) / step);
        if (!n) return;
        swipeY += n * step;
        wheelTo(t, Math.min(Math.abs(n), 10), n > 0, cellAt(e.touches[0])); // finger down: see what's above
      },
      { passive: false },
    );
    screen.addEventListener('touchend', () => {
      swipeY = null;
    });
    // The key row: it mustn't take the focus (the phone keyboard would close).
    const keys = $('.tm-keys', root);
    keys.addEventListener('pointerdown', (e) => e.target.closest('button') && e.preventDefault());
    keys.addEventListener('click', async (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      const t = this.cur;
      if (!k || !t) return;
      if (k === 'ctrl') return void ((this.ctrlOnce = !this.ctrlOnce), this.paintCtrl(), this.focus());
      if (k === 'paste') {
        try {
          typed(this.pasted(await navigator.clipboard.readText()));
        } catch {
          toast('Long-press in the terminal to paste.');
        }
        return this.focus();
      }
      const app = t.screen.modes.appCursor;
      const seq = { esc: '\x1b', ctrlc: '\x03', tab: '\t', stab: '\x1b[Z', up: app ? '\x1bOA' : '\x1b[A', down: app ? '\x1bOB' : '\x1b[B', right: app ? '\x1bOC' : '\x1b[C', left: app ? '\x1bOD' : '\x1b[D' }[k];
      if (this.ctrlOnce) (this.ctrlOnce = false), this.paintCtrl();
      typed(seq);
      this.focus();
    });
  }
}
