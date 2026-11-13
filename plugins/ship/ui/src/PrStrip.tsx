// The PR row on the open task (v1 ship.js renderPrStrip, design/side-panel.md "Opening it"): the PR
// in its tone, its one line, and a bar of what to do next, Merge (or Fix conflicts) pinned at the
// end. Clicking the row opens the side panel on PR. While a ship is in flight it shows the stages
// instead; while the PR pane is open beside the task it hides, so the verdict never shows twice.

import { Match, Show, Switch, createEffect, type JSX } from 'solid-js';
import { CommandError, readonly, type EntityKey, type PluginClient } from '@wisp/client';
import { mergeRequest } from './merge-request.ts';
import type { ExtensionProps } from '@wisp/shell/contract';
import { Button, Card, Icon, IconButton, ListRow, Stack, Toolbar, ToneChip, useSignal, type ToolbarItem } from '@wisp/ui';
import { fixConflicts, refresh, review } from './commands.ts';
import { t } from './i18n.ts';
import { useMerge } from './MergeConfirm.tsx';
import { fixing, openPrs, prLine, prsOf, prTone, worstTone, type PrTone } from './model/pr.ts';
import { REVIEW_ICON, reviewActs, reviewState } from './model/review.ts';
import { stepsOfLive, track } from './model/ship.ts';
import { ShipRun } from './ShipRun.tsx';
import { TONE, TONE_ICON } from './tones.ts';
import { useBusy } from './busy.ts';
import { openShip, useReviewCtx, useSession, useShip } from './use.ts';
import type { ShipSession } from './types.ts';

export default function PrStrip(props: ExtensionProps): JSX.Element {
  const key = (): EntityKey | undefined => (props.id ?? props.session?.()?.id) as EntityKey | undefined;
  return (
    <Show when={key()} keyed>
      {(k) => <Strip client={props.client} k={k} />}
    </Show>
  );
}

/** Commands whose refusal the shell already toasts: the caller only stops waiting. */
export const quiet = (p: Promise<unknown>): void =>
  void p.catch((err: unknown) => {
    if (!(err instanceof CommandError)) throw err;
  });

function Strip(props: { readonly client: PluginClient; readonly k: EntityKey }): JSX.Element {
  const s = useSession(props.client, () => props.k);
  const ship = useShip(props.client, props.k);
  const run = useSignal(ship.flows.run);
  const nav = (): ReturnType<typeof ship.shell.nav> => ship.shell.nav();
  const paneOpen = (): boolean => nav().side.kind === 'pr' && (nav().side as { id?: string }).id === props.k;
  // Started here, or elsewhere (another tab, the API): the server's stage moves the track along.
  const live = (): ReturnType<typeof track> | undefined => {
    const r = run();
    const sh = s()?.shipping;
    if (r) return track(t, r.steps, r.error === undefined ? sh : undefined, r.error);
    return sh ? track(t, stepsOfLive(sh), sh, undefined) : undefined;
  };
  return (
    <Show when={!paneOpen()}>
      <Switch>
        <Match when={live()}>{(tr) => <ShipRun track={tr()} onRetry={() => openShip(props.client, ship.shell, props.k, s())} onDismiss={() => ship.flows.dismiss()} />}</Match>
        <Match when={prsOf(s()).length > 0 && s()}>{(row) => <PrRow client={props.client} k={props.k} s={row()} />}</Match>
      </Switch>
    </Show>
  );
}

