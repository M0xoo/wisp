// An untrusted plugin's UI, as it may describe it (ADR-0048 §3): a tree of kit components by name with their typed
// props, text only. `clean` keeps what's on this list and drops the rest (an unknown component, a prop it doesn't
// take, a value of the wrong kind, HTML, `class`, `style`), so the app draws only the kit, as wisp draws it.
//
//   Node = string | { c: 'Stack', p?: { gap: '2' }, k?: Node[], on?: 'save' }
//
// `on` names the event the plugin hears back (a click, a value) — the only way anything goes back to it.
// kit.json beside it is the same list, for agents writing a plugin (wisp_plugin_schema, _check):
// test/remote-kit.test.ts fails when they differ, so change both.

export type Prop = 'string' | 'bool' | 'number' | readonly string[] | 'items' | 'node';

const SPACE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const ALIGN = ['start', 'center', 'end', 'stretch', 'baseline'] as const;
const JUSTIFY = ['start', 'center', 'end', 'between'] as const;
const TONE = ['ink', 'ink-2', 'muted', 'faint', 'neutral', 'accent', 'good', 'warn', 'bad', 'info'] as const;
const NOTE = ['neutral', 'accent', 'good', 'warn', 'bad', 'info'] as const;
const SIZE = ['xs', 'sm', 'md', 'lg'] as const;

/** The kit components an untrusted UI may name, and the props each takes. */
export const KIT: Readonly<Record<string, Readonly<Record<string, Prop>>>> = {
  Stack: { gap: SPACE, align: ALIGN, justify: JUSTIFY },
  Inline: { gap: SPACE, align: ALIGN, justify: JUSTIFY },
  Text: { size: SIZE, weight: ['regular', 'medium', 'semibold'], tone: TONE, mono: 'bool', truncate: 'bool' },
  Button: { variant: ['primary', 'secondary', 'ghost', 'danger'], size: ['xs', 'sm', 'md', 'lg'], disabled: 'bool', label: 'string' },
  Input: { value: 'string', placeholder: 'string', type: ['text', 'password', 'number', 'search'], size: ['sm', 'md', 'lg'], label: 'string' },
  Switch: { checked: 'bool', label: 'string', disabled: 'bool' },
  Select: { value: 'string', items: 'items', placeholder: 'string', label: 'string' },
  SettingsRow: { title: 'string', description: 'string', control: 'node' },
  ListRow: { title: 'string', sub: 'string' },
  Callout: { tone: NOTE, title: 'string' },
  Code: { text: 'string', block: 'bool', lang: 'string' },
  Markdown: { source: 'string' },
};

/** What can hold children (the rest takes its text from props). */
export const PARENTS: ReadonlySet<string> = new Set(['Stack', 'Inline', 'Text', 'Callout']);

export interface Desc {
  readonly c: string;
  readonly p: Readonly<Record<string, string | number | boolean | Desc | readonly { value: string; label: string }[]>>;
  readonly k: readonly (Desc | string)[];
  readonly on?: string;
}
export type Node = Desc | string;

const MAX_TEXT = 10_000;
const MAX_NODES = 2_000;
const MAX_DEPTH = 32;
const MAX_ITEMS = 200;
const EVENT = /^[\w.:-]{1,64}$/;
/** What a tree may hold: characters per text, nodes, levels, items per Select, the event name's pattern. */
export const LIMITS = { text: MAX_TEXT, nodes: MAX_NODES, depth: MAX_DEPTH, items: MAX_ITEMS, event: EVENT.source } as const;

function value(kind: Prop, v: unknown, budget: { n: number }, depth: number): Desc['p'][string] | undefined {
  if (kind === 'string') return typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined;
  if (kind === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  if (kind === 'node') {
    const n = node(v, budget, depth + 1);
    return n && typeof n !== 'string' ? n : undefined;
  }
  if (kind === 'items') {
    if (!Array.isArray(v)) return undefined;
    return v
      .slice(0, MAX_ITEMS)
      .flatMap((i: unknown) =>
        i && typeof i === 'object' && typeof (i as { value?: unknown }).value === 'string'
          ? [{ value: (i as { value: string }).value.slice(0, 200), label: String((i as { label?: unknown }).label ?? (i as { value: string }).value).slice(0, 200) }]
          : [],
      );
  }
  return typeof v === 'string' && kind.includes(v) ? v : undefined;
}

function node(v: unknown, budget: { n: number }, depth: number): Node | undefined {
  if (budget.n >= MAX_NODES || depth > MAX_DEPTH) return undefined;
  if (typeof v === 'string') {
    budget.n += 1;
    return v.slice(0, MAX_TEXT);
  }
  if (typeof v === 'number') {
    budget.n += 1;
    return String(v);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as { c?: unknown; p?: unknown; k?: unknown; on?: unknown };
  const spec = typeof o.c === 'string' && Object.hasOwn(KIT, o.c) ? KIT[o.c] : undefined;
  if (!spec || typeof o.c !== 'string') return undefined;
  budget.n += 1;
  const p: Record<string, Desc['p'][string]> = {};
  if (o.p && typeof o.p === 'object' && !Array.isArray(o.p)) {
    for (const [k, raw] of Object.entries(o.p as Record<string, unknown>)) {
      const kind = Object.hasOwn(spec, k) ? spec[k] : undefined;
      if (!kind) continue;
      const got = value(kind, raw, budget, depth);
      if (got !== undefined) p[k] = got;
    }
  }
  const k: Node[] = [];
  if (PARENTS.has(o.c) && Array.isArray(o.k)) {
    for (const child of o.k) {
      const n = node(child, budget, depth + 1);
      if (n !== undefined) k.push(n);
    }
  }
  const on = typeof o.on === 'string' && EVENT.test(o.on) ? o.on : undefined;
  return { c: o.c, p, k, ...(on !== undefined && { on }) };
}

/** What an untrusted UI sent, kept to the kit: anything else is dropped (a root that isn't a node draws nothing). */
export function clean(tree: unknown): Node | undefined {
  return node(tree, { n: 0 }, 0);
}
