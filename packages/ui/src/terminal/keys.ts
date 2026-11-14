// What the terminal sends the program: keys, pastes, the phone's key row, mouse and wheel events,
// focus reports. Pure: the Terminal component calls these and hands the bytes to `onData`.

export interface KeyLike {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

const CTRL_SPECIAL: Readonly<Record<string, string>> = { ' ': '\x00', '@': '\x00', '2': '\x00', '[': '\x1b', '3': '\x1b', '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', _: '\x1f', '-': '\x1f', '/': '\x1f', '7': '\x1f', '?': '\x7f', '8': '\x7f' };
const F_TILDE: Readonly<Record<number, number>> = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 };
const NAMED: Readonly<Record<string, string>> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const TILDE: Readonly<Record<string, number>> = { PageUp: 5, PageDown: 6, Delete: 3, Insert: 2 };

/** What a key sends, or null for keys the page keeps (⌘C, ⌘V, …) and for text (it comes as input). */
export function keyBytes(k: KeyLike, o: { appCursor?: boolean; mac?: boolean } = {}): string | null {
  if (k.metaKey) return null;
  const mod = 1 + (k.shiftKey ? 1 : 0) + (k.altKey ? 2 : 0) + (k.ctrlKey ? 4 : 0);
  const tilde = (num: number): string => (mod > 1 ? `\x1b[${num};${mod}~` : `\x1b[${num}~`);
  switch (k.key) {
    case 'Enter':
      return k.shiftKey || k.altKey ? '\x1b\r' : '\r';
    case 'Backspace':
      return k.altKey || k.ctrlKey ? '\x1b\x7f' : '\x7f';
    case 'Tab':
      return k.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape':
      return '\x1b';
  }
  const named = NAMED[k.key];
  if (named) return mod > 1 ? `\x1b[1;${mod}${named}` : o.appCursor ? `\x1bO${named}` : `\x1b[${named}`;
  const t = TILDE[k.key];
  if (t !== undefined) return tilde(t);
  const f = /^F(\d{1,2})$/.exec(k.key);
  if (f) {
    const i = Number(f[1]);
    const pqrs = 'PQRS'.charAt(i - 1);
    if (i >= 1 && i <= 4) return mod > 1 ? `\x1b[1;${mod}${pqrs}` : `\x1bO${pqrs}`;
    const code = F_TILDE[i];
    return code ? tilde(code) : null;
  }
  if (k.key.length !== 1) return null;
  if (k.ctrlKey && !k.altKey) {
    const c = k.key.toLowerCase();
    if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
    return CTRL_SPECIAL[k.key] ?? null;
  }
  // Alt as Meta, except on a Mac where Option types characters (å, ∑, …): those come as text.
  if (k.altKey && !o.mac) return `\x1b${k.key}`;
  return null;
}

/** Pasted text as one block; bracketed when the program asked, with any end marker inside taken out. */
export function pasted(text: string, bracketed: boolean): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r');
  if (!body) return '';
  return bracketed ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~` : body;
}

/** The phone's key row: the keys a phone keyboard lacks. `ctrl` and `paste` are handled by the view. */
export const KEY_ROW = ['esc', 'ctrlc', 'tab', 'stab', 'ctrl', 'left', 'up', 'down', 'right', 'paste'] as const;
export type RowKey = (typeof KEY_ROW)[number];

export function rowKeyBytes(k: Exclude<RowKey, 'ctrl' | 'paste'>, appCursor: boolean): string {
  switch (k) {
    case 'esc':
      return '\x1b';
    case 'ctrlc':
      return '\x03';
    case 'tab':
      return '\t';
    case 'stab':
      return '\x1b[Z';
    case 'up':
      return appCursor ? '\x1bOA' : '\x1b[A';
    case 'down':
      return appCursor ? '\x1bOB' : '\x1b[B';
    case 'right':
      return appCursor ? '\x1bOC' : '\x1b[C';
    case 'left':
      return appCursor ? '\x1bOD' : '\x1b[D';
  }
}

/** SGR mouse: a press (button 0), a drag (32) or a release, at a 1-based cell. */
export const mousePress = (x: number, y: number): string => `\x1b[<0;${x};${y}M`;
export const mouseDrag = (x: number, y: number): string => `\x1b[<32;${x};${y}M`;
export const mouseRelease = (x: number, y: number): string => `\x1b[<0;${x};${y}m`;

/**
 * The wheel (or a swipe) for a program that scrolls itself: mouse wheel events at the cell under
 * the pointer when it takes the mouse, arrow keys when it doesn't.
 */
export function wheelBytes(steps: number, up: boolean, at: readonly [number, number], m: { mouse: number; sgrMouse: boolean; appCursor: boolean }): string {
  if (m.mouse && m.sgrMouse) return `\x1b[<${up ? 64 : 65};${at[0]};${at[1]}M`.repeat(steps);
  const arrow = up ? (m.appCursor ? '\x1bOA' : '\x1b[A') : m.appCursor ? '\x1bOB' : '\x1b[B';
  return arrow.repeat(steps);
}

export const FOCUS_IN = '\x1b[I';
export const FOCUS_OUT = '\x1b[O';

/**
 * A phone sends composed text as it's typed and corrects it as it changes: what to send to turn
 * `sent` into `now` (backspaces over what differs, then the rest).
 */
export function compose(sent: string, now: string): string {
  let i = 0;
  while (i < sent.length && i < now.length && sent[i] === now[i]) i++;
  return '\x7f'.repeat([...sent.slice(i)].length) + now.slice(i);
}
