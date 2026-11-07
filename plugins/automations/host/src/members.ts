// Triggers that send a crew member work (v1 Triggers.syncMember, crew.js's `on` and its remove,
// crew-share's forget). The crew editor's "Also starts when" (MEMBER_KINDS) keeps one trigger of each
// kind for the member: one already there (your own prompt, a branch) stays, switched on; a kind left
// out goes. A CI watcher that watched the member's old folder follows it (prevCwd). All or nothing.

import { MEMBER_KINDS } from '@wisp-plugin/automations-api';
import type { Engine } from './engine.ts';
import { normalizeTrigger, type NormalizeCtx } from './normalize.ts';
import type { Member, Trigger } from './types.ts';
import { isDir } from './fsx.ts';

const ctxFor = (e: Engine, m: Member): NormalizeCtx => ({ recipes: e.d.recipes(), member: m, exists: isDir, now: e.d.now() });

export async function syncMember(e: Engine, m: Member, kinds: unknown, prevCwd: string = m.cwd): Promise<void> {
  const c = ctxFor(e, m);
  const want = new Set((Array.isArray(kinds) ? kinds : []).map(String).filter((k) => MEMBER_KINDS.has(k)));
  const ours = (t: Trigger): boolean => t.crew === m.id && MEMBER_KINDS.has(t.kind);
  const all = e.d.repo.list();
  const kept: Trigger[] = [];
  const made: Trigger[] = [];
  // everything is checked before anything is written: a refusal leaves the triggers as they were
  for (const k of want) {
    const have = all.filter((t) => ours(t) && t.kind === k);
    for (const t of have) {
      const follow = k === 'ci' && t.cwd === prevCwd && m.cwd !== prevCwd && !m.machine;
      kept.push(await normalizeTrigger({ enabled: true, ...(follow && { cwd: m.cwd }) }, t, c));
    }
    if (!have.length) made.push(await normalizeTrigger({ kind: k, crew: m.id }, null, c));
  }
  const gone = all.filter((t) => ours(t) && !want.has(t.kind)).map((t) => t.id);
  if (gone.length) e.d.repo.removeTrigger(...gone);
  if (kept.length || made.length) e.d.repo.saveTrigger(...kept, ...made);
}

/** The member's `on`: the kinds of its triggers that are on. */
export function memberKinds(e: Engine, crewId: string): string[] {
  return [...new Set(e.d.repo.list().filter((t) => t.crew === crewId && t.enabled).map((t) => t.kind))];
}

/** A member left the crew: the triggers that sent it work go off, and say why. */
export function memberLeft(e: Engine, crewId: string, name: string): number {
  const mine = e.d.repo.list().filter((t) => t.crew === crewId);
  for (const t of mine) Object.assign(t, { crew: '', enabled: false, lastError: `${name} left your crew.` });
  if (mine.length) e.d.repo.saveTrigger(...mine);
  return mine.length;
}

/** Gone for good (an import undone): the member's triggers, not left behind switched off. */
export function forgetMember(e: Engine, crewId: string): number {
  const ids = e.d.repo.list().filter((t) => t.crew === crewId).map((t) => t.id);
  if (ids.length) e.d.repo.removeTrigger(...ids);
  return ids.length;
}
