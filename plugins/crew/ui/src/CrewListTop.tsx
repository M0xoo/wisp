// The phone's Crew section at the top of the list (v1 #secCrew): with no rail, the crew is reached here. A folding
// Crew heading with Org and +, a row per member opening their thread, a dashed row to add the first one. Under a member,
// its jobs for other tasks (delegated, @mentions, checks) as the list's own cards, the most urgent first, 3 at most
// (v1 crew.js paintCrew / memberJobs): the list lends its card (ShellApi.taskCards) and leaves those jobs out.
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import type { ExtensionProps } from '@wisp/shell/contract';
import { useShell } from '@wisp/shell';
import { CrewListFewer, CrewListSection, CrewListStrip, useSignal, type CrewListRow } from '@wisp/ui';
import { foldedWords, statusLine } from './model.ts';
import { sectionPlan, type SectionHold } from './fold.ts';
import { crewData, emptyState } from './data.ts';
import { memberJobs, NeedsTracker } from './rules/feed.ts';
import { t } from './i18n.ts';
import { cadenceText } from './model.ts';
import type { Member } from './types.ts';
import { VIEW } from './views.ts';

export default function CrewListTop(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const nav = useSignal(shell.nav);
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const members = useSignal(crewData(c).members);
  const [folded, setFolded] = createSignal(false);
  // a member's jobs under it: v1's rules (rules/feed.ts) with this page's open task and the list's project
  const data = crewData(c);
  const states = useSignal(data.states);
  const card = useSignal(shell.taskCards?.render ?? (() => undefined));
  const projectFilter = useSignal(shell.projectFilter?.value ?? (() => 'all'));
  const needs = new NeedsTracker();
  // no open set: the list leaves a job out exactly when it doesn't need you (shell-list sections.ts), so the two agree
  // and a job is always in one of them (v1's sticky Needs you for an open report would drop it from both here)
  const none: ReadonlySet<string> = new Set();
  // compact (v1 #secCrew): busy members and two more get a row, the rest fold into faces; Show all for this visit
  const ranked = useSignal(data.ranked);
  const [all, setAll] = createSignal(false);
  const [hold, setHold] = createSignal<SectionHold>({ order: null, full: new Set() });
  // the member open in the main pane, by id (navigation holds its key, `<peer>:<id>`)
  const crewOpen = (): string | null => {
    const m = nav().main as { kind?: string; id?: unknown };
    return m.kind === 'crew' ? (data.byId(String(m.id ?? ''))?.id ?? null) : null;
  };
  const plan = createMemo(() => sectionPlan(ranked() as unknown as readonly Member[], states(), { all: all(), open: none, hold: hold(), crewOpen: crewOpen() }));
  const onHold = (on: boolean): void => {
    const p = plan();
    // pointer in: hold the order and the rows shown, so nothing moves under it; out: fold what went quiet
    setHold(on ? { order: [...p.rows, ...p.folded].map((m) => m.id), full: new Set(p.rows.map((m) => m.id)) } : { order: null, full: new Set() });
  };
  const jobsOf = createMemo(() => {
    const ids = new Set((members() as readonly { id: string }[]).map((m) => m.id));
    const ctx = { filter: projectFilter(), pick: null, open: none, has: (id: string) => ids.has(id), needs, crewOpen: null, pinned: none };
    const p = plan();
    return new Map((members() as readonly (Member & { paused?: boolean })[]).map((m) => [m.id, memberJobs(m, states().get(m.id) ?? emptyState(!!m.paused), ctx, p.jobsMax(m.id))]));
  });
  const Jobs = (p: { readonly id: string }): JSX.Element => (
    <For each={jobsOf().get(p.id)?.list ?? []}>
      {(s) => (
        <Show when={data.sessionKey(s.id)}>
          {(k) => card()?.(k())}
        </Show>
      )}
    </For>
  );
  const orgOn = (): boolean => nav().main.kind === 'view' && String((nav().main as { id?: unknown }).id) === VIEW.org;
  const rows = createMemo((): CrewListRow[] =>
    (plan().rows as unknown as readonly (Member & { key: string })[]).map((m) => ({
      id: m.key,
      name: m.name,
      role: m.role,
      avatar: m.avatar,
      color: m.color,
      sub: m.paused ? t('wisp.crew.org.paused') : cadenceText(m, say as never),
      paused: m.paused,
      jobs: card() ? <Jobs id={m.id} /> : undefined,
      more: () => {
        const n = jobsOf().get(m.id)?.more ?? 0;
        return n > 0 ? say('wisp.crew.list.more', { count: n, name: m.name }) : undefined;
      },
    })),
  );
  return (
    // only where there's no rail: the phone's stacked list
    <Show when={nav().layout === 'stack'}>
      <CrewListSection
        name={t('wisp.crew.list.name')}
        count={members().length}
        collapsed={folded()}
        onToggle={() => setFolded(!folded())}
        org={rows().length > 0 ? { label: t('wisp.crew.org.title'), title: t('wisp.crew.list.orgTitle'), on: orgOn(), onClick: () => c.navigate({ t: 'openView', id: VIEW.org as never, params: null }) } : undefined}
        add={{ label: t('wisp.crew.org.addTitle'), onClick: () => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW.editor as never, params: {} } }) }}
        rows={rows()}
        onHold={onHold}
        foot={
          <Show
            when={plan().folded.length > 0}
            fallback={<Show when={plan().fewer}><CrewListFewer label={t('wisp.crew.list.fewer')} onClick={() => setAll(false)} /></Show>}
          >
            <CrewListStrip
              faces={(plan().faces as unknown as readonly (Member & { key: string })[]).map((m) => ({
                id: m.key,
                name: m.name,
                avatar: m.avatar,
                color: m.color,
                on: m.id === crewOpen(),
                title: `${m.name} · ${statusLine(m, states().get(m.id) ?? emptyState(!!m.paused), { t: say as never, now: c.scope.timers.now(), when: () => '' }).text}`,
                label: say('wisp.crew.list.open', { name: m.name }),
              }))}
              words={foldedWords(plan().folded, say as never)}
              title={say('wisp.crew.list.all', { n: members().length })}
              onFace={(id) => c.navigate({ t: 'openCrew', id: id as never })}
              onExpand={() => setAll(true)}
            />
          </Show>
        }
        empty={{ title: t('wisp.crew.list.emptyTitle'), sub: t('wisp.crew.list.emptySub') }}
        openLabel={(name) => say('wisp.crew.list.open', { name })}
        onOpen={(id) => c.navigate({ t: 'openCrew', id: id as never })}
      />
    </Show>
  );
}
