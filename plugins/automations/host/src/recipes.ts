// Recipes (v1 server/recipes.js): saved prompts for tasks you send again and again. `{name}` in the
// prompt is a parameter, filled in when the recipe runs (the run dialog, `wisp run release 0.8.0`, a trigger).

import path from 'node:path';
import type { Json } from '@wisp/kernel';
import type { Mode, PluginRecipe, Recipe, RecipeView } from '@wisp-plugin/automations-api';
import { bad, isMode, newId } from './util.ts';

const PARAM = /\{([a-zA-Z][\w-]{0,30})\}/g;

export const params = (prompt: string): string[] => [...new Set([...String(prompt || '').matchAll(PARAM)].map((m) => m[1] ?? ''))];

type Values = Readonly<Record<string, Json | undefined>>;
const has = (values: Values, k: string): boolean => {
  const v = values[k];
  return v !== undefined && v !== null && String(v).trim() !== '';
};

/**
 * strict: every parameter needs a value (a person ran it). Otherwise unknown ones become '' (a
 * trigger filling in an empty issue body). Values are inserted once, never re-expanded.
 */
export function fill(prompt: string, values: Values = {}, { strict = true }: { strict?: boolean } = {}): string {
  const missing = params(prompt).filter((k) => !has(values, k));
  if (strict && missing.length) throw bad(`Missing ${missing.map((k) => `{${k}}`).join(', ')}`);
  return String(prompt).replace(PARAM, (_, k: string) => (has(values, k) ? String(values[k]) : ''));
}

/** Positional CLI words into the parameters, in the order they appear. */
export function positional(prompt: string, words: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  params(prompt).forEach((k, i) => {
    const w = words[i];
    if (w !== undefined) out[k] = w;
  });
  return out;
}

const field = (body: Record<string, unknown>, prev: Recipe | null, k: keyof Recipe): string => String(body[k] ?? prev?.[k] ?? '');

export function normalizeRecipe(body: Record<string, unknown>, prev: Recipe | null, now: number): Recipe {
  const name = field(body, prev, 'name').trim().slice(0, 60);
  const prompt = field(body, prev, 'prompt').trim();
  if (!name) throw bad('A recipe needs a name.');
  if (!prompt) throw bad('A recipe needs a prompt.');
  const cwd = body['cwd'] !== undefined ? String(body['cwd'] || '') : prev?.cwd || '';
  if (cwd && !path.isAbsolute(cwd)) throw bad('cwd must be an absolute project path (or empty for any project).');
  const mode = body['mode'] ?? prev?.mode ?? '';
  if (mode && !isMode(mode)) throw bad('mode must be plan, edits or auto.');
  const effort = field(body, prev, 'effort');
  return {
    id: prev?.id || newId(),
    name,
    prompt,
    cwd,
    agent: field(body, prev, 'agent'),
    model: field(body, prev, 'model'),
    effort: /^[\w-]{0,20}$/.test(effort) ? effort : '',
    mode: mode as Mode | '',
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    runs: prev?.runs || 0,
    lastRunAt: prev?.lastRunAt || null,
  };
}

/** By id, else by name (case- and punctuation-insensitive): `wisp run "Release"` and `wisp run release`. */
export function findRecipe<R extends { id: string; name: string }>(recipes: readonly R[], key: string): R | null {
  const k = String(key || '');
  const loose = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return recipes.find((r) => r.id === k) ?? recipes.find((r) => loose(r.name) === loose(k)) ?? null;
}

export const recipeView = (r: Recipe | RecipeView): RecipeView => ({ ...r, params: params(r.prompt) });

/** A plugin's recipe as the list shows it: read-only, never run counts of its own. */
export function pluginRecipe(r: PluginRecipe): RecipeView {
  return recipeView({
    id: r.id, name: r.name, prompt: r.prompt, cwd: r.cwd ?? '', agent: r.agent ?? '', model: r.model ?? '', effort: r.effort ?? '',
    mode: r.mode ?? '', createdAt: 0, updatedAt: 0, runs: 0, lastRunAt: null, ...(r.plugin && { plugin: r.plugin }),
  });
}
