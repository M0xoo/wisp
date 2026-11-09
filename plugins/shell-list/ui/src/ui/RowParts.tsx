// The cells of a task row, each from the row model (model/row.ts): the agent's mark in the project's
// colour, the line under the title (live, held, scheduled or the report), the run line (harness,
// model, where it runs, project, branch), the pills, the RAM and the time, and the hover actions.
// Every cell keeps its place whatever the task says, so a row never shifts (design/layout.md §4).

import { For, Match, Show, Switch, type JSX } from 'solid-js';
import { Avatar, Dot, Gap, Icon, IconButton, Inline, Pill, Text, Time, futureLabel, timeTitle } from '@wisp/ui';
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
        {(a) => <Avatar name={props.name} size="sm" color={colorToken(props.s.color)} {...(a().status ? { status: a().status } : {})} part="list.row.mark" />}
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
  return (
    <Inline gap="3" align="center" part="list.row.run">
      <Show when={props.run}>
        {(r) => (
          <Inline gap="2" align="center" part="list.row.harness">
            <Text size="xs" tone="faint" truncate title={say(env.shell.t, r().title, env.now())}>
              {r().model ? `${r().agentName} · ${r().model}` : r().agentName}
            </Text>
            <Icon name={r().remote ? 'server' : 'laptop'} size="xs" tone="faint" />
            <Text size="xs" tone="faint" truncate>{r().where}</Text>
          </Inline>
        )}
      </Show>
      <Show when={props.s.project}>
        {(name) => (
          <Inline gap="1" align="center" part="list.row.project">
            <Dot color={colorToken(props.s.color)} />
            <Text size="xs" tone="muted" truncate>{name()}</Text>
          </Inline>
        )}
      </Show>
      <Show when={props.s.branch}>
        {(b) => (
          <Inline gap="1" align="center" part="list.row.branch">
            <Icon name="branch" size="xs" tone="faint" />
            <Text size="xs" tone="faint" mono truncate title={b()}>{b()}</Text>
          </Inline>
        )}
      </Show>
    </Inline>
  );
}

function OnePill(props: { readonly p: PillView }): JSX.Element {
  const env = useEnv();
  const label = (): string => say(env.shell.t, props.p.label, env.now());
  return (
    <Pill
      tone={props.p.tone}
      variant={props.p.variant ?? 'soft'}
      part={`list.pill.${props.p.id}`}
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
      <Show when={props.view.unread}>
        <Dot tone="accent" size="md" label={env.shell.t('shell-list.row.unread')} part="list.row.unread" />
      </Show>
      <For each={props.view.pills}>{(p) => <OnePill p={p} />}</For>
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
export function Actions(props: { readonly k: EntityKey; readonly view: RowView; readonly hover?: JSX.Element }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  return (
    <>
      {props.hover}
      <Show when={props.view.quickLater !== 'gap'} fallback={<Gap size="sm" />}>
        <IconButton
          icon="bookmark"
          size="sm"
          pressed={props.view.quickLater === 'unsave'}
          label={t(props.view.quickLater === 'unsave' ? 'shell-list.quick.unsave' : 'shell-list.quick.save')}
          onClick={() => toggleForLater(env.actions, props.k)}
        />
      </Show>
      <Show when={props.view.quickDone !== 'none'}>
        <Show when={props.view.quickDone === 'show'} fallback={<Gap size="sm" />}>
          <IconButton icon="done" size="sm" tone="good" label={t('shell-list.quick.done')} onClick={() => toggleDone(env.actions, props.k)} />
        </Show>
      </Show>
    </>
  );
}
