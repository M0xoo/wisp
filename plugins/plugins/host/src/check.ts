// checkSpell: v1's normalizeSpell (server/spells.js). Validate and clean a v1 spell; refuse it with
// every problem listed. The cleaned spell is what is stored and what the converter reads, so
// checking a stored spell again gives it back unchanged.

import type { Section } from '@wisp-plugin/plugins-api';
import { type ActionCtx, Problems, arr, checkAction, obj, str } from './check-actions.ts';
import { blocks, buttons, chips, MAX_ITEMS, panels, parts, ui, type UiCtx } from './check-ui.ts';
import { checkCrew, checkRecipes } from './check-more.ts';
import { bad } from './errors.ts';
import { BUILTIN_SLASH, EVENTS, ghProblem, HOOK_IF, panesProblem, scriptBody, scriptExports, SPELL_VERSION, truncate, wispPathProblem } from './schema.ts';
import type { Command, DataSource, Hook, PromptRule, Scope, Slash, Spell } from './types.ts';
import { V1_VOCAB, type Vocab } from './vocabulary.ts';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_SCRIPT = 64 * 1024;
const MAX_PROMPT = 600; // characters per prompt rule
const KNOWN = new Set(['wispSpell', 'id', 'name', 'version', 'description', 'author', 'wisp', 'harnesses', 'when', 'data', 'buttons', 'chips', 'panels', 'blocks', 'parts', 'ui', 'prompt', 'settings', 'slash', 'commands', 'hooks', 'recipes', 'crew', 'script']);

export interface CheckOptions {
  vocab?: Vocab;
  /** sections other plugins check (`plugins.section`), by key */
  sections?: ReadonlyMap<string, Section>;
}

export interface Checked {
  spell: Spell;
  warnings: string[];
}

/** Where a prompt rule, block or hook applies: { project, agent, mode }. */
export function scopeOf(v: unknown): Scope | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const out: Scope = {};
  for (const k of ['project', 'agent', 'mode'] as const) if (o[k] !== undefined) out[k] = arr(o[k]).map((x) => str(x, 200));
  return Object.keys(out).length ? out : undefined;
}

function script(j: Record<string, unknown>, p: Problems): { script: string; fns: Set<string> } {
  const src = typeof j['script'] === 'string' ? j['script'] : '';
  if (src.length > MAX_SCRIPT) p.at('script', `at most ${MAX_SCRIPT / 1024} KB`);
  if (src) {
    try {
      new Function(scriptBody(src)); // compiles; never called here
    } catch (err) {
      p.at('script', `doesn't compile: ${(err as Error).message}`);
    }
  }
  return { script: src, fns: new Set(scriptExports(src)) };
}

// data: what wisp fetches for the spell. Spell code never fetches anything itself.
function data(raw: unknown, p: Problems): Record<string, DataSource> {
  const out: Record<string, DataSource> = {};
  for (const [k, v] of Object.entries(obj(raw) ?? {})) {
    const where = `data.${k}`;
    const x = obj(v);
    if (!/^[A-Za-z_][\w]{0,30}$/.test(k) || !x) {
      p.at(where, 'a source is { "wisp": "/sessions" } or { "gh": ["pr", "list", …] }');
      continue;
    }
    const refresh = Math.min(Math.max(Number(x['refresh']) || 60, 10), 3600);
    if (x['wisp'] !== undefined) {
      const e = wispPathProblem(x['wisp']);
      if (e) p.at(where, e);
      out[k] = { wisp: String(x['wisp']), refresh };
    } else if (x['gh'] !== undefined) {
      const e = ghProblem(x['gh']);
      if (e) p.at(where, e);
      out[k] = { gh: arr(x['gh']).map(String), refresh, ...(x['cwd'] === 'task' && { cwd: 'task' as const }) };
    } else p.at(where, 'a source is { "wisp": "/path" } or { "gh": [args] }');
  }
  return out;
}

