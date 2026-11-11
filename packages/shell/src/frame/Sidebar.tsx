// The sidebar as v1 shows it (web/js/features/split.js, feed.js): its head (the brand, Search, the
// avatar, the sidebar button and the project chips), New task and My Stuff, then the list in its
// sections (Needs you, Working, Done), each task a row (the kit's TaskCard). The crew rail beside it.
// Opening a row navigates at once (design/feedback.md); Mark done is optimistic through the command.

import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import type { EntityKey, Json } from '@wisp/client';
import { forLater, markRead, setState } from './commands.ts';
import { CrewRail, Feed, FeedSection, SidebarHead, SplitTop, TaskCard, useSignal, type MenuEntry, type ProjectChip, type RailMember } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { routeOf, routeTip } from './auto.ts';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { rowSlots, useHeadSlots } from './slots.tsx';
import { harnessOf } from './harness.ts';
import { SECTIONS, goalOf, longTime, overlapOf, sectionOf, shortAgo, statusOf, type SectionId } from './rows-view.ts';


interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly color: string;
}

interface CrewRow {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly color?: string;
}

function useSessions(): () => readonly SessionRow[] {
  const shell = useShell();
  const all = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  return createMemo(() => all().filter((s) => !s.archived));
}

export function Rail(): JSX.Element {
  const shell = useShell();
  const crew = useSignal(shell.client.entities.list<CrewRow>('crew_member'));
  const members = createMemo<RailMember[]>(() => crew().map((c) => ({ id: c.id, name: c.name, avatar: c.avatar ?? '', color: c.color ?? 'violet' })));
  const nav = useSignal(shell.nav);
  return (
    <CrewRail
      label={shell.t('shell.rail.label')}
      allLabel={shell.t('shell.rail.all')}
      orgLabel={shell.t('shell.rail.org')}
      addLabel={shell.t('shell.rail.add')}
      allOn={nav().main.kind !== 'crew'}
      members={members()}
      onAll={() => shell.navigate({ t: 'home' })}
      onMember={(id) => shell.navigate({ t: 'openCrew', id: id as never })}
      onOrg={() => shell.navigate({ t: 'openView', id: 'crew.org' as never, params: null as Json })}
      onAdd={() => shell.navigate({ t: 'openView', id: 'crew.new' as never, params: null as Json })}
    />
  );
}

/** The project the list shows (All is 'all'): the chips set it, the list follows. */
export function Head(props: { readonly filter: () => string; readonly setFilter: (id: string) => void }): JSX.Element {
  const shell = useShell();
  const sessions = useSessions();
  const projects = useSignal(shell.client.entities.list<ProjectRow>('project'));
  const needs = (pred: (s: SessionRow) => boolean): number => sessions().filter((s) => sectionOf(s) === 'needs' && pred(s)).length;
  const needLabel = (n: number): string => shell.t(n === 1 ? 'shell.side.need.one' : 'shell.side.need.other', { count: n });
  const chips = createMemo<ProjectChip[]>(() => {
    const all = needs(() => true);
    return [
      { id: 'all', name: shell.t('shell.side.allChip'), title: shell.t('shell.side.all'), need: all, needLabel: needLabel(all) },
      ...projects().map((p) => {
        const n = needs((s) => s.summary['projectId'] === p.id);
        return { id: p.id, name: p.name, title: p.path, color: p.color, need: n, needLabel: needLabel(n) };
      }),
    ];
  });
  const slots = useHeadSlots();
  const nav = useSignal(shell.nav);
  const homeOn = (): boolean => nav().main.kind === 'home';
  const sheet = (pane: string | undefined): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: pane === undefined ? {} : { pane } } });
  const account = (): MenuEntry[] => [
    { value: 'settings', label: shell.t('shell.account.settings'), icon: 'settings', part: 'topbar.settings' },
    { value: 'machines', label: shell.t('shell.account.machines'), icon: 'laptop' },
    { value: 'automations', label: shell.t('shell.account.automations'), icon: 'bolt' },
    { kind: 'separator' },
    { value: 'theme', label: shell.t(shell.theme.resolved() === 'dark' ? 'shell.cmd.theme.light' : 'shell.cmd.theme.dark'), icon: shell.theme.resolved() === 'dark' ? 'sun' : 'moon' },
  ];
  const onAccount = (v: string): void => {
    if (v === 'theme') void shell.theme.set(shell.theme.resolved() === 'dark' ? 'light' : 'dark');
    else if (v === 'machines') shell.navigate({ t: 'openView', id: 'machine.this' as never, params: null as Json });
    // Settings on a phone opens on its list, as v1's did; a wider window shows General beside the list
    else sheet(v === 'automations' ? 'automations' : nav().layout === 'stack' ? undefined : 'general');
  };
  return (
    <SidebarHead
      homeOn={homeOn()}
      slots={slots()}
      brandLabel={shell.t('shell.brand')}
      searchLabel={shell.t('shell.side.search')}
      accountLabel={shell.t('shell.side.account')}
      viewLabel={shell.t('shell.side.view')}
      manageLabel={shell.t('shell.side.manage')}
      chips={chips()}
      on={props.filter()}
      onBrand={() => shell.navigate({ t: 'home' })}
      onSearch={() => shell.palette.open()}
      onView={() => shell.sidebar.toggle()}
      onChip={(id) => props.setFilter(id)}
      accountAct={{ menu: { items: account(), onSelect: onAccount } }}
      manageAct={{ menu: { items: [{ value: 'add', label: shell.t('shell.home.addProject'), icon: 'folder' }, { value: 'manage', label: shell.t('shell.side.manage'), icon: 'settings' }], onSelect: (v) => sheet(v === 'add' ? 'projects' : 'projects') } }}
    />
  );
}

