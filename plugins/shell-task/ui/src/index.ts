// @wisp-plugin/shell-task-ui: the open task (v1 split view's task page and side panel). The task
// view and the side panel load on first show (lazy), so the shell pays nothing until a task opens.
import { lazy } from 'solid-js';

const TaskSide = lazy(() => import('./TaskSide.tsx'));
import { defineExtension, definePluginUi, defineView } from './define.ts';
import { TAB_VIEW, TERM_VIEW } from './open-task.ts';
import { commentStore, waiting, withComments } from './comments.ts';
import { CATALOGUE } from './i18n/index.ts';
import { defineCommand } from '@wisp/client';
import { appRunning, runRequest } from './side/run-request.ts';

/** Stop app (v1 stopRun): wisp.terminal closes the task's run */
const stopRun = defineCommand<{ key: string; id: string }, { ok: boolean }>({
  id: 'terminal.close',
  owner: (a) => a.key as never,
  wire: (a) => ({ kind: 'run', id: a.id }),
  optimistic: 'none',
  pending: 'Stop app',
});

export { CATALOGUE };
export type * from './types.ts';

export default definePluginUi({
  id: 'wisp.shell-task',
  catalogue: { ...CATALOGUE },
  // The frame's task view is the chassis (its head renames in place, its transcript folds); this plugin fills
  // its slots: the side panel (Changes, PR, Shell), the cards under each turn, and what waits over the reply box.
  // the panel's head (its tabs) shows on every side area, so switching panes keeps it
  extensions: [
    // Run app / Stop app in a task's row menu (v1 panel.js runItem, runApp): a task with a worktree. While its app runs
    // (the row's mark from wisp.terminal) it stops it; else the task's Preview opens and starts it with its command
    defineExtension({
      id: 'shell-task.rowRun',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 80,
      if: (p) => {
        const s = p.session?.() as { branch?: string; pending?: boolean } | undefined;
        return !!s?.branch && !s.pending;
      },
      bar: {
        icon: 'play',
        label: 'shell-task.side.runApp',
        priority: 80,
        text: (p) => CATALOGUE[appRunning(p.session?.() as never) ? 'shell-task.side.stopApp' : 'shell-task.side.runApp'] ?? '',
        select: (p) => {
          const s = p.session?.() as { id?: string; ext?: Readonly<Record<string, unknown>> } | undefined;
          const key = String(s?.id ?? '');
          if (!key) return;
          if (appRunning(s)) return void p.client.run(stopRun, { key: key as never, id: key.slice(key.indexOf(':') + 1) }).catch(() => undefined);
          runRequest(key.slice(key.indexOf(':') + 1));
          p.client.navigate({ t: 'openTask', id: key as never });
          p.client.navigate({ t: 'openSide', side: { kind: 'preview', id: key as never } });
        },
      },
    }),
    ...(['changes', 'pr', 'shell', 'preview'] as const).map((p) => defineExtension({ id: `shell-task.side.${p}`, attachTo: { id: `shell.side:${p}` }, component: TaskSide })),
    // under each turn: why it stopped, what holds it, what moved in the CLI, its receipt
    defineExtension({ id: 'shell-task.turn', attachTo: { id: 'shell.turn:foot' }, component: lazy(() => import('./cards/TurnFoot.tsx')) }),
    // over the reply box: the agent's question (or a tool's approval) and the queued follow-ups
    defineExtension({ id: 'shell-task.foot', attachTo: { id: 'shell.task:foot' }, component: lazy(() => import('./foot/TaskFoot.tsx')) }),
    // over the reply box: the comments on lines waiting for the next follow-up (v1 comments.js tray)
    defineExtension({ id: 'shell-task.comments', attachTo: { id: 'shell.task:foot' }, component: lazy(() => import('./foot/CommentTray.tsx')) }),
    // a terminal task opens on its terminal
    defineExtension({ id: 'shell-task.term-open', attachTo: { id: 'shell.task:foot' }, component: lazy(() => import('./foot/TermOpen.tsx')) }),
  ],
  // a terminal task's CLI beside it (`shell-task.term`, the Terminal tab)
  // the comments go at the top of the next follow-up (v1 comment-text.js withComments)
  prompt: [
    {
      id: 'shell-task.comments',
      trigger: '/',
      where: ['reply'],
      order: 99,
      items: () => [],
      pending: (text, ctx) => {
        const store = commentStore(ctx.client);
        const list = waiting(store.value(), ctx.task);
        if (list.length === 0) return undefined;
        const was = store.value();
        return {
          text: withComments(list, text),
          taken: () =>
            store.set((cur) => {
              const next = { ...(cur as Record<string, unknown>) };
              delete next[ctx.task];
              return next as never;
            }),
          back: () => store.set(was as never),
        };
      },
    },
  ],
  views: [
    defineView({ kind: TERM_VIEW, slot: 'side', parse: () => null, title: () => CATALOGUE['shell-task.side.term'] ?? '', component: TaskSide as never }),
    defineView({ kind: TAB_VIEW, slot: 'side', parse: () => null, title: () => CATALOGUE['shell-task.side.label'] ?? '', component: TaskSide as never }),
  ],
});