function prompt(raw: unknown, p: Problems): PromptRule[] {
  return arr(raw).slice(0, MAX_ITEMS).map((r, i) => {
    const x = typeof r === 'string' ? { text: r } : (obj(r) ?? {});
    const text = String(x['text'] || '').trim();
    if (!text) p.at(`prompt[${i}]`, 'needs text');
    const when = scopeOf(x['when']);
    return { text: truncate(text, MAX_PROMPT), ...(when && { when }) };
  });
}

function settings(raw: unknown, p: Problems, warnings: string[], vocab: Vocab): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj(raw) ?? {})) {
    // The layout switch is gone (split view is the only one): spells that set it still load.
    if (k === 'view') {
      warnings.push('settings.view: split view is the only layout now, ignored');
      continue;
    }
    // Goals have no cap on rounds any more: they go on until the check says met, can't or stalled.
    if (k === 'goalRounds') {
      warnings.push('settings.goalRounds: goals keep going until they are met, ignored');
      continue;
    }
    const t = vocab.settings[k];
    if (!t) p.at(`settings.${k}`, `not a setting spells can change (${Object.keys(vocab.settings).join(', ')})`);
    else if (Array.isArray(t) ? !t.includes(v as string) : typeof v !== 'string') p.at(`settings.${k}`, Array.isArray(t) ? t.join(' | ') : 'a string');
    else if (k === 'panes' && panesProblem(v)) p.at('settings.panes', panesProblem(v));
    else out[k] = v;
  }
  return out;
}

function slash(raw: unknown, p: Problems, c: ActionCtx): Slash[] {
  return arr(raw).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) ?? {};
    const where = `slash[${i}]`;
    const name = String(x['name'] || '').replace(/^\//, '').toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,20}$/.test(name)) p.at(where, 'name: lowercase letters, digits and dashes');
    if (BUILTIN_SLASH.includes(name)) p.at(where, `/${name} is built in`);
    return { name, args: str(x['args'], 40), hint: str(x['hint'], 80), do: checkAction(x['do'], where, p, c) };
  });
}

function commands(raw: unknown, c: UiCtx): Command[] {
  return arr(raw).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) ?? {};
    const where = `commands[${i}]`;
    if (!x['label']) c.p.at(where, 'needs a label');
    const ic = x['icon'] === undefined || x['icon'] === '' ? '' : String(x['icon']);
    if (ic && !c.vocab.icons.includes(ic)) c.p.at(where, `icon must be one of ${c.vocab.icons.join(', ')}`);
    return { id: str(x['id'] || `k${i}`, 40), label: str(x['label'], 60), keywords: str(x['keywords'], 120), icon: ic, ...(x['key'] ? { key: str(x['key'], 20) } : {}), do: checkAction(x['do'], where, c.p, c) };
  });
}

function hooks(raw: unknown, p: Problems, c: ActionCtx): Hook[] {
  return arr(raw).slice(0, MAX_ITEMS).map((x0, i) => {
    const x = obj(x0) ?? {};
    const where = `hooks[${i}]`;
    const on = String(x['on']);
    if (!Object.hasOwn(EVENTS, on)) p.at(where, `on must be one of ${Object.keys(EVENTS).join(', ')}`);
    const cond = obj(x['if']) ?? {};
    for (const k of Object.keys(cond)) if (!HOOK_IF.includes(k)) p.at(where, `if.${k}: one of ${HOOK_IF.join(', ')}`);
    return { id: str(x['id'] || `h${i}`, 40), on, if: cond, max: Math.min(Math.max(Number(x['max']) || 1, 1), 10), do: checkAction(x['do'], where, p, { ...c, hook: true }) };
  });
}

