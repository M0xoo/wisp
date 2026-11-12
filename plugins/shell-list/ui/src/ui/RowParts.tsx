// The cells of a task row, each from the row model (model/row.ts): the agent's mark in the project's
// colour, the line under the title (live, held, scheduled or the report), the run line (harness,
// model, where it runs, project, branch), the pills, the RAM and the time, and the hover actions.
// Every cell keeps its place whatever the task says, so a row never shifts (design/layout.md §4).

import { routeOf, routeTip, type HarnessUiDef, type RouteSeen } from '@wisp/shell';
import { For, Match, Show, Switch, type JSX } from 'solid-js';
import { Dot, Gap, GoalPill, Icon, Inline, OverlapPill, Pill, RowButton, RowLogo, RowPill, Text, Time, futureLabel, timeTitle, useSignal } from '@wisp/ui';
import type { EntityKey } from '@wisp/client';
import { colorToken, type SessionRow } from '../types.ts';
import type { PillView, RowView, RunView, SubView } from '../model/row.ts';
import { toggleDone, toggleForLater } from '../actions.ts';
import { kitT, say } from './say.ts';
import { useEnv } from './env.ts';

export function Mark(props: { readonly s: SessionRow; readonly view: RowView; readonly name: string }): JSX.Element {
  const env = useEnv();
  const m = (): RowView['mark'] => props.view.mark;
  return (
    <Switch>
      <Match when={m().kind === 'bell'}>
        <Icon name="bell" size="md" tone="muted" label={env.shell.t('shell-list.mark.reminder')} part="list.row.mark" />
      </Match>
      <Match when={(() => { const x = m(); return x.kind === 'origin' ? x : undefined; })()}>
        {(o) => <Icon name={o().icon} size="md" tone="muted" label={say(env.shell.t, o().title, env.now())} part="list.row.mark" />}
      </Match>
      <Match when={(() => { const x = m(); return x.kind === 'agent' ? x : undefined; })()}>
        {/* v1 feed.js .it-dot: one dot before the title, the accent while unread, grey once read; it pulses while the run works */}
        {(a) => (
          <Dot
            size="md"
            tone={props.view.unread ? 'accent' : 'neutral'}
            live={a().live}
            {...(props.view.unread ? { label: env.shell.t('shell-list.row.unread') } : {})}
            part={'list.row.mark card.dot' as `${string}.${string}`}
          />
        )}
      </Match>
    </Switch>
  );
}

export function SubLine(props: { readonly sub: SubView | undefined }): JSX.Element {
  const env = useEnv();
  return (
    <Show when={props.sub}>
      {(sub) => (
        <Inline gap="2" align="center" part="list.row.line">
          <Show when={sub().icon}>{(ic) => <Icon name={ic()} size="xs" tone={sub().held ? 'warn' : 'muted'} />}</Show>
          <Text size="sm" truncate tone={sub().live === 'running' ? 'accent-ink' : sub().live === 'waiting' ? 'warn' : 'muted'} {...(sub().title ? { title: say(env.shell.t, sub().title ?? sub().text, env.now()) } : {})}>
            {say(env.shell.t, sub().text, env.now())}
          </Text>
        </Inline>
      )}
    </Show>
  );
}

/** Harness · model · where, then the project and the branch: the row's third line. */
export function RunLine(props: { readonly run: RunView | undefined; readonly s: SessionRow }): JSX.Element {
  const env = useEnv();
  const route = (): RouteSeen | undefined => routeOf({ ext: (props.s as { ext?: unknown }).ext });
  const harnesses = useSignal(env.shell.harnesses());
  /** the harness as its plugin registered it: v1's name ("Claude Code") and logo */
  const harness = (): HarnessUiDef | undefined => harnesses().find((h) => h.id === props.s.agent);
  return (
    <Inline gap="3" align="center" part="list.row.run">
      <Show when={props.run}>
        {(r) => (
          <Inline gap="2" align="center" part="list.row.harness">
            {/* v1 runBadge: the harness's logo (Auto's accent dot on its corner when it picked the run) and its name */}
            <Show when={harness()?.logo} fallback={<Show when={route()}><Dot tone="accent" /></Show>}>
              {(src) => <RowLogo src={src()} routed={!!route()} />}
            </Show>
            <Text size="xs" tone="muted" truncate title={route() ? routeTip(route() as RouteSeen, env.shell.t) : say(env.shell.t, r().title, env.now())}>
              {r().model ? `${harness()?.name ?? r().agentName} · ${r().model}` : (harness()?.name ?? r().agentName)}
            </Text>
            <Text size="xs" tone="faint">·</Text>
            <Icon name={r().sandbox ? 'box' : r().remote ? 'server' : 'laptop'} size="xs" tone="faint" />
            <Text size="xs" tone="faint" truncate>{r().where}</Text>
          </Inline>
        )}
      </Show>
      {/* v1 feed.js runLine(): the harness, its model and the computer, nothing else (the project and the branch are
          the task page's details; split.css hides .q-proj in the sidebar) */}
    </Inline>
  );
}

/** The state as v1's sidebar draws it (split.css #feed .it-side .pill: 19px, no fill, its dot). */
const ROW_TONE: Readonly<Record<string, 'info' | 'warn' | 'bad' | 'neutral' | undefined>> = { good: undefined, accent: 'info', info: 'info', warn: 'warn', bad: 'bad', neutral: 'neutral' };

function OnePill(props: { readonly p: PillView }): JSX.Element {
  const env = useEnv();
  const label = (): string => say(env.shell.t, props.p.label, env.now());
  if (props.p.id === 'status' && !props.p.icon)
    return <RowPill tone={ROW_TONE[props.p.tone] ?? 'neutral'} label={label()} part={'list.pill.status card.status' as `${string}.${string}`} {...(props.p.title ? { title: say(env.shell.t, props.p.title, env.now()) } : {})} />;
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
      <Show when={props.view.goal}>{(g) => <GoalPill n={g().n} progress={g().progress} paused={g().paused} title={say(env.shell.t, g().title, env.now())} part={'list.pill.goal card.goal' as `${string}.${string}`} />}</Show>
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
    <Show
      when={props.view.time.kind === 'ahead'}
      fallback={<Time at={props.view.time.at} now={env.now()} t={kitT(env.shell.t)} part="list.row.time" />}
    >
      <Text size="xs" tone="faint" numeric nowrap title={tip() ?? timeTitle(props.view.time.at, env.now(), kitT(env.shell.t))} part="list.row.time">
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
