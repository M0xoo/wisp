// The cells of a task row, each from the row model (model/row.ts): the agent's mark in the project's
// colour, the line under the title (live, held, scheduled or the report), the run line (harness,
// model, where it runs, project, branch), the pills, the RAM and the time, and the hover actions.
// Every cell keeps its place whatever the task says, so a row never shifts (design/layout.md §4).

import { routeOf, routeTip, type HarnessUiDef, type RouteSeen } from '@wisp/shell';
import { For, Match, Show, Switch, type JSX } from 'solid-js';
import { Dot, Face, Gap, GoalPill, Icon, OverlapPill, Pill, RowButton, RowLogo, RowPill, RowRun, Text, Time, futureLabel, timeTitle, useSignal } from '@wisp/ui';
import type { EntityKey } from '@wisp/client';
import { colorToken, type SessionRow } from '../types.ts';
import type { PillView, RowView, RunView, SubView } from '../model/row.ts';
import { crewFaceOf, type CrewFace, type MemberRow } from '../model/crew-face.ts';
import { toggleDone, toggleForLater } from '../actions.ts';
import { kitT, say } from './say.ts';
import { useEnv } from './env.ts';

export function Mark(props: { readonly s: SessionRow; readonly view: RowView; readonly name: string }): JSX.Element {
  const env = useEnv();
  const m = (): RowView['mark'] => props.view.mark;
  const members = useSignal(env.client.entities.list<MemberRow>('crew_member'));
  // a crew job shows its member's face where other rows have their project dot (v1 crew.js crewDot), in Needs you too
  const member = (): CrewFace | undefined => crewFaceOf(members() as readonly MemberRow[], props.s);
  return (
    <Switch>
      <Match when={m().kind === 'agent' ? member() : undefined}>
        {(f) => (
          <Face
            avatar={f().avatar}
            name={f().name}
            {...(f().color !== undefined && { color: f().color as string })}
            size="xs"
            mood={f().mood}
            label={f().name}
            part={'list.row.mark crew.dot' as `${string}.${string}`}
          />
        )}
      </Match>
      <Match when={m().kind === 'bell'}>
        <Icon name="bell" size="md" tone="muted" label={env.shell.t('shell-list.mark.reminder')} part="list.row.mark" />
      </Match>
      <Match
        when={(() => {
          const x = m();
          return x.kind === 'origin' ? x : undefined;
        })()}
      >
        {(o) => <Icon name={o().icon} size="md" tone="muted" label={say(env.shell.t, o().title, env.now())} part="list.row.mark" />}
      </Match>
      <Match
        when={(() => {
          const x = m();
          return x.kind === 'agent' ? x : undefined;
        })()}
      >
        {/* v1 feed.css .q-dot: the task's project colour (slate without a project), warn while it asks you; it pulses
            while the run works or waits. Unread is the title's (600, ink: ListRow strong), never the dot's. */}
        {(a) => (
          <Show
            when={props.s.state === 'waiting'}
            fallback={<Dot size="md" color={colorToken(props.s.project ? props.s.color : undefined)} live={a().live} part={'list.row.mark card.dot' as `${string}.${string}`} />}
          >
            <Dot size="md" tone="warn" live part={'list.row.mark card.dot' as `${string}.${string}`} />
          </Show>
        )}
      </Match>
    </Switch>
  );
}

/** The line under the title as v1 has it (#feed .it-sub): its words alone (an icon before them for a held or scheduled
 *  task); its tone and tooltip go on the row's sub (`subOf`). */
export function SubLine(props: { readonly sub: SubView | undefined }): JSX.Element {
  const env = useEnv();
  return (
    <Show when={props.sub}>
      {(sub) => (
        <>
          <Show when={sub().icon}>{(ic) => <Icon name={ic()} size="xs" tone={sub().held ? 'warn' : 'muted'} />}</Show>
          {say(env.shell.t, sub().text, env.now())}
        </>
      )}
    </Show>
  );
}

/** The sub's tone (running in accent ink, waiting in warn) and its tooltip. */
export function subOf(sub: SubView | undefined, t: (k: string) => string, now: number): { tone: 'accent-ink' | 'warn' | 'muted'; title: string | undefined } {
  const tone = sub?.live === 'running' ? 'accent-ink' : sub?.live === 'waiting' ? 'warn' : 'muted';
  return { tone, title: sub?.title ? say(t as never, sub.title ?? sub.text, now) : undefined };
}

/** Harness · model · where: the row's third line (v1 feed.js runLine(): nothing else; the project and the branch are
 *  the task page's details, split.css hides .q-proj in the sidebar). */
export function RunLine(props: { readonly run: RunView; readonly s: SessionRow }): JSX.Element {
  const env = useEnv();
  const route = (): RouteSeen | undefined => routeOf({ ext: (props.s as { ext?: unknown }).ext });
  const harnesses = useSignal(env.shell.harnesses());
  /** the harness as its plugin registered it: v1's name ("Claude Code") and logo */
  const harness = (): HarnessUiDef | undefined => harnesses().find((h) => h.id === props.s.agent);
  const name = (): string => harness()?.name ?? props.run.agentName;
  return (
    <RowRun
      part="list.row.run card.run"
      // v1 runBadge: the harness's logo (Auto's accent dot on its corner when it picked the run)
      logo={
        <Show
          when={harness()?.logo}
          fallback={
            <Show when={route()}>
              <Dot tone="accent" />
            </Show>
          }
        >
          {(src) => <RowLogo src={src()} routed={!!route()} />}
        </Show>
      }
      name={name()}
      model={props.run.model}
      // the tip names the harness as its plugin registered it, as the line does
      title={route() ? routeTip(route() as RouteSeen, env.shell.t) : say(env.shell.t, { ...props.run.title, vars: { ...props.run.title.vars, agent: name() } }, env.now())}
      where={{ icon: props.run.sandbox ? 'box' : props.run.remote ? 'server' : 'laptop', text: props.run.where }}
    />
  );
}

