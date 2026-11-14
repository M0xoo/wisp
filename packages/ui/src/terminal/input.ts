// The Terminal's input: keys, a phone's composing, pastes, focus reports, the mouse for programs
// that take it, the wheel and swipes for full-screen programs, and the phone's key row. Wired to
// plain elements so the component stays a thin shell; every listener goes with `signal`.

import { compose, FOCUS_IN, FOCUS_OUT, keyBytes, mouseDrag, mousePress, mouseRelease, pasted, rowKeyBytes, wheelBytes, type RowKey } from './keys.ts';
import type { Screen } from './screen.ts';

export interface InputHost {
  readonly box: HTMLElement;
  readonly live: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly signal: AbortSignal;
  screen(): Screen;
  ended(): boolean;
  mac(): boolean;
  touch(): boolean;
  /** bytes for the program; the view jumps to the bottom */
  type(data: string): void;
  /** bytes the program asked for (mouse, focus reports): sent without moving the view */
  send(data: string): void;
  endedKey(): void;
  cell(): { w: number; h: number };
  focus(): void;
  setFocused(on: boolean): void;
  ctrlOnce(): boolean;
  setCtrlOnce(on: boolean): void;
  pasteFailed(): void;
  /** the view's scroll position moved: it follows output again at the bottom */
  scrolled(): void;
}

const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, h: InputHost, passive?: boolean): void =>
  el.addEventListener(type, fn, { signal: h.signal, ...(passive !== undefined && { passive }) });

/** text typed or a key's bytes: Ctrl from the key row applies to the next single key */
function typed(h: InputHost, input: string): void {
  if (h.ended()) return h.endedKey();
  let data = input;
  if (h.ctrlOnce() && data.length === 1) {
    h.setCtrlOnce(false);
    data = keyBytes({ key: data, ctrlKey: true }) ?? data;
  }
  if (data) h.type(data);
}

export function wireKeys(h: InputHost): void {
  const ta = h.input;
  on(ta, 'keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey && e.key === '`') return; // ⌃` leaves the terminal: the one key it doesn't take
    e.stopPropagation(); // the app's own keys (Esc, J/K, …) stay out of the terminal
    if (h.ended()) return void (e.preventDefault(), h.endedKey());
    // ⌃C copies when text is selected (Windows, Linux); ⌘ keys stay the browser's.
    if (e.ctrlKey && !h.mac() && e.key.toLowerCase() === 'c' && String(ta.ownerDocument.getSelection() ?? '')) return;
    if (e.ctrlKey && e.shiftKey && ['c', 'v'].includes(e.key.toLowerCase())) return;
    let b = keyBytes(e, { appCursor: h.screen().modes.appCursor, mac: h.mac() });
    if (b === null && h.ctrlOnce() && e.key.length === 1) b = keyBytes({ key: e.key, ctrlKey: true });
    if (b === null) return;
    e.preventDefault();
    if (h.ctrlOnce()) h.setCtrlOnce(false);
    typed(h, b);
  }, h);
  wireText(h);
  on(ta, 'focus', () => {
    h.setFocused(true);
    focusReport(h, FOCUS_IN);
  }, h);
  on(ta, 'blur', () => {
    h.setFocused(false);
    focusReport(h, FOCUS_OUT);
  }, h);
}

/** Programs that asked (claude, codex) are told when the terminal gets and loses the keys. */
function focusReport(h: InputHost, seq: string): void {
  if (!h.ended() && h.screen().modes.focus) h.send(seq);
}

function wireText(h: InputHost): void {
  const ta = h.input;
  let composing = false;
  let sent = ''; // on a phone, composed text is sent as it's typed and corrected as it changes
  on(ta, 'beforeinput', (e) => {
    if (e.inputType === 'insertCompositionText' || (composing && e.inputType.startsWith('delete'))) return;
    e.preventDefault();
    if (e.inputType === 'insertText' && e.data) typed(h, e.data);
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') typed(h, '\r');
    else if (e.inputType === 'deleteContentBackward') typed(h, '\x7f');
    else if (e.inputType === 'insertFromPaste' && e.dataTransfer) typed(h, pasted(e.dataTransfer.getData('text/plain'), h.screen().modes.paste));
  }, h);
  on(ta, 'compositionstart', () => {
    composing = true;
    sent = '';
  }, h);
  on(ta, 'input', () => {
    if (!composing) return void (ta.value = '');
    if (h.touch()) {
      const out = compose(sent, ta.value);
      sent = ta.value;
      typed(h, out);
    }
  }, h);
  on(ta, 'compositionend', (e) => {
    composing = false;
    typed(h, h.touch() ? compose(sent, e.data || '') : e.data || '');
    sent = '';
    ta.value = '';
  }, h);
  on(ta, 'paste', (e) => {
    e.preventDefault();
    typed(h, pasted(e.clipboardData?.getData('text/plain') ?? '', h.screen().modes.paste));
  }, h);
}

