// Recipes: saved prompts for tasks you send again and again. `{name}` in the prompt is a
// parameter, filled in when the recipe runs (the run dialog, `wisp run release 0.8.0`, a trigger).

import path from 'node:path';
import { bad, MODES, newId } from './util.js';

const PARAM = /\{([a-zA-Z][\w-]{0,30})\}/g;

export const params = (prompt) => [...new Set([...String(prompt || '').matchAll(PARAM)].map((m) => m[1]))];

// strict: every parameter needs a value (a person ran it). Otherwise unknown ones become ''
// (a trigger filling in an empty issue body). Values are inserted once, never re-expanded.
export function fill(prompt, values = {}, { strict = true } = {}) {
  const has = (k) => values[k] !== undefined && values[k] !== null && String(values[k]).trim() !== '';
  const missing = params(prompt).filter((k) => !has(k));
  if (strict && missing.length) throw bad(`Missing ${missing.map((k) => `{${k}}`).join(', ')}`);
  return String(prompt).replace(PARAM, (_, k) => (has(k) ? String(values[k]) : ''));
}

// Fill positional CLI words into the parameters in the order they appear.
export function positional(prompt, words = []) {
  const out = {};
  params(prompt).forEach((k, i) => words[i] !== undefined && (out[k] = words[i]));
  return out;
}


export function normalizeRecipe(body, prev = null) {
  const name = String(body.name ?? prev?.name ?? '').trim().slice(0, 60);
  const prompt = String(body.prompt ?? prev?.prompt ?? '').trim();
  if (!name) throw bad('A recipe needs a name.');
  if (!prompt) throw bad('A recipe needs a prompt.');
  const cwd = body.cwd !== undefined ? String(body.cwd || '') : prev?.cwd || '';
  if (cwd && !path.isAbsolute(cwd)) throw bad('cwd must be an absolute project path (or empty for any project).');
  const mode = body.mode ?? prev?.mode ?? '';
  if (mode && !MODES.has(mode)) throw bad('mode must be plan, edits or auto.');
  const pick = (k) => String(body[k] ?? prev?.[k] ?? '');
  return {
    id: prev?.id || newId(),
    name,
    prompt,
    cwd, // '' = whichever project it's run in
    agent: pick('agent'),
    model: pick('model'),
    effort: /^[\w-]{0,20}$/.test(pick('effort')) ? pick('effort') : '',
    mode,
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
    runs: prev?.runs || 0,
    lastRunAt: prev?.lastRunAt || null,
  };
}

// By id, else by name (case- and punctuation-insensitive), so `wisp run "Release"` and
// `wisp run release` both work.
export function findRecipe(recipes, key) {
  const k = String(key || '');
  const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return recipes.find((r) => r.id === k) || recipes.find((r) => loose(r.name) === loose(k)) || null;
}

export const recipeView = (r) => ({ ...r, params: params(r.prompt) });
