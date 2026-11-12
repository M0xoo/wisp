// Apps from My Stuff pinned on Home (v1 split.js paintPanes, panes.js paneNode/start/onMessage): "Panes N", then each
// app in a tile (side by side) or a row that opens it as a page (stacked). An app runs where Launch runs it (its own
// port), in a sandboxed frame inside a script-less wrapper whose CSP stops it navigating away; it reaches wisp only
// through messages, each checked against what you allowed (panes/host.ts). Stacked, a pane starts only once its row
// is opened, then stays (moving a frame would reload the app).
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { computed, type EntityKey, type PluginClient } from '@wisp/client';
import type { ExtensionProps } from '@wisp/shell/contract';
import { projectList, projectOf, useShell } from '@wisp/shell';
import { AppFrame, HomePanes as HomePanesView, PaneOff, PaneRow, PaneView, useSignal, type AppFrameController } from '@wisp/ui';
import { followJob, grantOf, launchApp, launchTask, markDone, planWindows, savedProfiles } from './commands.ts';
import { defaultsFrom, type LaunchDefaults } from './panes/grant.ts';
import { useEntries, type Entry } from './items.ts';
import { contextEvent, answer, failure, paneFrameCsp, readFrameMessage, tasksEvent } from './panes/bridge.ts';
import { paneNeed } from './panes/grant.ts';
import { paneHost } from './panes/host.ts';
import { lightAccounts, type BudgetAgent } from './panes/usage.ts';
import { taskOfRow, type SessionLike } from './panes/rows.ts';
import { PaneCards, pinsOf } from './pins.tsx';
import { stuffState } from './state.ts';
import type { CrewRow, PaneWhere, TaskRow } from './types.ts';

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

