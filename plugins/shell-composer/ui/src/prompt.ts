// What New task's box and a task's reply box offer after @ and / (v1 composer.js mention and slash menus): the
// tasks, crew members and My Stuff items whose name has what's typed, newest first, and the commands that start
// with it (the reply box's own list, or New task's). The shell draws the menu and sends the picked mention as
// `@[Title](scheme:id)` (mentions.ts's stored form).
import { defineCommand, type EntityKey, type PluginClient } from '@wisp/client';
import type { PromptItem, PromptSourceDef } from '@wisp/shell';
import { cleanTitle } from './text/mentions.ts';
import { HOME_SLASH, SLASH, type SlashCommand } from './text/slash.ts';

const MAX = 5;
const has = (hay: string, q: string): boolean => hay.toLowerCase().includes(q.toLowerCase());

interface TaskRow {
  readonly id: string;
  readonly title?: string;
  readonly archived?: boolean;
  readonly updated_at?: number;
}
interface CrewRow {
  readonly id: string;
  readonly name?: string;
  readonly role?: string;
}
interface StuffRow {
  readonly id: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: string;
}

/** The tasks @ can name: not archived, by the words typed, the latest first; the open task itself never. */
export function taskItems(rows: readonly TaskRow[], query: string, self?: string): PromptItem[] {
  const bare = (id: string): string => id.slice(id.indexOf(':') + 1);
  return rows
    .filter((r) => !r.archived && (!self || bare(r.id) !== bare(self)) && has(cleanTitle(r.title), query))
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, MAX)
    .map((r) => {
      const title = cleanTitle(r.title);
      return { value: `task:${r.id}`, label: title, icon: 'agent', insert: `@${title} `, mention: { scheme: 'wisp', id: bare(r.id), title } };
    });
}

export function crewItems(rows: readonly CrewRow[], query: string): PromptItem[] {
  return rows
    .filter((r) => r.name && has(r.name, query))
    .slice(0, MAX)
    .map((r) => ({ value: `crew:${r.id}`, label: r.name ?? '', ...(r.role && { detail: r.role }), icon: 'crew', insert: `@${r.name} `, mention: { scheme: 'crew', id: r.id, title: r.name ?? '' } }));
}

export function stuffItems(rows: readonly StuffRow[], query: string): PromptItem[] {
  return rows
    .filter((r) => has(r.title || r.name || '', query))
    .slice(0, MAX)
    .map((r) => {
      const title = r.title || r.name || '';
      return { value: `stuff:${r.id}`, label: title, ...(r.kind && { detail: r.kind }), icon: 'stuff', insert: `@${title} `, mention: { scheme: 'stuff', id: r.id, title } };
    });
}

/** The commands a half-typed `/go` could be, each with what goes after it and its hint. */
export function slashItems(list: readonly SlashCommand[], query: string, t: (k: string) => string): PromptItem[] {
  return (
    list
      // spells are gone (ADR-0031): /spell stays readable in old prompts, never offered
      .filter((c) => c.name !== 'spell' && c.name.startsWith(query.toLowerCase()))
      .map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, ...(t(c.args) && { detail: t(c.args) }), hint: t(c.hint), insert: c.bare ? `/${c.name}` : `/${c.name} ` }))
  );
}

const rows = <T>(c: PluginClient, kind: string): readonly T[] => c.entities.list<T>(kind)() as readonly T[];

/** The files a task's @ offers (v1 F-comp-15): the best matches of the path typed, the name first. */
export function fileItems(files: readonly string[], query: string, open: (path: string) => void): PromptItem[] {
  const q = query.toLowerCase();
  const scored = files
    .map((f) => {
      const name = f.split('/').pop() ?? f;
      const at = name.toLowerCase().indexOf(q);
      return { f, name, score: !q ? 2 : at === 0 ? 0 : at > 0 ? 1 : f.toLowerCase().includes(q) ? 2 : -1 };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.f.length - b.f.length);
  return scored.slice(0, MAX).map(({ f, name }) => {
    const dir = f.slice(0, Math.max(0, f.length - name.length - 1));
    return { value: `file:${f}`, label: name, ...(dir && { detail: dir }), icon: 'file', insert: `@${f} `, open: () => open(f) };
  });
}

const listFiles = defineCommand<{ key: EntityKey; id: string }, { files: string[] }>({
  id: 'worktrees.files',
  owner: (a) => a.key,
  wire: (a) => ({ id: a.id }),
  optimistic: 'none',
  pending: 'the @ menu’s files',
});
/** each task's files, asked once per task while the app runs (the menu shows them from the next key on) */
const filesOf = new Map<string, readonly string[]>();
function taskFiles(c: PluginClient, task: string | undefined): readonly string[] {
  if (!task) return [];
  const had = filesOf.get(task);
  if (had) return had;
  filesOf.set(task, []);
  const id = task.slice(task.indexOf(':') + 1);
  void c.run(listFiles, { key: task as EntityKey, id }).then(
    (r) => filesOf.set(task, r.files),
    () => filesOf.delete(task),
  );
  return [];
}

export const PROMPT_SOURCES: PromptSourceDef[] = [
  { id: 'shell-composer.tasks', trigger: '@', order: 10, items: (q, ctx) => taskItems(rows<TaskRow>(ctx.client, 'session'), q, ctx.task) },
  {
    id: 'shell-composer.crew',
    trigger: '@',
    order: 20,
    items: (q, ctx) =>
      crewItems(
        rows<CrewRow & { body?: Partial<CrewRow> }>(ctx.client, 'crew_member').map((r) => ({ ...r.body, ...r })),
        q,
      ),
  },
  {
    id: 'shell-composer.files',
    trigger: '@',
    where: ['reply'],
    order: 25,
    items: (q, ctx) => (q ? fileItems(taskFiles(ctx.client, ctx.task), q, (file) => ctx.client.navigate({ t: 'openSide', side: { kind: 'changes', id: ctx.task as never, file } })) : []),
  },
  { id: 'shell-composer.stuff', trigger: '@', order: 30, items: (q, ctx) => stuffItems(rows<StuffRow>(ctx.client, 'stuff.item'), q) },
  { id: 'shell-composer.slash', trigger: '/', where: ['reply'], items: (q, ctx) => slashItems(SLASH, q, (k) => ctx.client.t(k)) },
  { id: 'shell-composer.slash.home', trigger: '/', where: ['home'], items: (q, ctx) => slashItems(HOME_SLASH, q, (k) => ctx.client.t(k)) },
];
