// Pick several projects (owner, 2026-11-13; docs/v2-queue.md GUI item 7). Clicking a project still means "only this
// one"; adding more is a separate, visible act (the + on a switcher row, ⌘-Enter). The pick lives where the one
// choice always lived, the device setting `shell.projectFilter`: 'all', one project's id, or several ids joined by
// commas in the order you added them (the first is where New task starts). One value, so it's saved and restored
// like the one choice was. A reader that wants one project takes `parsePick(value)[0]` (where New task starts).
// Pure: no store, no DOM.

import { projectOf, type ProjectView } from './rows-view.ts';

/** Every project: the empty pick. */
export const ALL = 'all';

/** The ids picked, in the order added; [] for All projects. Ids no longer among `known` (a project removed) drop out. */
export function parsePick(value: string | undefined, known?: readonly string[]): string[] {
  if (!value || value === ALL) return [];
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const id = raw.trim();
    if (!id || id === ALL || out.includes(id)) continue;
    if (known && !known.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** The setting's value for a pick. */
export const pickValue = (ids: readonly string[]): string => (ids.length === 0 ? ALL : ids.join(','));

/** Only this project (a row's name, Enter, ⌘1–⌘9); 'all' clears the pick. */
export const pickOnly = (id: string): string[] => (id === ALL || !id ? [] : [id]);

/** Add it to the pick, or take it out (the row's + / −, ⌘-Enter). From All, adding starts a pick of one. */
export function pickToggle(ids: readonly string[], id: string): string[] {
  if (id === ALL || !id) return [];
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** The pick without this one (a chip's ×). */
export const pickRemove = (ids: readonly string[], id: string): string[] => ids.filter((x) => x !== id);

/** Does the pick hold this project? All holds every one. */
export const pickHas = (ids: readonly string[], id: string | undefined): boolean => ids.length === 0 || (id !== undefined && ids.includes(id));

/** A long name cut in its middle, so both ends still say which one it is ("wisp-…-api"). */
export function middle(name: string, max = 14): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
}

/** The top bar's words for a pick: one name, "api + web" (and a third, each cut in the middle), or "4 projects". */
export function pickLabel(picked: readonly ProjectView[], t: (key: string, vars?: Readonly<Record<string, string | number>>) => string): string {
  if (picked.length === 0) return t('shell.side.all');
  if (picked.length === 1) return picked[0]?.name ?? '';
  if (picked.length <= 3) return picked.map((p) => middle(p.name)).join(' + ');
  return t('shell.pick.n', { n: picked.length });
}

/** The pick's projects, in the order added. */
export const pickedProjects = (ids: readonly string[], projects: readonly ProjectView[]): ProjectView[] =>
  ids.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectView => p !== undefined);

/** New task in a pick: it starts in the first project, the others are the folders it also works in. */
export function launchOf(ids: readonly string[], projects: readonly ProjectView[]): { start: string | undefined; also: string[] } {
  const known = pickedProjects(ids, projects);
  return { start: known[0]?.id, also: known.slice(1).map((p) => p.id) };
}

/** New task's + / × on a chip: add the project to the folders it also works in, or leave it out. */
export const alsoToggle = (also: readonly string[], id: string): string[] => (also.includes(id) ? also.filter((x) => x !== id) : [...also, id]);

/** The extra folders for runtime.create's `dirs`: every added project but the one it starts in, once each. */
export function dirsOf(start: ProjectView | undefined, also: readonly string[], projects: readonly ProjectView[]): string[] {
  const out: string[] = [];
  for (const id of also) {
    const p = projects.find((x) => x.id === id);
    if (!p || p.id === start?.id || !p.path || p.path === start?.path || out.includes(p.path)) continue;
    out.push(p.path);
  }
  return out;
}

/**
 * New task: make `id` the start (a chip's click). The old start stays a folder the task also works in (round 133
 * dropped it): where `id` was when it was an added one (the two swap), else first, while the task works in several.
 * Picking the one it starts in, or switching a one-folder task, changes nothing else.
 */
export function startAt(start: string | undefined, also: readonly string[], id: string): string[] {
  const rest = also.filter((x) => x !== id);
  if (!start || start === id) return rest;
  const i = also.indexOf(id);
  if (i >= 0) return also.map((x) => (x === id ? start : x)).filter((x, j, a) => a.indexOf(x) === j);
  return also.length > 0 ? [start, ...rest.filter((x) => x !== start)] : [];
}

/** One folder a task works in, as its page's place chip: the project it is in (`id`), or the folder's own name. */
export interface TaskPlace {
  /** the folder it started in, not one it also works in */
  readonly own?: true;
  readonly id?: string;
  readonly name: string;
  readonly color: string;
  readonly path: string;
}

/**
 * A task's places (v1 places.js: "a task's projects: its own, then those of the other folders it works in"): its own
 * first (the row's project, its name and colour as the row says them), then each extra folder (`body.dirs`) as the
 * project that holds it, once each; a folder in no project shows its last path part.
 */
export function taskPlaces(
  own: { readonly name: string; readonly color: string; readonly cwd: string; readonly projectId?: string },
  dirs: unknown,
  projects: readonly ProjectView[],
): TaskPlace[] {
  const mine = (own.projectId ? projects.find((p) => p.id === own.projectId) : undefined) ?? projectOf(own.cwd, projects);
  const out: TaskPlace[] = [];
  if (own.name || mine) out.push({ own: true, ...(mine && { id: mine.id }), name: own.name || (mine?.name ?? ''), color: own.color || mine?.color || 'slate', path: mine?.path ?? own.cwd });
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (typeof d !== 'string' || !d) continue;
    const p = projectOf(d, projects);
    if (p ? out.some((x) => x.id === p.id) : out.some((x) => x.path === d)) continue;
    out.push(p ? { id: p.id, name: p.name, color: p.color || 'slate', path: p.path } : { name: d.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? d, color: 'slate', path: d });
  }
  return out;
}