export default function HomePanes(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const nav = useSignal(shell.nav);
  const entries = useEntries(c);
  const pins = pinsOf(c);
  const items = createMemo(() => entries().map((e) => e.it));
  const pinned = createMemo((): Entry[] => {
    const at = pins.at('home', items());
    return at.map((it) => entries().find((e) => e.it.id === it.id)).filter((e): e is Entry => !!e);
  });
  // keyed by the app's id: a row update (launching sets `running`) never remounts a pane, so it never launches again
  const ids = createMemo(() => pinned().map((e) => e.it.id), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const entryOf = (id: string): Entry | undefined => pinned().find((e) => e.it.id === id);
  const stacked = (): boolean => nav().layout === 'stack';
  // stacked: the pane open as a page, and the ones opened before (their frames stay)
  const [page, setPage] = createSignal<string | undefined>();
  const [made, setMade] = createSignal<ReadonlySet<string>>(new Set());
  const open = (id: string): void => {
    setMade(new Set([...made(), id]));
    setPage(id);
  };
  createEffect(() => {
    const p = page();
    if (p && !pinned().some((e) => e.it.id === p)) setPage(undefined); // unpinned while open
  });
  const tasks = useTasks(c);
  return (
    <Show when={pinned().length > 0}>
      <HomePanesView
        heading={say('stuff.panes.heading')}
        count={pinned().length}
        stacked={stacked()}
        rows={<For each={pinned()}>{(e) => <PaneRow name={e.it.title} need={needWords(e, say)} onOpen={() => open(e.it.id)} />}</For>}
      >
        <For each={ids()}>
          {(id) => (
            <Show when={(!stacked() || made().has(id) || page() === id) && entryOf(id)}>
              {(e) => <Pane client={c} where="home" entry={e()} tasks={tasks} open={stacked() && page() === id} onBack={stacked() ? () => setPage(undefined) : undefined} />}
            </Show>
          )}
        </For>
      </HomePanesView>
      <PaneCards client={c} />
    </Show>
  );
}

const needWords = (e: Entry, say: (k: string) => string): string | undefined => {
  const k = paneNeed(e.it);
  return k ? say(k) : undefined;
};

/** The runtime's task rows, as a pane's calls read them. */
export function useTasks(c: PluginClient): () => readonly TaskRow[] {
  const rows = c.entities.list<SessionLike>('session');
  const projects = c.entities.list<unknown>('project');
  const list = computed(() => {
    const ps = projectList(projects(), undefined);
    return rows()
      .map((r) => taskOfRow(r, (cwd) => projectOf(cwd, ps)?.name))
      .filter((s): s is TaskRow => !!s);
  });
  return useSignal(list);
}

/** One pinned app: on Home, or beside a task (`task`: its id, which the pane hears as wisp.context). */
export function Pane(props: {
  readonly client: PluginClient;
  readonly where: PaneWhere;
  readonly task?: string;
  readonly entry: Entry;
  readonly tasks: () => readonly TaskRow[];
  readonly open: boolean;
  readonly onBack: (() => void) | undefined;
}): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const pins = pinsOf(c);
  const key = (): EntityKey => props.entry.key;
  const it = () => props.entry.it;
  const theme = useSignal(shell.theme.resolved);
  // Launch: where wisp serves it. Off this computer, a 127.0.0.1 address is no address of yours (v1 addressOf).
  const [launched, { refetch }] = createResource(() => c.run(launchApp, { key: key(), id: it().id }));
  // this page on the computer with wisp (127.0.0.1, localhost): only then is the app's own address yours
  const here = typeof document !== 'undefined' && LOOPBACK.test(new URL(document.URL).hostname);
  const url = (): string | undefined => launched()?.url;
  const origin = (): string | undefined => {
    const u = url();
    try {
      return u ? new URL(u).origin : undefined;
    } catch {
      return undefined;
    }
  };
  let frame: AppFrameController | undefined;
  const post = (m: unknown): void => frame?.post(m);
  const context = (): void => post(contextEvent({ where: props.where, task: props.where === 'task' ? (props.task ?? null) : null, theme: theme() === 'dark' ? 'dark' : 'light' }));
  createEffect(on([theme, () => props.task], context, { defer: true }));
  const taskRow = (): TaskRow | null => (props.task ? (props.tasks().find((s) => s.id === props.task) ?? null) : null);
  // wisp.on('tasks'): what changed, at most every 300 ms
  const [watching, setWatching] = createSignal(false);
  // the push's timer, in this pane's own scope: unpinning (or leaving Home) frees it
  const scope = c.scope.child('stuff.pane');
  onCleanup(() => scope.dispose());
  let soon: (() => void) | undefined;
  const host = paneHost({
    item: it,
    pinned: () => pins.pinned(it(), props.where, [it()]),
    grant: () => c.run(grantOf, { key: key(), id: it().id }),
    // v1 paneCard: with a dialog of yours open, the pane can ask again later (opening over it would replace it)
    card: (card) =>
      new Promise((done, refuse) => {
        if (document.querySelector('[data-kit="dialog"]')) return refuse(new Error(say('stuff.pane.dialogOpen')));
        const st = stuffState(c);
        st.setModal({ kind: 'card', head: card.head, rows: card.rows, prompt: card.prompt, done: (yes) => (st.setModal(undefined), done(yes)) });
      }),
    tasks: props.tasks,
    crew: () => (c.entities.list<CrewRow & { body?: CrewRow }>('crew_member')() ?? []).map((m) => ({ ...(m.body ?? {}), ...m }) as CrewRow),
    usage: () => usageNow(c, shell.harnesses()()),
    project: (name) => {
      const p = projectList(c.entities.list<unknown>('project')(), undefined).find((x) => x.name === name || x.id === name);
      return p ? { name: p.name, path: p.path } : undefined;
    },
    // your saved defaults (the `default` agent profile), as New task sends them; no mode saved: Full auto (v1 DEFAULT_MODE)
    defaults: () => savedDefaults(c, shell.harnesses()()),
    told: (text) => void shell.toast.show(text),
    harnessName: (a) => shell.harnesses()().find((h) => h.id === a)?.name ?? a ?? '',
    launch: (body) => c.run(launchTask, { peer: c.home, body }).then((r) => props.tasks().find((s) => s.id === r.id) ?? ({ id: r.id, title: r.title ?? String(body['prompt'] ?? ''), state: 'running' } as TaskRow)),
    followUp: (id, text) => c.run(followJob, { key: `${c.home}:${id}` as EntityKey, sessionId: id, text }).then(() => undefined),
    done: (id) => c.run(markDone, { key: `${c.home}:${id}` as EntityKey, id }).then(() => undefined),
    watch: () => setWatching(true),
    now: () => Date.now(),
    t: say,
  });
  createEffect(
    on(props.tasks, (list) => {
      if (!watching()) return;
      soon?.();
      soon = scope.timeout(300, () => post(tasksEvent(list.map((s) => ({ id: s.id, title: s.title, state: s.state, updatedAt: s.updatedAt })))));
    }),
  );
  const onMessage = (data: unknown, reply: (m: unknown) => void): void => {
    const m = readFrameMessage(data);
    if (!m) return;
    if (m.kind === 'hello') return context();
    host.call(m.method, m.args).then(
      (r) => reply(answer(m.id, r)),
      (e: unknown) => reply(failure(m.id, e instanceof Error ? e.message : String(e))),
    );
  };
  const need = (): string | undefined => {
    const k = paneNeed(it());
    return k ? say(k) : undefined;
  };
  return (
    <PaneView
      part={props.where === 'home' ? 'split.panes.pane' : 'panel.pane'}
      name={it().title}
      need={need()}
      open={props.open}
      allow={need() ? { label: say('stuff.pane.allow'), onClick: () => void pins.allow(key(), it(), taskRow()) } : undefined}
      reload={{ label: say('stuff.pane.reload'), onClick: () => (frame ? frame.reload() : void refetch()) }}
      unpin={{ label: say('stuff.pane.unpin'), onClick: () => void pins.unpin(it(), props.where, [it()]) }}
      back={props.onBack ? { label: say('stuff.pane.back'), onClick: props.onBack } : undefined}
    >
      <Show when={!launched.error} fallback={<PaneOff tone="warn" text={launched.error instanceof Error ? launched.error.message : say('stuff.pane.notStarted')} />}>
        <Show when={url()} fallback={<PaneOff text={say('stuff.pane.starting', { name: it().title })} />}>
          {(u) => (
            <Show when={here && origin()} fallback={<PaneOff text={say('stuff.pane.runsAt', { url: u() })} />}>
              {(o) => (
                <AppFrame
                  title={it().title}
                  src={u()}
                  origin={o()}
                  lock={paneFrameCsp([o()])}
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  allow="clipboard-write"
                  loadingLabel={say('stuff.pane.starting', { name: it().title })}
                  controller={(x) => (frame = x)}
                  onMessage={onMessage}
                />
              )}
            </Show>
          )}
        </Show>
      </Show>
    </PaneView>
  );
}

