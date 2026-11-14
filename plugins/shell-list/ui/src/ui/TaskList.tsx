// The task list (v1's feed in the sidebar): the project chips, what plugins put on top, then every
// section in one VirtualList (5k tasks: only the rows on screen exist), with one shared row menu.
// Server data comes from the entity store through the model's memoised sections; what's open comes
// from navigation; the rest (whose menu is open, the dialogs) is local to this list.

import { createEffect, createMemo, Match, on, onCleanup, Show, Switch, type JSX } from 'solid-js';
import { ContextMenu, EmptyState, ProjectHead, Stack, VirtualList, feedDoneColumn, useSignal, type MenuEntry } from '@wisp/ui';
import type { ProjectColor } from '@wisp/tokens';
import type { EntityKey } from '@wisp/client';
import type { ExtensionProps, ResolvedExtension } from '@wisp/shell/contract';
import { copyId, setUnread, toggleArchived, toggleDone, toggleForLater, togglePin } from '../actions.ts';
import { flatten, itemKey, sectionGroups, type Item } from '../model/flat.ts';
import { pickOf } from '../model/sections.ts';
import { rowMenu } from '../model/menu.ts';
import { anyShowsDone } from '../model/row.ts';
import { menuEntryOf } from '@wisp/shell';
import { flatSession } from '../model/wire.ts';
import { useShell } from '../shell.ts';
import { KIND, type Session, type SessionRow } from '../types.ts';
import { buildEnv } from './build-env.ts';
import { DeleteDialog, RenameDialog } from './Dialogs.tsx';
import { Env, useEnv, type ListEnv } from './env.ts';
import { GroupRow, PlanRow, SectionHead } from './OtherRows.tsx';
import { revealIn } from './reveal.ts';
import { Slot, hasExtensions } from './Slot.tsx';
import { TaskRow } from './TaskRow.tsx';

/** px of a row not measured yet: three lines (title, what it's doing, where it runs) */
export const ROW_ESTIMATE = 58;

export function TaskList(props: ExtensionProps): JSX.Element {
  const env = buildEnv(useShell(), props.client);
  // the list's card, lent while the list shows: the phone's Crew section nests a member's jobs with it (v1 placeCards)
  onCleanup(
    env.shell.taskCards?.provide((key) => (
      <Env.Provider value={env}>
        <TaskRow k={key as EntityKey} />
      </Env.Provider>
    )) ?? (() => {}),
  );
  return (
    <Env.Provider value={env}>
      <ListBody />
    </Env.Provider>
  );
}

function ListBody(): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const sections = useSignal(env.model.sections);
  const view = useSignal(env.model.view.value);
  // a crew member's page open: the list holds only their jobs (v1 crew.js inPick), with v1's empty line
  const nav = useSignal(env.shell.nav);
  const members = useSignal(env.client.entities.list<{ id: string; name: string }>('crew_member'));
  const picked = createMemo(() => {
    const m = nav().main;
    return m.kind === 'crew' ? String(m.id) : undefined;
  });
  createEffect(() => env.model.setCrew(picked()));
  const emptyTitle = (): string => {
    const who = picked();
    if (who !== undefined) return t('shell-list.empty.crew', { name: members().find((m) => m.id === who)?.name ?? '' });
    return t(view().filter !== 'all' ? 'shell-list.empty.project' : 'shell-list.empty.all');
  };
  const toggled = createMemo(() => new Set(view().toggled));
  // the crew's section (on the phone, where there's no rail): a plugin fills shell.list:crew
  const crew = hasExtensions('shell.list:crew');
  // a member's jobs for other tasks sit under the member, not in the sections (v1 crew.js): in the phone's Crew section,
  // or side by side in the face's card beside the rail
  const railCard = hasExtensions('shell.rail:card');
  createEffect(() => env.model.setNest(env.split() ? railCard() : crew()));
  // several projects picked: each section's rows grouped by project (none while a crew member is picked)
  const projects = useSignal(env.model.projects);
  const byProject = createMemo(() => {
    const known = new Set(projects().map((p) => p.id));
    return picked() === undefined ? pickOf(view().filter).filter((id) => known.has(id)) : [];
  });
  const items = createMemo(() => flatten(sections(), { toggled: toggled(), open: env.open(), split: env.split(), crew: !env.split() && crew(), byProject: byProject() }));
  // on touch, Mark done keeps a column of its own only while some row on the list shows it (v1 feed.js has-quick)
  const doneColumn = createMemo(() => !env.swipes && anyShowsDone(shownRows(items()), (k) => env.rowCtx(k as EntityKey)));
  const plugins = useSignal(env.shell.extensions('shell.row:menu'));
  const menu = createMemo<MenuEntry[]>(() => menuFor(env, plugins()));
  const box: { el?: HTMLElement } = {};
  // the keyboard's task (j / k, the palette) scrolls its row into view
  createEffect(on(env.selected, (k) => k !== undefined && box.el && revealIn(box.el, items(), k, ROW_ESTIMATE), { defer: true }));
  return (
    <Stack gap="2" grow part="list.sidebar">
      <Slot input="shell.list:top" layout="stack" />
      <Show when={items().length > 0} fallback={<EmptyState icon="spark" compact title={emptyTitle()} part="list.empty" />}>
        <ContextMenu items={menu()} onSelect={(v) => pick(env, v, plugins())} part="list.menu">
          <VirtualList
            ref={(el) => (box.el = el)}
            items={items()}
            key={itemKey}
            estimate={ROW_ESTIMATE}
            overscan={8}
            grow
            aria-label={t('shell-list.list.label')}
            part={'list.rows feed' as `${string}.${string}`}
            vars={feedDoneColumn(doneColumn())}
            gapBefore={(i) =>
              isTaskItem(items()[i]) && isTaskItem(items()[i - 1])
                ? true
                : (items()[i]?.t === 'slot' && i > 0 && isTaskItem(items()[i - 1])) || (i > 0 && items()[i - 1]?.t === 'slot')
                  ? 'section'
                  : false
            }
            // each section a box from its heading to its last row (v1 #secNeeds, …): parity measures it, spells style it
            groups={sectionGroups(items())}
          >
            {(item) => <ItemView item={item()} />}
          </VirtualList>
        </ContextMenu>
      </Show>
      <RenameDialog />
      <DeleteDialog />
    </Stack>
  );
}