// size-ok: the row's bar is one list of items, each with its own condition from v1
function PrRow(props: { readonly client: PluginClient; readonly k: EntityKey; readonly s: ShipSession }): JSX.Element {
  const ship = useShip(props.client, props.k);
  const ctx = useReviewCtx(props.client, () => props.s);
  const merge = useMerge(ship.flows, () => props.s, ctx, ship.shell);
  // Merge PR #n… from a task's menu: asked here, with this strip's confirm
  const asked = useSignal(readonly(mergeRequest));
  createEffect(() => {
    if (asked() !== props.k) return;
    mergeRequest(undefined);
    merge.ask();
  });
  const checking = useBusy();
  const prs = () => prsOf(props.s);
  const lead = () => prs()[0];
  const several = (): boolean => prs().length > 1;
  const fix = () => (props.s.pr ? props.s.conflictFix : undefined); // wisp fixes conflicts on the task's own PR only
  const tone = (): PrTone => worstTone(prs().map((x, i) => prTone(x.pr, i ? undefined : fix())));
  const open = () => openPrs(props.s);
  const rv = () => (props.s.pr?.state === 'OPEN' ? reviewState(t, props.s, ctx()) : undefined);
  const title = (): string => {
    const x = lead();
    return !x ? '' : several() ? `${x.repo ?? ''} #${x.pr.number}` : t('wisp.ship.tab.one', { n: x.pr.number });
  };
  const items = (): ToolbarItem[] => {
    const out: ToolbarItem[] = [];
    const x = lead();
    if (!x) return out;
    if (open().length) {
      const check = (): void => void checking.run(props.client.run(refresh, { key: props.k }));
      // icon-only in both forms: the ring replaces the icon while it checks, the width holds
      out.push({
        id: 'refresh',
        icon: 'replay',
        label: t('wisp.ship.strip.checkTitle'),
        priority: 1,
        onSelect: check,
        render: () => <IconButton icon="replay" size="sm" label={t('wisp.ship.strip.checkTitle')} loading={checking.busy()} onClick={check} part="pr.strip.check" />,
      });
    }
    if (!several()) out.push({ id: 'github', icon: 'external', label: t('wisp.ship.strip.github'), priority: 2, onSelect: () => ship.shell.platform.openExternal(x.pr.url) });
    if (x.pr.state === 'OPEN' && x.pr.conflict && props.s.pr && !fixing(fix()) && props.s.state !== 'running') {
      out.push({ id: 'fix', icon: 'merge', label: t('wisp.ship.action.fix'), priority: 'pin', onSelect: () => quiet(props.client.run(fixConflicts, { key: props.k })) });
    }
    const v = rv();
    if (v)
      out.push({
        id: 'review',
        icon: REVIEW_ICON[v.kind],
        label: v.label,
        priority: 3,
        ...(v.kind === 'tests' || v.kind === 'issues' ? { tone: 'bad' as const } : {}),
        onSelect: () => (reviewActs(v.kind) ? quiet(props.client.run(review, { key: props.k })) : ship.openPane()),
      });
    if (open().length && !open().some((o) => o.pr.conflict)) {
      const label = open().length > 1 ? t('wisp.ship.strip.mergeAll') : t('wisp.ship.strip.merge');
      out.push({ id: 'merge', icon: 'check', label, priority: 'pin', render: (form) => <MergeButton label={label} form={form} busy={merge.merging()} onClick={merge.ask} /> });
    }
    return out;
  };
  return (
    <Card part="pr.strip" tone={TONE[tone()]} pad="3">
      <Stack gap="1">
        <ListRow
          part="pr.strip.row"
          title={title()}
          sub={prLine(t, lead()?.pr ?? { number: 0, url: '', state: 'OPEN' }, fix())}
          lead={<Icon name={TONE_ICON[tone()]} size="md" tone={TONE[tone()] === 'accent' ? 'accent-ink' : TONE[tone()]} />}
          pills={
            <Show when={several()}>
              {prs()
                .slice(1)
                .map((o) => (
                  <ToneChip
                    label={`${o.repo ?? ''} #${o.pr.number}`}
                    tone={TONE[prTone(o.pr)]}
                    title={`${o.repo ?? ''}: ${t('wisp.ship.pill.title', { n: o.pr.number, line: prLine(t, o.pr) })}`}
                    onClick={() => ship.shell.platform.openExternal(o.pr.url)}
                  />
                ))}
            </Show>
          }
          actions={<Icon name="chevron" size="sm" tone="faint" />}
          onOpen={() => ship.openPane()}
        />
        <Toolbar aria-label={t('wisp.ship.strip.actions')} items={items()} compact part="pr.strip.bar" />
      </Stack>
      <merge.Confirm />
    </Card>
  );
}

function MergeButton(props: { readonly label: string; readonly form: 'full' | 'icon'; readonly busy: boolean; readonly onClick: () => void }): JSX.Element {
  return (
    <Show when={props.form === 'full'} fallback={<IconButton icon="check" size="sm" label={props.label} loading={props.busy} onClick={() => props.onClick()} part="pr.strip.merge" />}>
      <Button variant="ghost" size="sm" icon="check" loading={props.busy} onClick={() => props.onClick()} part="pr.strip.merge">
        {props.label}
      </Button>
    </Show>
  );
}