/** wisp.usage.accounts(): each harness's plan windows (budget.view), light. */
async function usageNow(c: PluginClient, harnesses: readonly { id: string; name: string }[]): Promise<unknown> {
  const agents: BudgetAgent[] = [];
  for (const h of harnesses) {
    const plans = await c.run(planWindows, { peer: c.home, agent: h.id }).catch(() => []);
    const list = Array.isArray(plans) ? (plans as { account: string; windows?: { id: string; label: string; used: number; resetsAt?: number | null; ms?: number | null }[] }[]) : [];
    agents.push({
      id: h.id,
      name: h.name,
      available: true,
      budget: list.map((p) => ({ account: p.account, windows: (p.windows ?? []).map((w) => ({ id: w.id, label: w.label, used: w.used, resetsAt: w.resetsAt ?? null, ...(w.ms ? { ms: w.ms } : {}) })) })),
    });
  }
  return lightAccounts(agents, Date.now());
}

/** Your saved launch defaults (v1 launchDefaults), read from the agent profiles and the worktree setting. */
async function savedDefaults(c: PluginClient, harnesses: readonly { id: string }[]): Promise<LaunchDefaults> {
  const list = await c.run(savedProfiles, { peer: c.home }).catch(() => []);
  const worktree = c.entities.peek<{ value?: unknown }>('setting', `${c.home}:defaults.worktree` as never)?.value;
  return defaultsFrom(list, worktree, harnesses[0]?.id);
}
