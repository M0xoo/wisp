// ⌘K's task pieces that need no component: a task's topics and past work (the palette's deep search). Plain so
// their tests needn't compile builtins.tsx and the views it registers.
import type { PaletteItem, ShellContext } from '../contract.ts';
import type { SessionRow } from '../rows.ts';
import { searchTasks } from '../frame/commands.ts';
import { shortAgo } from '../frame/rows-view.ts';

/** A task's topics (runtime's `tags`, set by wisp_tag), lower case: on the row's body, or the summary. */
export const tagsOf = (s: SessionRow): string[] => {
  const raw = (s.body as { tags?: unknown } | undefined)?.tags ?? (s.summary as { tags?: unknown }).tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string' && t !== '').map((t) => t.toLowerCase()) : [];
};

/**
 * ⌘K past work (v1 F-task-20): three letters or more find words inside prompts and answers (`runtime.search`), each hit
 * a task with the words it matched; archived ones too. What the palette already lists by title stays where it is.
 */
export async function pastWork(ctx: ShellContext, q: string, signal: AbortSignal): Promise<PaletteItem[]> {
  const peer = ctx.client.plugin('shell').home;
  const hits = await ctx.client.commands.run(searchTasks, { peer, q, limit: 20 });
  if (signal.aborted) return [];
  const now = ctx.client.scope.timers.now();
  return hits.map((h) => {
    const id = h.id.includes(':') ? h.id : `${peer}:${h.id}`;
    return {
      id: `task:${id}`,
      group: 'shell.palette.group.tasks',
      label: h.title,
      sub: [h.snippet.replace(/\s+/g, ' ').trim(), shortAgo(h.updatedAt, now)].filter(Boolean).join(' · '),
      keywords: q,
      at: h.updatedAt,
      run: () => ctx.navigate({ t: 'openTask', id: id as never }),
    };
  });
}
