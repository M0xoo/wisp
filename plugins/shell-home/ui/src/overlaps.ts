// Overlaps (v1 web/js/features/overlaps.js): other open tasks in the same repo changing the same
// files. A pill on the row's head, a one-line strip above the reply box naming the first (a clash
// leads) with "+n more", a dialog with them all, and lines for the Ship it and Merge dialogs, so two
// tasks that would clash aren't both approved blind. The words, pure.

import type { Overlap, TaskRow } from './types.ts';
import type { T } from './notify.ts';

export const SHOWN = 2;

export const clashes = (o: Overlap): boolean => !!o.conflicts?.length;

/** Clashes first: they're the ones to sort out before shipping. */
export const ranked = (r: TaskRow | undefined): Overlap[] => [...(r?.overlaps ?? [])].sort((a, b) => Number(clashes(b)) - Number(clashes(a)));

const list = (files: readonly string[], more: number, t: T): string => (more ? t('shell-home.overlap.andMore', { files: files.join(', '), n: more }) : files.join(', '));

/** One overlap in words: what merging both would do to these files. */
export function overlapLine(o: Overlap, t: T): string {
  if (clashes(o)) return t('shell-home.overlap.conflict', { files: list(o.conflicts ?? [], 0, t) });
  return o.conflicts ? t('shell-home.overlap.clean', { files: list(o.files, o.more ?? 0, t) }) : t('shell-home.overlap.also', { files: list(o.files, o.more ?? 0, t) });
}

export function overlapHead(o: Overlap, title: string, t: T): string {
  return clashes(o) ? t('shell-home.overlap.clashesWith', { title }) : t('shell-home.overlap.with', { title });
}

/** The pill: shown when there's any (and the task isn't still starting). */
export function pillOf(r: TaskRow | undefined, titleOf: (o: Overlap) => string, t: T): { label: string; clash: boolean; count: number; tip: string } | null {
  const all = r?.overlaps;
  if (!all?.length) return null;
  const clash = all.some(clashes);
  const tip = all.map((o) => `“${titleOf(o)}”: ${overlapLine(o, t)}`).join('\n');
  return { label: t(clash ? 'shell-home.overlap.clash' : 'shell-home.overlap.pill'), clash, count: all.length, tip };
}

/** For the Ship it and Merge dialogs: the first two, then how many more, or ''. */
export function overlapWarning(r: TaskRow | undefined, titleOf: (o: Overlap) => string, t: T): string {
  const all = ranked(r);
  const lines = all.slice(0, SHOWN).map((o) => `⚠ ${overlapHead(o, titleOf(o), t)}: ${overlapLine(o, t)}.`);
  const rest = all.length - SHOWN;
  return [...lines, ...(rest > 0 ? [t('shell-home.overlap.more', { n: rest })] : [])].join('\n');
}
