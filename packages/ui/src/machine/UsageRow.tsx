// UsageRow: a row of a resource table (This Mac's What's using it, Left behind, Free up space): who,
// with a line under it, then numbers in fixed-width tabular columns (RAM, CPU, Folder), then the
// row's actions. The columns never move when a number grows or a row is stopped (design/layout.md
// §4). In a narrow box the numbers drop to a second line, each with its label, by container query.
// `UsageHead` labels the columns once, above the rows.
import { For, Show, type JSX } from 'solid-js';
import { sub, flag, type KitProps, type PartName } from '../core/props.ts';
import { Skeleton } from '../content/Skeleton.tsx';

export interface UsageCell {
  /** the column's name: shown in the head, and beside the number when stacked */
  readonly label: string;
  readonly value: string;
}

export interface UsageRowProps extends KitProps {
  readonly title: string;
  /** opens what the row is (a task): the title becomes a button */
  readonly onOpen?: () => void;
  readonly sub?: string;
  readonly mono?: boolean;
  readonly cells: readonly UsageCell[];
  readonly actions?: JSX.Element;
  /** acted on and waiting for the peer: dimmed, actions stay where they are */
  readonly busy?: boolean;
}

export function UsageRow(props: UsageRowProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.usage-row';
  const title = (): JSX.Element => (
    <span data-kit="usage-title" data-text="control" data-mono={flag(props.mono)} title={props.title}>
      {props.title}
    </span>
  );
  return (
    <div id={props.id} data-kit="usage-row" data-part={part()} data-cols={props.cells.length} data-busy={flag(props.busy)}>
      <div data-kit="usage-who">
        <Show when={props.onOpen} fallback={title()}>
          {(open) => (
            <button type="button" data-kit="usage-open" onClick={() => open()()}>
              {title()}
            </button>
          )}
        </Show>
        <Show when={props.sub}>
          <small data-kit="usage-sub" data-text="control" title={props.sub}>
            {props.sub}
          </small>
        </Show>
      </div>
      <For each={props.cells}>
        {(c) => (
          <span data-kit="usage-cell" data-label={c.label}>
            {c.value}
          </span>
        )}
      </For>
      <div data-kit="usage-actions" data-part={sub(part(), 'actions')}>
        {props.actions}
      </div>
    </div>
  );
}

export interface UsageHeadProps extends KitProps {
  readonly labels: readonly string[];
}

/** The column labels, aligned over the cells of the rows below. */
export function UsageHead(props: UsageHeadProps): JSX.Element {
  return (
    <div id={props.id} data-kit="usage-row" data-head="" data-part={props.part ?? 'ui.usage-head'} data-cols={props.labels.length} aria-hidden="true">
      <div data-kit="usage-who" />
      <For each={props.labels}>{(l) => <span data-kit="usage-cell">{l}</span>}</For>
      <div data-kit="usage-actions" />
    </div>
  );
}

/** A placeholder row of the real shape while nothing has been read yet. */
export function UsageSkeleton(props: { readonly cols: number; readonly part?: PartName }): JSX.Element {
  return (
    <div data-kit="usage-row" data-part={props.part ?? 'ui.usage-row'} data-cols={props.cols} aria-hidden="true">
      <div data-kit="usage-who">
        <Skeleton width="2/3" />
        <Skeleton width="1/3" />
      </div>
      <For each={Array.from({ length: props.cols })}>
        {() => (
          <span data-kit="usage-cell">
            <Skeleton width="full" />
          </span>
        )}
      </For>
      <div data-kit="usage-actions">
        <Skeleton shape="pill" width="control-lg" />
      </div>
    </div>
  );
}

/** The box rows sit in: its width (not the window's) decides when the numbers stack. */
export function UsageList(props: KitProps & { readonly children?: JSX.Element }): JSX.Element {
  return (
    <div id={props.id} data-kit="usage-list" data-part={props.part ?? 'ui.usage-list'}>
      {props.children}
    </div>
  );
}