/** Validate and clean a spell. Throws a 400 listing every problem (`problems` on the error). */
export function checkSpell(raw: unknown, opts: CheckOptions = {}): Checked {
  const p = new Problems();
  const j = obj(raw);
  if (!j) throw bad('A spell is a JSON object.');
  if (j['wispSpell'] !== SPELL_VERSION) p.at('wispSpell', `must be ${SPELL_VERSION}`);
  const id = String(j['id'] || '').trim();
  if (!ID.test(id)) p.at('id', 'lowercase letters, digits and dashes, starting with a letter or digit (at most 41)');
  const name = str(j['name'], 60).trim();
  if (!name) p.at('name', 'required');
  const warnings = Object.keys(j).filter((k) => !KNOWN.has(k)).map((k) => `${k}: not something spells know about yet, ignored`);
  const vocab = opts.vocab ?? V1_VOCAB;
  const { script: src, fns } = script(j, p);
  const src_ = data(j['data'], p);
  const panelIds = new Set(arr(j['panels']).map((x) => obj(x)?.['id']).filter(Boolean));
  const c: UiCtx = { p, vocab, panels: panelIds, data: new Set(Object.keys(src_)), fns, needFn: (fn, where) => void (fn && !fns.has(String(fn)) && p.at(where, `the script exports no function ${String(fn)}`)) };
  const sections = {
    buttons: buttons(c, j['buttons']),
    chips: chips(c, j['chips']),
    panels: panels(c, j['panels']),
    blocks: blocks(c, j['blocks']),
    parts: parts(c, j['parts']),
    ui: ui(c, j['ui'], warnings),
    prompt: prompt(j['prompt'], p),
    settings: settings(j['settings'], p, warnings, vocab),
    slash: slash(j['slash'], p, c),
    commands: commands(j['commands'], c),
    hooks: hooks(j['hooks'], p, c),
    recipes: checkRecipes(j['recipes'], id, p),
    crew: checkCrew(j['crew'], p, opts.sections?.get('crew')),
  };
  if (p.length) throw bad(`This spell has ${p.length} problem${p.length > 1 ? 's' : ''}:\n- ${p.join('\n- ')}`, 400, [...p]);
  return { spell: assemble(j, id, name, src, src_, sections), warnings };
}

type Sections = {
  buttons: Spell['buttons'] & {};
  chips: Spell['chips'] & {};
  panels: Spell['panels'] & {};
  blocks: Spell['blocks'] & {};
  parts: Spell['parts'] & {};
  ui: ReturnType<typeof ui>;
  prompt: PromptRule[];
  settings: Record<string, unknown>;
  slash: Slash[];
  commands: Command[];
  hooks: Hook[];
  recipes: Spell['recipes'] & {};
  crew: Spell['crew'] & {};
};

function assemble(j: Record<string, unknown>, id: string, name: string, src: string, data: Record<string, DataSource>, s: Sections): Spell {
  const when = scopeOf(j['when']);
  const { hide, tokens, dark } = s.ui;
  const some = <T>(k: string, v: T[]): Record<string, T[]> => (v.length ? { [k]: v } : {});
  const keyed = <T>(k: string, v: Record<string, T>): Record<string, Record<string, T>> => (Object.keys(v).length ? { [k]: v } : {});
  return {
    wispSpell: 1,
    id,
    name,
    version: str(j['version'] || '1.0.0', 20),
    description: str(j['description'], 400),
    author: str(j['author'], 60),
    ...(j['wisp'] ? { wisp: str(j['wisp'], 30) } : {}),
    harnesses: arr(j['harnesses']).length ? arr(j['harnesses']).map((h) => str(h, 20)) : ['*'],
    ...(when && { when }),
    ...keyed('data', data),
    ...some('buttons', s.buttons),
    ...some('chips', s.chips),
    ...some('panels', s.panels),
    ...some('blocks', s.blocks),
    ...keyed('parts', s.parts),
    ...(hide.length || tokens || dark ? { ui: { ...(hide.length && { hide }), ...(tokens && { tokens }), ...(dark && { dark }) } } : {}),
    ...some('prompt', s.prompt),
    ...keyed('settings', s.settings),
    ...some('slash', s.slash),
    ...some('commands', s.commands),
    ...some('hooks', s.hooks),
    ...some('recipes', s.recipes),
    ...some('crew', s.crew),
    ...(src && { script: src }),
  };
}
