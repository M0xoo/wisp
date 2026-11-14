// The trigger editor's "When" (ADR-0043 §2: sources as a point; the app's "When picker grouped by source"),
// DOM-free: the sources `automations.sources` lists, grouped by the plugin that owns them, each source's fields
// from its JSON Schema (strings, numbers and switches; anything else is left to the formula), and the trigger
// spec the form writes (`resources.apply`, kind `trigger`).

export interface SourceRow {
  readonly plugin: string;
  readonly available: boolean;
  readonly on: string;
  readonly title: string;
  readonly fields: unknown;
  readonly mode: string;
}

export interface Field {
  readonly key: string;
  readonly title: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
  readonly hint?: string;
}

/** The sources by owner, in the order they came, `manual` last; unavailable ones are kept but marked. */
export function groups(rows: readonly SourceRow[]): { plugin: string; sources: SourceRow[] }[] {
  const out: { plugin: string; sources: SourceRow[] }[] = [];
  for (const r of [...rows].sort((a, b) => Number(a.on === 'manual') - Number(b.on === 'manual'))) {
    const g = out.find((x) => x.plugin === r.plugin) ?? (out.push({ plugin: r.plugin, sources: [] }), out[out.length - 1]);
    g?.sources.push(r);
  }
  return out;
}

/** A plugin id as a group heading: `wisp.runtime` → "Runtime". */
export const pluginName = (id: string): string => {
  const s = id.replace(/^wisp\./, '').replace(/[-_.]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The fields the editor shows for a source: its schema's simple properties. */
export function fieldsOf(schema: unknown): Field[] {
  const s = schema as { properties?: Record<string, { type?: unknown; title?: unknown; description?: unknown }>; required?: unknown } | null;
  const props = s?.properties ?? {};
  const required = Array.isArray(s?.required) ? (s?.required as unknown[]) : [];
  const out: Field[] = [];
  for (const [key, p] of Object.entries(props)) {
    const type = p.type === 'integer' ? 'number' : p.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    out.push({ key, title: typeof p.title === 'string' ? p.title : key, type, required: required.includes(key), ...(typeof p.description === 'string' && { hint: p.description }) });
  }
  return out;
}

/** A trigger's name, as the resource kind takes it: lowercase words joined by '-'. */
export const nameOf = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

/** The spec the form writes, or what's missing. Empty fields are left out; numbers are numbers. */
export function specOf(form: { on: string; prompt: string; values: Readonly<Record<string, string | boolean>> }, fields: readonly Field[]): { spec: Record<string, unknown> } | { missing: string } {
  if (!form.on) return { missing: 'on' };
  if (!form.prompt.trim()) return { missing: 'prompt' };
  const spec: Record<string, unknown> = { on: form.on, prompt: form.prompt.trim() };
  for (const f of fields) {
    const v = form.values[f.key];
    if (f.type === 'boolean') {
      if (v === true) spec[f.key] = true;
      continue;
    }
    const text = typeof v === 'string' ? v.trim() : '';
    if (!text) {
      if (f.required) return { missing: f.key };
      continue;
    }
    if (f.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) return { missing: f.key };
      spec[f.key] = n;
    } else spec[f.key] = text;
  }
  return { spec };
}
