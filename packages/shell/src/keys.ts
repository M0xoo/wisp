// Keyboard shortcuts (v1 web/js/features/keys.js), as data: a combo string per shortcut, matched
// against the key event, plus the dispatch rules v1 learned:
//   - ⌘K / ⌘L work from anywhere, even mid-sentence ('always');
//   - single keys never fire while typing, with a modifier held, or with an overlay up ('idle');
//   - the task keys need a focused task ('task');
//   - Safari ends an IME composition before the keydown that ended it: an Enter or Escape with
//     keyCode 229 and isComposing false picked a word, and must not send or close anything;
//   - a user plugin can't take a key wisp uses itself (BUILT_IN_KEYS); built-ins (wisp.*) can.
// Pure: the dispatcher takes the event and the state, and returns what to run.

import type { KeyCombo, ShortcutDef } from './contract.ts';

/** The part of a KeyboardEvent the matcher reads. */
export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Keys wisp's own plugins use (v1 keys.js BUILT_IN): a user plugin's shortcut can't take them. */
export const BUILT_IN_KEYS: ReadonlySet<string> = new Set([
  'n', 'j', 'k', 'o', 'enter', 'e', 'a', 'l', 'c', 'u', 'home', 'm', 'delete', 'backspace', 't', 'shift+r', 'shift+f',
  's', 'r', 'v', '/', '?', 'escape', '\\', '[', ']', 'p', 'd', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'mod+k', 'mod+l', 'ctrl+`', 'ctrl+tab', 'ctrl+shift+tab',
]);

interface Parsed {
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const ALIASES: Record<string, string> = { esc: 'escape', return: 'enter', del: 'delete', space: ' ', backquote: '`' };

export function parseCombo(combo: KeyCombo): Parsed {
  const parts = combo.toLowerCase().split('+');
  // 'shift++' is shift and plus: an empty last part means the key was '+'
  const raw = parts.at(-1) === '' ? '+' : (parts.at(-1) ?? '');
  const mods = new Set(parts.slice(0, raw === '+' ? -2 : -1));
  return { key: ALIASES[raw] ?? raw, mod: mods.has('mod'), ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift') };
}

/** Letters, digits and named keys carry Shift as a modifier; '?' or '{' already say it. */
const shiftMatters = (key: string): boolean => /^[a-z0-9]$/.test(key) || key.length > 1;

function keyOf(e: KeyLike): string {
  if (e.code === 'Backquote') return '`';
  return e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
}

export function matches(combo: KeyCombo, e: KeyLike, apple: boolean): boolean {
  const p = parseCombo(combo);
  if (keyOf(e) !== p.key) return false;
  const wantMeta = p.mod && apple;
  const wantCtrl = p.ctrl || (p.mod && !apple);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== p.alt) return false;
  return !shiftMatters(p.key) || e.shiftKey === p.shift;
}

/** How a combo reads on this computer, for <Kbd keys>: ['⌘', 'K'] or ['Ctrl', 'K']. */
export function displayCombo(combo: KeyCombo, apple: boolean): string[] {
  const p = parseCombo(combo);
  const out: string[] = [];
  if (p.ctrl) out.push(apple ? '⌃' : 'Ctrl');
  if (p.mod) out.push(apple ? '⌘' : 'Ctrl');
  if (p.alt) out.push(apple ? '⌥' : 'Alt');
  if (p.shift) out.push('⇧');
  const named: Record<string, string> = { escape: 'esc', enter: '↵', delete: 'Del', backspace: '⌫', home: 'Home', tab: 'Tab', ' ': 'Space' };
  out.push(named[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key));
  return out;
}

/** The IME guard: this keydown only picked a word in Safari. */
export function imeArtifact(e: KeyLike): boolean {
  return e.keyCode === 229 && e.isComposing !== true && (e.key === 'Enter' || e.key === 'Escape');
}

export interface KeyState {
  readonly typing: boolean;
  readonly overlay: boolean;
  readonly focused: string | undefined;
  readonly apple: boolean;
}

export type Owned = ShortcutDef & { readonly plugin: string };

/** May this plugin's shortcut take its key? */
export function allowed(s: Owned): boolean {
  if (s.plugin.startsWith('wisp.') || s.plugin === 'shell') return true;
  const p = parseCombo(s.keys);
  const canon = `${p.mod ? 'mod+' : ''}${p.ctrl ? 'ctrl+' : ''}${p.alt ? 'alt+' : ''}${p.shift ? 'shift+' : ''}${p.key}`;
  return !BUILT_IN_KEYS.has(canon);
}

/** The shortcuts this key may run, in the order to try them (later registrations first). */
export function candidates(list: readonly Owned[], e: KeyLike, st: KeyState): Owned[] {
  const modded = e.metaKey || e.ctrlKey || e.altKey;
  const out: Owned[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s || !matches(s.keys, e, st.apple) || !allowed(s)) continue;
    const when = s.when ?? 'idle';
    if (when !== 'always') {
      // a single key while typing is a letter; with an overlay up it's the overlay's
      const isEscape = parseCombo(s.keys).key === 'escape';
      if ((st.typing && !isEscape) || st.overlay) continue;
      if (modded && !parseCombo(s.keys).mod && !parseCombo(s.keys).ctrl && !parseCombo(s.keys).alt) continue;
      if (when === 'task' && st.focused === undefined) continue;
    }
    out.push(s);
  }
  return out;
}