/** The task rows the list shows (a task, a group's open runs): the ones that may carry Mark done. */
function* shownRows(items: readonly Item[]): Generator<{ readonly key: string; readonly s: SessionRow }> {
  const runs = new Map<string, SessionRow>();
  for (const it of items) {
    if (it.t !== 'entry') continue;
    if (it.entry.kind === 'task') yield it.entry;
    else if (it.entry.kind === 'group') for (const r of it.entry.runs) runs.set(r.key, r.s);
  }
  for (const it of items) {
    if (it.t !== 'run') continue;
    const s = runs.get(it.key);
    if (s) yield { key: it.key, s };
  }
}

/** A task's row (its FeedItem): two in a row are 2px apart (v1 .f-list gap), a heading and a row are not. */
const isTaskItem = (it: Item | undefined): boolean => it?.t === 'entry' && it.entry.kind === 'task';

function ItemView(props: { readonly item: Item }): JSX.Element {
  const env = useEnv();
  const sections = useSignal(env.model.sections);
  const head = (): Extract<Item, { t: 'head' }> | undefined => (props.item.t === 'head' ? props.item : undefined);
  const entry = (): Extract<Item, { t: 'entry' }>['entry'] | undefined => (props.item.t === 'entry' ? props.item.entry : undefined);
  const nested = (): Extract<Item, { t: 'run' | 'sub' }> | undefined => (props.item.t === 'run' || props.item.t === 'sub' ? props.item : undefined);
  return (
    <Switch>
      <Match when={head()}>{(h) => <SectionHead id={h().id} count={h().count} open={h().open} entries={sections()[h().id]} />}</Match>
      <Match
        when={(() => {
          const e = entry();
          return e?.kind === 'task' ? e : undefined;
        })()}
      >
        {(e) => <TaskRow k={e().key} />}
      </Match>
      <Match
        when={(() => {
          const e = entry();
          return e?.kind === 'group' ? e : undefined;
        })()}
      >
        {(e) => <GroupRow entry={e()} />}
      </Match>
      <Match
        when={(() => {
          const e = entry();
          return e?.kind === 'plan' ? e : undefined;
        })()}
      >
        {(e) => <PlanRow plan={e().plan} />}
      </Match>
      <Match when={nested()}>{(n) => <TaskRow k={n().key} nested={n().t} />}</Match>
      <Match when={props.item.t === 'slot'}>
        <Slot input="shell.list:crew" layout="stack" />
      </Match>
      <Match when={props.item.t === 'proj' ? props.item : undefined}>{(j) => <ProjectGroupHead id={j().id} />}</Match>
    </Switch>
  );
}

/** A project's line over its rows (several picked): its dot and name, from the list's projects. */
function ProjectGroupHead(props: { readonly id: string }): JSX.Element {
  const env = useEnv();
  const projects = useSignal(env.model.projects);
  const p = createMemo(() => projects().find((x) => x.id === props.id));
  return <ProjectHead name={p()?.name ?? env.shell.t('shell-list.projects.other')} color={`pc-${p()?.color || 'slate'}` as ProjectColor} {...(p()?.path ? { title: p()?.path as string } : {})} />;
}

const sessionOf = (env: ListEnv, key: EntityKey): Session | undefined => env.client.entities.peek<Session>(KIND.session, key) as Session | undefined;

/** The open row's menu: the list's actions, and what plugins attached to shell.row:menu. */
function menuFor(env: ListEnv, plugins: readonly ResolvedExtension[]): MenuEntry[] {
  const key = env.menuFor();
  const s = key === undefined ? undefined : sessionOf(env, key);
  if (!key || !s) return [];
  // as the list reads it: summary and body flat (branch, toShip, pr…), its key in `id`
  const session = (): { id: string; agent: string } => ({ ...flatSession(s), id: key });
  const shown = plugins.filter((x) => x.def.bar && (x.def.if?.({ client: env.client, config: x.config, session }) ?? true));
  return rowMenu({ s, t: env.shell.t, plugins: shown.map((x) => menuEntryOf(x, { client: env.client, config: x.config, session }, env.shell.t, env.keys)), keys: env.keys });
}

/** A choice in the row menu. */
function pick(env: ListEnv, value: string, plugins: readonly ResolvedExtension[]): void {
  const key = env.menuFor();
  const s = key === undefined ? undefined : sessionOf(env, key);
  if (!key || !s) return;
  const a = env.actions;
  switch (value) {
    case 'open':
      return env.openTask(key);
    case 'rename':
      return env.askRename(key);
    case 'copy-id':
      return void copyId(a, key, (text) => env.shell.platform.copy(text));
    case 'later':
      return toggleForLater(a, key);
    case 'pin':
      return togglePin(a, key);
    case 'read':
      return setUnread(a, key, !s.unread);
    case 'done':
      return toggleDone(a, key);
    case 'archive':
      return toggleArchived(a, key);
    case 'delete':
      return env.askDelete(key);
    default: {
      const x = plugins.find((p) => `x:${p.id}` === value);
      x?.def.bar?.select?.({ client: env.client, config: x.config, session: () => ({ ...flatSession(s), id: key }) });
    }
  }
}
