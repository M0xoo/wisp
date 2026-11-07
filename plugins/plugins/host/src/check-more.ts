// The sections of a spell another plugin owns: recipes (saved prompts) and crew members. Crew
// blueprints are wisp.crew's to check (its `plugins.section` contribution); without it, the rules
// that keep a shared member safe still hold here: no folder, no machine, a name, unique keys.

import type { Section } from '@wisp-plugin/plugins-api';
import { type Problems, arr, obj, str } from './check-actions.ts';
import { MAX_ITEMS } from './check-ui.ts';
import type { Blueprint, Recipe } from './types.ts';

export const SPELL_CREW_MAX = 10;
const MODES = new Set(['plan', 'edits', 'auto']);
const KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/** v1 recipes.js normalizeRecipe, as far as a spell's recipe goes; ids are `spell-<spell>-<id>`. */
export function checkRecipes(raw: unknown, spellId: string, p: Problems): Recipe[] {
  return arr(raw).slice(0, MAX_ITEMS).flatMap((r, i) => {
    const x = obj(r) ?? {};
    const name = String(x['name'] ?? '').trim().slice(0, 60);
    const prompt = String(x['prompt'] ?? '').trim();
    const cwd = x['cwd'] !== undefined ? String(x['cwd'] || '') : '';
    const mode = String(x['mode'] ?? '');
    const problem = !name ? 'A recipe needs a name.' : !prompt ? 'A recipe needs a prompt.' : cwd && !isAbsolute(cwd) ? 'cwd must be an absolute project path (or empty for any project).' : mode && !MODES.has(mode) ? 'mode must be plan, edits or auto.' : '';
    if (problem) return p.at(`recipes[${i}]`, problem), [];
    const rid = String(x['id'] ?? i).replace(/[^\w-]/g, '');
    const pick = (k: string): string => String(x[k] ?? '');
    return [{ id: rid.startsWith(`spell-${spellId}-`) ? rid : `spell-${spellId}-${rid}`, name, prompt, cwd, agent: pick('agent'), model: pick('model'), effort: pick('effort'), mode }];
  });
}

const handleOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);

/** The minimum a shared crew member must hold, when wisp.crew isn't on to check the rest. */
function blueprint(raw: unknown): Blueprint {
  const x = obj(raw);
  if (!x) throw new Error('A crew member is a JSON object with at least a name.');
  for (const k of ['cwd', 'machine']) if (x[k]) throw new Error(`${k}: a shared member has no ${k === 'cwd' ? 'folder' : 'machine'}; whoever adds them picks one.`);
  const name = String(x['name'] || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('name: required');
  const key = x['key'] === undefined || x['key'] === '' ? handleOf(name) || 'member' : String(x['key']);
  if (!KEY.test(key)) throw new Error('key: lowercase letters, digits and dashes (at most 41)');
  const mode = MODES.has(String(x['mode'])) ? String(x['mode']) : 'plan';
  return { ...x, key, name, mode, cron: str(x['cron'], 100), on: arr(x['on']).map(String), kit: arr(x['kit']), team: arr(x['team']) };
}

function fallback(list: readonly unknown[], where: string): Blueprint[] {
  const out = list.map((x, i) => {
    try {
      return blueprint(x);
    } catch (err) {
      const n = obj(x)?.['name'];
      throw new Error(`${where}[${i}]${n ? ` (${str(n, 24)})` : ''}: ${(err as Error).message}`);
    }
  });
  const seen = new Map<string, string>();
  out.forEach((b, i) => {
    const key = String(b['key']);
    const h = handleOf(String(b['name']));
    if (seen.has(key) || [...seen.values()].includes(h)) throw new Error(`${where}[${i}] (${String(b['name'])}): two members share the key ${key} or the name ${String(b['name'])}`);
    seen.set(key, h);
  });
  return out;
}

export function checkCrew(raw: unknown, p: Problems, section?: Section): Blueprint[] {
  const list = arr(raw);
  const max = section?.max ?? SPELL_CREW_MAX;
  if (list.length > max) p.at('crew', `at most ${max} members`);
  try {
    const some = list.slice(0, max);
    return section ? (section.check(some, 'crew') as Blueprint[]) : fallback(some, 'crew');
  } catch (err) {
    p.push((err as Error).message);
    return [];
  }
}
