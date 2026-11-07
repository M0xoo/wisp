// The UI half of checkSpell: buttons, chips, panels, agent blocks, parts and ui (hide, tokens). Each
// returns the cleaned section and pushes every problem, as v1's normalizeSpell did.

import { type ActionCtx, Problems, arr, checkAction, obj, str } from './check-actions.ts';
import { BUILTIN_BLOCKS, kebab, paneWidthsProblem, styleProblem } from './schema.ts';
import type { BlockDef, Button, Chip, PartOut, Panel } from './types.ts';
import { ANSWER_BOX, BUTTON_SLOTS, CARD_HEAD_ORDER, PROP_RANGE, type Vocab } from './vocabulary.ts';

export const MAX_ITEMS = 40; // per list in a spell
const MAX_DOC = 400; // characters per agent block doc
const WHEN_KEYS = ['hasPr', 'prState', 'state', 'status', 'agent', 'project', 'unread', 'hasBranch'];
const TONES = ['good', 'bad', 'warn', 'info', 'neutral'];

export interface UiCtx extends ActionCtx {
  p: Problems;
  vocab: Vocab;
  needFn(fn: unknown, where: string): void;
}

const when = (v: unknown): Record<string, unknown> | undefined => {
  const o = obj(v);
  return o ? Object.fromEntries(Object.entries(o).filter(([k]) => WHEN_KEYS.includes(k))) : undefined;
};
// v1 kept an empty `when: {}` too (an object is truthy)
const nonEmpty = (w: Record<string, unknown> | undefined): w is Record<string, unknown> => w !== undefined;

function icon(c: UiCtx, v: unknown, where: string): string {
  if (v === undefined || v === '') return '';
  if (typeof v !== 'string' || !c.vocab.icons.includes(v)) c.p.at(where, `icon must be one of ${c.vocab.icons.join(', ')}`);
  return String(v);
}

function slotOk(c: UiCtx, slot: unknown, where: string, allowed?: readonly string[]): void {
  if (typeof slot !== 'string' || !Object.hasOwn(c.vocab.slots, slot)) c.p.at(where, `slot must be one of ${Object.keys(c.vocab.slots).join(', ')}`);
  else if (allowed && !allowed.includes(slot)) c.p.at(where, `this goes in ${allowed.join(', ')}`);
}

function badge(c: UiCtx, x: Record<string, unknown>, where: string): Button['badge'] | undefined {
  const b = obj(x['badge']);
  if (!b) return undefined;
  if (b['count'] && !c.data.has(String(b['count']))) c.p.at(where, `badge counts ${String(b['count'])}, which isn't a data source`);
  if (b['fn']) c.needFn(b['fn'], where);
  if (b['count']) return { count: str(b['count'], 40) };
  if (b['fn']) return { fn: str(b['fn'], 60), data: arr(b['with'] ?? b['data']).map((d) => str(d, 40)) };
  return { text: str(b['text'], 40) };
}

export function buttons(c: UiCtx, raw: unknown): Button[] {
  return arr(raw).slice(0, MAX_ITEMS).map((b, i) => {
    const where = `buttons[${i}]`;
    const x = obj(b) ?? {};
    slotOk(c, x['slot'], where, BUTTON_SLOTS);
    const label = str(x['label'], 40);
    if (!label && !x['icon']) c.p.at(where, 'needs a label or an icon');
    const bd = badge(c, x, where);
    const w = when(x['when']);
    return {
      id: str(x['id'] || `b${i}`, 40),
      slot: String(x['slot']),
      label,
      icon: icon(c, x['icon'], where),
      title: str(x['title'], 120),
      ...(bd && { badge: bd }),
      ...(x['group'] ? { group: str(x['group'], 30) } : {}),
      ...(x['corner'] ? { corner: x['corner'] === 'bottom-left' ? ('bottom-left' as const) : ('bottom-right' as const) } : {}),
      ...(x['key'] ? { key: str(x['key'], 20) } : {}),
      ...(nonEmpty(w) && { when: w }),
      ...(x['primary'] ? { primary: true as const } : {}),
      do: checkAction(x['do'], where, c.p, c),
    };
  });
}

export function chips(c: UiCtx, raw: unknown): Chip[] {
  return arr(raw).slice(0, MAX_ITEMS).map((ch, i) => {
    const where = `chips[${i}]`;
    const x = obj(ch) ?? {};
    slotOk(c, x['slot'], where, ['card.head', 'launcher.chips', 'composer.chips']);
    if (!x['text'] && !x['fn']) c.p.at(where, 'needs text (a {field} template) or fn');
    c.needFn(x['fn'], where);
    const w = when(x['when']);
    return {
      id: str(x['id'] || `c${i}`, 40),
      slot: String(x['slot']),
      text: str(x['text'], 120),
      ...(x['fn'] ? { fn: str(x['fn'], 60), data: arr(x['with'] ?? x['data']).map((d) => str(d, 40)) } : {}),
      tone: typeof x['tone'] === 'string' && TONES.includes(x['tone']) ? x['tone'] : 'neutral',
      icon: icon(c, x['icon'], where),
      title: str(x['title'], 160),
      ...(nonEmpty(w) && { when: w }),
      ...(x['do'] ? { do: checkAction(x['do'], where, c.p, c) } : {}),
    };
  });
}

const clampRefresh = (v: unknown): number => Math.min(Math.max(Number(v) || 60, 10), 3600);