export function SidebarList(props: { readonly onNew: () => void; readonly homeOn: boolean; readonly filter: () => string }): JSX.Element {
  const shell = useShell();
  const sessions = useSessions();
  const nav = useSignal(shell.nav);
  const now = useNow(shell.client);
  const [folded, setFolded] = createSignal<ReadonlySet<SectionId>>(new Set());
  const harnesses = useSignal(shell.harnesses());
  const selected = useSignal(() => shell.selection.get());
  const open = createMemo(() => {
    const m = nav().main;
    return m.kind === 'task' ? m.id : undefined;
  });
  const titleOf = (id: string): string => sessions().find((s) => s.id === id)?.title ?? '';
  // newest first within a section, as v1's feed
  const bySection = createMemo(() => {
    const out = new Map<SectionId, SessionRow[]>();
    for (const s of [...sessions()].filter((s) => props.filter() === 'all' || s.summary['projectId'] === props.filter()).sort((a, b) => b.updated_at - a.updated_at)) {
      const k = sectionOf(s);
      out.set(k, [...(out.get(k) ?? []), s]);
    }
    return out;
  });
  const toggle = (id: SectionId): void => {
    const next = new Set(folded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
  };
  return (
    <>
      <SplitTop newLabel={shell.t('shell.side.new')} newTitle={shell.t('shell.side.newTitle')} stuffLabel={shell.t('shell.side.stuff')} on={props.homeOn} onNew={props.onNew} onStuff={() => shell.navigate({ t: 'openView', id: 'stuff.page' as never, params: null as Json })} />
      <Feed>
        <For each={SECTIONS.filter((id) => (bySection().get(id)?.length ?? 0) > 0)}>
          {(id) => (
            <FeedSection id={id} name={shell.t(`shell.section.${id}`)} count={bySection().get(id)?.length ?? 0} collapsed={folded().has(id)} onToggle={() => toggle(id)}>
              <For each={bySection().get(id) ?? []}>
                {(s) => {
                  // the third line names a coding agent: only one a harness plugin describes
                  const h = harnesses().some((x) => x.id === s.agent) ? harnessOf(harnesses(), s.agent) : undefined;
                  const where = shell.t('shell.card.thisComputer');
                  const goal = goalOf(s, shell.t);
                  const overlap = overlapOf(s, titleOf, shell.t);
                  // Auto picked this run: the logo's dot, and why in its tip (v1 runners.js modelBadge)
                  const route = routeOf(s.body);
                  return (
                    <TaskCard
                      slots={rowSlots(s.id, () => s as never)}
                      id={s.id}
                      title={s.title}
                      sub={s.summary.live || s.summary.preview}
                      color={String(s.summary['color'] ?? 'slate')}
                      unread={s.unread}
                      open={open() === s.id}
                      selected={selected() === s.id}
                      done={s.state === 'done'}
                      status={statusOf(s, shell.t)}
                      {...(goal && { goal })}
                      {...(overlap && { overlap })}
                      {...(h && { run: { harness: h.name, where, title: route ? routeTip(route, shell.t) : shell.t('shell.card.runTitle', { harness: h.name, where }), routed: !!route, ...(h.logo && { logo: h.logo }) } })}
                      time={shortAgo(s.updated_at, now())}
                      timeTitle={longTime(s.updated_at)}
                      laterLabel={shell.t('shell.card.later')}
                      laterOn={s.summary['forLater'] === true}
                      onDone={() => void shell.client.commands.run(setState, { id: s.id, state: 'done' }).catch(() => undefined)}
                      onLater={() => void shell.client.commands.run(forLater, { id: s.id, forLater: s.summary['forLater'] !== true }).catch(() => undefined)}
                      doneLabel={shell.t('shell.card.done')}
                      onOpen={() => {
                        shell.selection.set(s.id);
                        if (s.unread) void shell.client.commands.run(markRead, { id: s.id, unread: false }).catch(() => undefined);
                        shell.navigate({ t: 'openTask', id: s.id as EntityKey as never });
                      }}
                    />
                  );
                }}
              </For>
            </FeedSection>
          )}
        </For>
      </Feed>
      <Show when={sessions().length === 0}>{null}</Show>
    </>
  );
}
