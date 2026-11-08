// The sidebar as v1 shows it (web/js/features/split.js, feed.js): its head (the brand, Search, the
// avatar, the sidebar button and the project chips), New task and My Stuff, then the list in its
// sections (Needs you, Working, Done), each task a row (the kit's TaskCard). The crew rail beside it.
// Opening a row navigates at once (design/feedback.md); Mark done is optimistic through the command.

import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import { CrewRail, Feed, FeedSection, SidebarHead, SplitTop, TaskCard, useSignal, type ProjectChip, type RailMember } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { HARNESS, SECTIONS, goalOf, longTime, overlapOf, sectionOf, shortAgo, statusOf, type SectionId } from './rows-view.ts';

/** Opening a task reads it (v1 feed.js): the row loses its bold at once. */
const markRead = defineCommand<{ id: string; unread: boolean }>({
  id: 'runtime.markRead',
  owner: (a) => a.id,
  optimistic: (_base, a) => [{ e: SESSION, id: a.id as EntityKey, op: 'patch', ops: [{ op: 'replace', path: '/unread', value: a.unread }] }],
});

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
  const crew = useSignal(shell.client.entities.list<CrewRow>('crew.member'));
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
    />
  );
}

export function Head(): JSX.Element {
  const shell = useShell();
  const sessions = useSessions();
  const projects = useSignal(shell.client.entities.list<ProjectRow>('project'));
  const [on, setOn] = createSignal('all');
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
  return (
    <SidebarHead
      brandLabel={shell.t('shell.brand')}
      searchLabel={shell.t('shell.side.search')}
      accountLabel={shell.t('shell.side.account')}
      viewLabel={shell.t('shell.side.view')}
      manageLabel={shell.t('shell.side.manage')}
      chips={chips()}
      on={on()}
      onBrand={() => shell.navigate({ t: 'home' })}
      onSearch={() => shell.palette.open()}
      onView={() => shell.sidebar.toggle()}
      onChip={(id) => setOn(id)}
    />
  );
}

export function SidebarList(props: { readonly onNew: () => void; readonly homeOn: boolean }): JSX.Element {
  const shell = useShell();
  const sessions = useSessions();
  const nav = useSignal(shell.nav);
  const now = useNow(shell.client);
  const [folded, setFolded] = createSignal<ReadonlySet<SectionId>>(new Set());
  const open = createMemo(() => {
    const m = nav().main;
    return m.kind === 'task' ? m.id : undefined;
  });
  const titleOf = (id: string): string => sessions().find((s) => s.id === id)?.title ?? '';
  // newest first within a section, as v1's feed
  const bySection = createMemo(() => {
    const out = new Map<SectionId, SessionRow[]>();
    for (const s of [...sessions()].sort((a, b) => b.updated_at - a.updated_at)) {
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
      <SplitTop newLabel={shell.t('shell.side.new')} newTitle={shell.t('shell.side.newTitle')} stuffLabel={shell.t('shell.side.stuff')} on={props.homeOn} onNew={props.onNew} />
      <Feed>
        <For each={SECTIONS.filter((id) => (bySection().get(id)?.length ?? 0) > 0)}>
          {(id) => (
            <FeedSection id={id} name={shell.t(`shell.section.${id}`)} count={bySection().get(id)?.length ?? 0} collapsed={folded().has(id)} onToggle={() => toggle(id)}>
              <For each={bySection().get(id) ?? []}>
                {(s) => {
                  const h = HARNESS[s.agent];
                  const where = shell.t('shell.card.thisComputer');
                  const goal = goalOf(s, shell.t);
                  const overlap = overlapOf(s, titleOf, shell.t);
                  return (
                    <TaskCard
                      id={s.id}
                      title={s.title}
                      sub={s.summary.live || s.summary.preview}
                      color={String(s.summary['color'] ?? 'slate')}
                      unread={s.unread}
                      open={open() === s.id}
                      done={s.state === 'done'}
                      status={statusOf(s, shell.t)}
                      {...(goal && { goal })}
                      {...(overlap && { overlap })}
                      {...(h && { run: { harness: h.name, where, title: shell.t('shell.card.runTitle', { harness: h.name, where }), ...(h.logo && { logo: h.logo }) } })}
                      time={shortAgo(s.updated_at, now())}
                      timeTitle={longTime(s.updated_at)}
                      laterLabel={shell.t('shell.card.later')}
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