/** The state as v1's sidebar draws it (split.css #feed .it-side .pill: 19px, no fill, its dot). */
const ROW_TONE: Readonly<Record<string, 'info' | 'warn' | 'bad' | 'neutral' | undefined>> = { good: undefined, accent: 'info', info: 'info', warn: 'warn', bad: 'bad', neutral: 'neutral' };

function OnePill(props: { readonly p: PillView }): JSX.Element {
  const env = useEnv();
  const label = (): string => say(env.shell.t, props.p.label, env.now());
  if (props.p.id === 'status' && !props.p.icon)
    return (
      <RowPill
        tone={ROW_TONE[props.p.tone] ?? 'neutral'}
        label={label()}
        part={'list.pill.status card.status' as `${string}.${string}`}
        {...(props.p.title ? { title: say(env.shell.t, props.p.title, env.now()) } : {})}
      />
    );
  return (
    <Pill
      tone={props.p.tone}
      variant={props.p.variant ?? 'plain'}
      size="sm"
      part={(V1_PILL[props.p.id] ? `list.pill.${props.p.id} ${V1_PILL[props.p.id]}` : `list.pill.${props.p.id}`) as `${string}.${string}`}
      {...(props.p.dot ? { dot: true } : {})}
      {...(props.p.live ? { live: true } : {})}
      {...(props.p.icon ? { icon: props.p.icon } : {})}
      {...(props.p.title ? { title: say(env.shell.t, props.p.title, env.now()) } : {})}
    >
      {label()}
    </Pill>
  );
}

export function Pills(props: { readonly view: RowView }): JSX.Element {
  const env = useEnv();
  return (
    <>
      <For each={props.view.pills.filter((p) => p.id === 'status')}>{(p) => <OnePill p={p} />}</For>
      <Show when={props.view.goal}>
        {(g) => <GoalPill n={g().n} progress={g().progress} paused={g().paused} title={say(env.shell.t, g().title, env.now())} part={'list.pill.goal card.goal' as `${string}.${string}`} />}
      </Show>
      <Show when={props.view.overlap}>{(o) => <OverlapPill n={o().n} title={say(env.shell.t, o().title, env.now())} part={'list.pill.overlap card.overlap' as `${string}.${string}`} />}</Show>
      <For each={props.view.pills.filter((p) => p.id !== 'status')}>{(p) => <OnePill p={p} />}</For>
      <Show when={props.view.ram}>
        {(ram) => (
          <Text size="xs" tone="muted" numeric nowrap title={env.shell.t('shell-list.row.ram-tip', { size: ram() })} part="list.row.ram">
            {ram()}
          </Text>
        )}
      </Show>
    </>
  );
}

export function TimeCell(props: { readonly view: RowView }): JSX.Element {
  const env = useEnv();
  const tip = (): string | undefined => (props.view.time.title ? say(env.shell.t, props.view.time.title, env.now()) : undefined);
  return (
    <Show when={props.view.time.kind === 'ahead'} fallback={<Time at={props.view.time.at} now={env.now()} t={kitT(env.shell.t)} part={'list.row.time card.time' as `${string}.${string}`} />}>
      <Text size="xs" tone="faint" numeric nowrap title={tip() ?? timeTitle(props.view.time.at, env.now(), kitT(env.shell.t))} part={'list.row.time card.time' as `${string}.${string}`}>
        {futureLabel(props.view.time.at, env.now())}
      </Text>
    </Show>
  );
}

/** Save for later and Mark done, each in a fixed slot: a row without one keeps its space. More is the row's
 *  context menu (right-click, long-press), as v1 had it: two quick buttons, about 40px held (owner, 2026-11-10). */
/** v1's PARTS for a row's pills (#feed .it-side .pill.st-*, .pill.pr), so qa/parity.mjs measures them. */
const V1_PILL: Readonly<Record<string, string>> = { status: 'card.status', pr: 'card.pr' };

export function Actions(props: { readonly k: EntityKey; readonly view: RowView; readonly hover?: JSX.Element }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  return (
    <>
      {props.hover}
      <Show when={props.view.quickLater !== 'gap'} fallback={<Gap size="sm" />}>
        <RowButton
          icon="bookmark"
          part={'list.row.later card.quickLater' as `${string}.${string}`}
          pressed={props.view.quickLater === 'unsave'}
          label={t(props.view.quickLater === 'unsave' ? 'shell-list.quick.unsave' : 'shell-list.quick.save')}
          onClick={() => toggleForLater(env.actions, props.k)}
        />
      </Show>
      <Show when={props.view.quickDone !== 'none'}>
        <Show when={props.view.quickDone === 'show'} fallback={<Gap size="sm" />}>
          <RowButton icon="done" tone="good" part={'list.row.done card.quickDone' as `${string}.${string}`} label={t('shell-list.quick.done')} onClick={() => toggleDone(env.actions, props.k)} />
        </Show>
      </Show>
    </>
  );
}
