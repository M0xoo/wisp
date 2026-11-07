// What a button, chip, slash command, ⌘K command or hook does (`do`), checked as v1's checkAction
// did, word for word: a spell names exactly one action, and a hook only the ones safe to run alone.

import { ACTIONS, HOOK_ACTIONS, clip, truncate } from './schema.ts';
import type { Action } from './types.ts';

/** Every check pushes one line; a spell with any is refused. */
export class Problems extends Array<string> {
  at(where: string, msg: string): void {
    this.push(`${where}: ${msg}`);
  }
}

export const str = (v: unknown, n = 200): string => (v === undefined || v === null ? '' : clip(String(v), n));
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export interface ActionCtx {
  hook?: boolean;
  panels: ReadonlySet<unknown>;
  data: ReadonlySet<string>;
  fns: ReadonlySet<string>;
}

const TEXT_ACTIONS = new Set(['insert', 'copy', 'toast', 'send', 'reply', 'notify', 'exec', 'recipe']);
const FLAG_ACTIONS = new Set(['ship', 'done', 'archive', 'forLater', 'compact']);
const RUN_ACTIONS = new Set(['setLaunch', 'launchWith', 'rerun', 'fork', 'side', 'launch']);
const RUN_FIELDS = ['agent', 'model', 'effort', 'mode', 'text', 'prompt', 'cwd'];
const NEEDS_PROMPT: Readonly<Record<string, string>> = { launch: 'task should do', fork: 'fork should try', side: 'side discussion should talk over' };

const text = (x: unknown): boolean => typeof x === 'string' && !!x.trim();

function openAll(v: unknown, where: string, p: Problems, c: ActionCtx): Action | null {
  const x = obj(v);
  // { fn, with } (or `data`, as stored): links a script function returns from those sources.
  if (x?.['fn']) {
    if (!c.fns.has(String(x['fn']))) p.at(where, `openAll: the script exports no function ${String(x['fn'])}`);
    return { openAll: { fn: str(x['fn'], 60), data: arr(x['with'] ?? x['data']).map((d) => str(d, 40)) } };
  }
  if (x?.['data']) {
    if (!c.data.has(String(x['data']))) p.at(where, `openAll: no data source named ${String(x['data'])}`);
    return { openAll: { data: str(x['data'], 40), field: str(x['field'] || 'url', 60) } };
  }
  p.at(where, 'openAll needs { "data": "<source>", "field": "url" } or { "fn": "<script function>" }');
  return null;
}

function runAction(k: string, v: unknown, where: string, p: Problems): Action {
  const x = obj(v) ?? {};
  const out: Record<string, string> = {};
  for (const f of RUN_FIELDS) if (x[f] !== undefined) out[f] = f === 'prompt' || f === 'text' ? truncate(String(x[f]), 4000) : str(x[f], 200);
  if (out['mode'] && !['plan', 'edits', 'auto'].includes(out['mode'])) p.at(where, 'mode must be plan, edits or auto');
  const what = NEEDS_PROMPT[k];
  if (what && !out['prompt']) p.at(where, `${k} needs a prompt: what the ${what}`);
  if (k === 'side' && out['mode']) p.at(where, 'side takes no mode: a side discussion only reads');
  return { [k]: out };
}

/** The action, cleaned, or null (with the problem pushed). */
export function checkAction(a: unknown, where: string, p: Problems, c: ActionCtx): Action | null {
  const o = obj(a);
  if (!o) return p.at(where, 'do must be an object like { "open": "https://…" }'), null;
  const keys = Object.keys(o).filter((k) => Object.hasOwn(ACTIONS, k));
  const k = keys[0];
  if (keys.length !== 1 || k === undefined) return p.at(where, `do needs exactly one of ${Object.keys(ACTIONS).join(', ')}`), null;
  const v = o[k];
  if (c.hook && !HOOK_ACTIONS.has(k)) return p.at(where, `a hook can only ${[...HOOK_ACTIONS].join(', ')}`), null;
  if (k === 'open' || k === 'webhook') {
    // A link, or a template that becomes one ({pr.url}); the page checks the filled-in link again.
    const s = typeof v === 'string' ? v.trim() : '';
    if (!text(v) || !(/^https?:\/\//i.test(s) || (k === 'open' && /^\{[\w.]+\}/.test(s)))) p.at(where, `${k} needs an http(s) URL`);
    return { [k]: str(v, 500) };
  }
  if (k === 'openAll') return openAll(v, where, p, c);
  if (k === 'panel') {
    if (!c.panels.has(v)) p.at(where, `no panel named ${String(v)}`);
    return { panel: str(v, 40) };
  }
  if (TEXT_ACTIONS.has(k)) {
    if (!text(v)) p.at(where, `${k} needs text`);
    // Kept as written (line breaks, a trailing space after "Explain why "), only capped.
    return { [k]: k === 'exec' ? str(v, 1000) : truncate(String(v ?? ''), 4000) };
  }
  if (FLAG_ACTIONS.has(k)) return { [k]: true };
  if (RUN_ACTIONS.has(k)) return runAction(k, v, where, p);
  return null;
}