export function panels(c: UiCtx, raw: unknown): Panel[] {
  return arr(raw).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) ?? {};
    const where = `panels[${i}]`;
    if (!x['id']) c.p.at(where, 'needs an id');
    const as = (['dialog', 'drawer', 'feed', 'card'] as const).find((a) => a === x['as']) ?? 'dialog';
    if (as === 'card' && !['card.top', 'card.bottom'].includes(String(x['slot']))) c.p.at(where, 'a card panel needs slot card.top or card.bottom');
    if (!x['render']) c.p.at(where, 'needs render: the script function that returns its blocks');
    c.needFn(x['render'], where);
    for (const d of arr(x['data'])) if (!c.data.has(String(d))) c.p.at(where, `no data source named ${String(d)}`);
    const refresh = obj(x['refresh']) ?? {};
    const w = when(x['when']);
    return {
      id: str(x['id'], 40),
      title: str(x['title'], 80),
      icon: icon(c, x['icon'], where),
      as,
      ...(as === 'card' && { slot: String(x['slot']) }),
      data: arr(x['data']).map((d) => str(d, 40)),
      render: str(x['render'], 60),
      ...(nonEmpty(w) && { when: w }),
      refresh: { ...(refresh['every'] ? { every: clampRefresh(refresh['every']) } : {}), on: arr(refresh['on']).filter((e): e is string => typeof e === 'string' && ['summary', 'finished', 'config'].includes(e)) },
    };
  });
}

export function blocks(c: UiCtx, raw: unknown): BlockDef[] {
  return arr(raw).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) ?? {};
    const where = `blocks[${i}]`;
    const type = String(x['type'] || '');
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(type)) c.p.at(where, 'type: lowercase letters, digits and dashes');
    if (BUILTIN_BLOCKS.includes(type)) c.p.at(where, `${type} is a built-in block`);
    if (!x['doc']) c.p.at(where, 'needs doc: a JSON example and when an agent should use it');
    if (!x['render']) c.p.at(where, 'needs render: the script function that turns it into wisp blocks');
    c.needFn(x['render'], where);
    return { type, doc: str(x['doc'], MAX_DOC), summary: str(x['summary'], 200), render: str(x['render'], 60) };
  });
}

function propProblem(t: string | readonly string[], val: unknown): string | undefined {
  if (Array.isArray(t)) return t.includes(val as string) ? undefined : t.join(' | ');
  const range = PROP_RANGE[t as string];
  if (range) return Number.isInteger(val) && Number(val) >= range[0] && Number(val) <= range[1] ? undefined : `${String(t)} from ${range[0]} to ${range[1]}`;
  if (t === 'bool') return typeof val === 'boolean' ? undefined : 'bool';
  return typeof val === 'string' ? undefined : String(t);
}

function props(c: UiCtx, name: string, raw: unknown, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = c.vocab.partProps[name] ?? {};
  for (const [k, val] of Object.entries(obj(raw) ?? {})) {
    const t = allowed[k];
    const names = Object.keys(allowed);
    if (!t) c.p.at(where, `${k} isn't a prop of ${name}${names.length ? ` (${names.join(', ')})` : ''}`);
    else {
      const why = propProblem(t, val);
      if (why) c.p.at(where, `${k}: ${why}`);
      else if (name === 'split.panes' && k === 'widths' && paneWidthsProblem(val)) c.p.at(where, paneWidthsProblem(val));
      else out[k] = typeof val === 'string' ? str(val, 160) : val;
    }
  }
  return out;
}

export function parts(c: UiCtx, raw: unknown): Record<string, PartOut> {
  const out: Record<string, PartOut> = {};
  for (const [name, v] of Object.entries(obj(raw) ?? {})) {
    const where = `parts.${name}`;
    if (!c.vocab.parts.has(name)) {
      c.p.at(where, 'not a part (see the part list)');
      continue;
    }
    const x = obj(v) ?? {};
    const part: PartOut = {};
    if (x['style']) {
      const style: Record<string, string> = {};
      for (const [k, val] of Object.entries(obj(x['style']) ?? {})) {
        const e = styleProblem(k, val);
        if (e) c.p.at(where, e);
        else style[kebab(k)] = String(val).trim();
      }
      part.style = style;
    }
    if (x['props']) part.props = props(c, name, x['props'], where);
    if (x['order']) {
      if (name !== 'card.head') c.p.at(where, 'order is only for card.head');
      const order = arr(x['order']).filter((k): k is string => typeof k === 'string' && CARD_HEAD_ORDER.includes(k));
      if (order.length !== arr(x['order']).length) c.p.at(where, `order takes ${CARD_HEAD_ORDER.join(', ')}`);
      part.order = order;
    }
    out[name] = part;
  }
  return out;
}

/** ui: hide and tokens. Hiding the reply box is kept, with a warning: it still shows while asked. */
export function ui(c: UiCtx, raw: unknown, warnings: string[]): { hide: string[]; tokens: Record<string, unknown> | null; dark: Record<string, unknown> | null } {
  const u = obj(raw) ?? {};
  const hide = arr(u['hide']).filter((h): h is string => {
    if (typeof h === 'string' && c.vocab.parts.has(h)) return true;
    c.p.at('ui.hide', `${String(h)} isn't a part`);
    return false;
  });
  for (const h of hide.filter((x) => ANSWER_BOX.includes(x))) warnings.push(`ui.hide ${h}: the reply box still shows while a task waits on your answer, since that's where you answer it`);
  const tokens = (o: unknown, where: string): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(obj(o) ?? {}).filter(([k, v]) => {
        if (!c.vocab.tokens.includes(k)) return c.p.at(where, `${k} isn't a token (${c.vocab.tokens.join(', ')})`), false;
        return styleProblem('color', v) ? (c.p.at(where, `${k}: value not allowed`), false) : true;
      }),
    );
  return { hide, tokens: u['tokens'] ? tokens(u['tokens'], 'ui.tokens') : null, dark: u['dark'] ? tokens(u['dark'], 'ui.dark') : null };
}

export { Problems };
