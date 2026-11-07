// What the spells that are on do to the rest of wisp (v1 Spells.settings/recipes/promptFor/
// blocksFor/hooks): settings they set, recipes they bring, prompt rules and agent blocks for a task.

import type { Scope, Spell, Hook } from './types.ts';

export interface Project {
  id?: string;
  name?: string;
}

export interface Where {
  project?: Project | null | undefined;
  agent?: string | undefined;
  mode?: string | undefined;
  cwd?: string | undefined;
}

export function scopeMatches(scope: Scope | undefined, w: Where = {}): boolean {
  if (!scope) return true;
  if (scope.agent && !scope.agent.includes(w.agent ?? '') && !scope.agent.includes('*')) return false;
  if (scope.mode && !scope.mode.includes(w.mode ?? '')) return false;
  if (scope.project && !scope.project.some((x) => x === w.project?.name || x === w.project?.id || (x.startsWith('/') && String(w.cwd || '').startsWith(x)))) return false;
  return true;
}

export interface TaskLike {
  agent: string;
  mode: string;
  cwd: string;
}

const harnessOk = (s: Spell, agent: string): boolean => !s.harnesses || s.harnesses.includes('*') || s.harnesses.includes(agent);
const applies = (s: Spell, t: TaskLike, project?: Project | null): boolean => harnessOk(s, t.agent) && scopeMatches(s.when, { project, agent: t.agent, mode: t.mode, cwd: t.cwd });

/** Settings spells set, and which spell set each (the last one turned on wins). */
export function settingsOf(on: readonly Spell[]): { values: Record<string, unknown>; lockedBy: Record<string, { id: string; name: string }> } {
  const values: Record<string, unknown> = {};
  const lockedBy: Record<string, { id: string; name: string }> = {};
  for (const s of on)
    for (const [k, v] of Object.entries(s.settings ?? {})) {
      values[k] = v;
      lockedBy[k] = { id: s.id, name: s.name };
    }
  return { values, lockedBy };
}

export function recipesOf(on: readonly Spell[]): Record<string, unknown>[] {
  return on.flatMap((s) => (s.recipes ?? []).map((r) => ({ ...r, runs: 0, lastRunAt: null, spell: { id: s.id, name: s.name } })));
}

/** Prompt rules for this task, as one section of its system prompt ('' when none). */
export function promptFor(on: readonly Spell[], t: TaskLike, project?: Project | null): string {
  const w = { project, agent: t.agent, mode: t.mode, cwd: t.cwd };
  const rules = on.filter((s) => applies(s, t, project)).flatMap((s) => (s.prompt ?? []).filter((r) => scopeMatches(r.when, w)).map((r) => `- ${r.text} _(spell: ${s.name})_`));
  if (!rules.length) return '';
  return `\n\n## Spells the user cast\n\nThe user turned these on in wisp. Follow them unless the current request says otherwise.\n\n${rules.join('\n')}\n`;
}

export interface ExtraBlock {
  type: string;
  doc: string;
  summary: string;
  spell: string;
}

/** Extra block types agents may use in this task's report. */
export function blocksFor(on: readonly Spell[], t: TaskLike, project?: Project | null): ExtraBlock[] {
  return on.filter((s) => applies(s, t, project)).flatMap((s) => (s.blocks ?? []).map((b) => ({ type: b.type, doc: b.doc, summary: b.summary, spell: s.name })));
}

/**
 * The protocol's lines for them, as v1's systemPrompt({ extraBlocks }) wrote them, so an agent reads
 * a spell's block exactly as before.
 */
export function blocksPrompt(extra: readonly ExtraBlock[]): string {
  if (!extra.length) return '';
  const lines = extra.map((b) => {
    const m = /^(\{.*?\})\s*(.*)$/s.exec(b.doc);
    const [example, when] = m ? [m[1], m[2]] : [b.doc, ''];
    return `- ${example}\n  ${when || 'When it fits.'}\n  (From the user's spell ${b.spell}.)`;
  });
  return `\n\n## Blocks from the user's spells\n\nBesides wisp's own blocks, your report may use these:\n\n${lines.join('\n')}\n`;
}

export function hooksOf(on: readonly Spell[], event: string): { spell: Spell; hook: Hook }[] {
  return on.flatMap((s) => (s.hooks ?? []).filter((h) => h.on === event).map((hook) => ({ spell: s, hook })));
}
