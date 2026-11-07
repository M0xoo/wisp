// The kit shows no copy of its own: labels come from props. The exceptions are accessible names
// it must always have (a dialog's close button, a toast's dismiss), which go through `t`.
import { createContext, useContext, type JSX } from 'solid-js';

/** The kit's own strings, in English. A shell passes `t` to translate them. */
export const KIT_STRINGS = {
  close: 'Close',
  dismiss: 'Dismiss',
  loading: 'Loading',
  send: 'Send',
  resize: 'Resize',
  more: 'More',
  clear: 'Clear',
  'clear-all': 'Clear all',
  notifications: 'Notifications',
  'show-lines': 'Show {n} more lines',
  'show-file': 'Show {n} lines',
  'time.now': 'now',
  'time.seconds': '{n}s ago',
  'time.minutes': '{n}m ago',
  'time.hours': '{n}h ago',
  'time.days': '{n}d ago',
  'time.in-minutes': 'in {n} min',
  'no-results': 'No results',
  'diff.binary': 'Binary file not shown',
} as const;

export type KitString = keyof typeof KIT_STRINGS;
export type Translate = (key: KitString, vars?: Readonly<Record<string, string | number>>) => string;

/** Fills `{name}` placeholders. */
export function fill(text: string, vars?: Readonly<Record<string, string | number>>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export const englishT: Translate = (key, vars) => fill(KIT_STRINGS[key], vars);

const I18n = createContext<Translate>(englishT);

/** Gives every kit component below it a translator for the kit's own strings. */
export function KitProvider(props: { readonly t: Translate; readonly children?: JSX.Element }): JSX.Element {
  return <I18n.Provider value={props.t}>{props.children}</I18n.Provider>;
}

/** The translator: the component's own `t` prop if it has one, else the provider's, else English. */
export function useT(own?: () => Translate | undefined): Translate {
  const fromContext = useContext(I18n);
  return (key, vars) => (own?.() ?? fromContext)(key, vars);
}