/** the 1-based cell under a point */
function cellAt(h: InputHost, p: { clientX: number; clientY: number }): [number, number] {
  const r = h.live.getBoundingClientRect();
  const m = h.cell();
  const sc = h.screen();
  return [Math.max(1, Math.min(sc.cols, Math.floor((p.clientX - r.left) / m.w) + 1)), Math.max(1, Math.min(sc.rows, Math.floor((p.clientY - r.top) / m.h) + 1))];
}

/**
 * A program that takes the mouse (claude's full screen) gets clicks, taps and drags as SGR mouse
 * events at the cell under the pointer. Shift keeps the page's own text selection.
 */
export function wireMouse(h: InputHost): void {
  const box = h.box;
  const takes = (e: MouseEvent): boolean => !h.ended() && h.screen().modes.mouse !== 0 && h.screen().modes.sgrMouse && !e.shiftKey && e.button === 0;
  let pressed: [number, number] | null = null;
  on(box, 'mouseup', () => {
    if (!String(box.ownerDocument.getSelection() ?? '')) h.focus(); // a click puts the keys here, unless it selected text
  }, h);
  on(box, 'pointerdown', (e) => {
    if (!takes(e) || e.pointerType === 'touch') return; // a touch may be a swipe: sent on tap
    e.preventDefault();
    pressed = cellAt(h, e);
    h.send(mousePress(...pressed));
    h.focus();
  }, h);
  on(box, 'pointermove', (e) => {
    if (!pressed || h.screen().modes.mouse < 1002) return;
    const at = cellAt(h, e);
    if (at[0] === pressed[0] && at[1] === pressed[1]) return;
    pressed = at;
    h.send(mouseDrag(...at));
  }, h);
  box.ownerDocument.defaultView?.addEventListener('pointerup', (e) => {
    if (!pressed) return;
    const at = cellAt(h, e);
    pressed = null;
    h.send(mouseRelease(...at));
  }, { signal: h.signal });
  on(box, 'click', (e) => {
    if (h.ended()) return h.endedKey();
    if (!takes(e) || (e as PointerEvent).pointerType !== 'touch') return;
    const at = cellAt(h, e);
    h.send(mousePress(...at) + mouseRelease(...at));
  }, h);
}

/** Full-screen programs scroll themselves: the wheel, or a swipe, goes to them. */
export function wireScroll(h: InputHost): void {
  const box = h.box;
  const appScrolls = (): boolean => !h.ended() && (h.screen().alt !== null || h.screen().modes.mouse !== 0);
  on(box, 'scroll', () => h.scrolled(), h, true);
  on(box, 'wheel', (e) => {
    if (!appScrolls()) return;
    e.preventDefault();
    h.send(wheelBytes(Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40))), e.deltaY < 0, cellAt(h, e), h.screen().modes));
  }, h, false);
  let swipeY: number | null = null;
  on(box, 'touchstart', (e) => {
    swipeY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null;
  }, h, true);
  on(box, 'touchmove', (e) => {
    const t = e.touches[0];
    if (swipeY === null || !t || !appScrolls()) return;
    e.preventDefault();
    const step = h.cell().h * 1.5; // a finger moves further than a wheel notch
    const n = Math.trunc((t.clientY - swipeY) / step);
    if (!n) return;
    swipeY += n * step;
    h.send(wheelBytes(Math.min(Math.abs(n), 10), n > 0, cellAt(h, t), h.screen().modes)); // finger down: see what's above
  }, h, false);
  on(box, 'touchend', () => {
    swipeY = null;
  }, h);
}

/** The phone's key row. Its buttons never take the focus (the phone keyboard would close). */
export async function rowKey(h: InputHost, k: RowKey, clipboard: () => Promise<string>): Promise<void> {
  if (k === 'ctrl') {
    h.setCtrlOnce(!h.ctrlOnce());
    return h.focus();
  }
  if (k === 'paste') {
    try {
      typed(h, pasted(await clipboard(), h.screen().modes.paste));
    } catch {
      h.pasteFailed();
    }
    return h.focus();
  }
  if (h.ctrlOnce()) h.setCtrlOnce(false);
  typed(h, rowKeyBytes(k, h.screen().modes.appCursor));
  h.focus();
}
