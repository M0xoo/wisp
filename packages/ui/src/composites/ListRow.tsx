// ListRow: one row of a list (a task, a machine, a file). Every cell is always rendered in a fixed
// column, so selecting, opening or hovering a row moves nothing in it: the time sits in a
// fixed-width column and hover-only actions appear beside it, never on top of it (v1 #188, #209).
import { Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';

export interface ListRowProps extends KitProps {
  readonly title: string;
  /** A second line: where it lives, what it's doing. */
  readonly sub?: JSX.Element;
  /** An icon, avatar or status mark before the text. */
  readonly lead?: JSX.Element;
  /** Pills after the text, in their own column. */
  readonly pills?: JSX.Element;
  /** Usually a <Time>; its column is fixed-width. */
  readonly time?: JSX.Element;
  /** Buttons beside the time: on hover and focus on desktop, always on touch. */
  readonly actions?: JSX.Element;
  /** The row is picked (selection, keyboard cursor). */
  readonly selected?: boolean;
  /** The row is what's open (aria-current). */
  readonly current?: boolean;
  /** A quieter title, for a finished row that must still read (ink-2, design/ui.md). */
  readonly quiet?: boolean;
  /** Opening the row. Without it (and without `href`) the row is static text. */
  readonly onOpen?: (e: MouseEvent) => void;
  /** Opening as a link, so middle-click and Copy link work. */
  readonly href?: string;
  readonly onContextMenu?: (e: MouseEvent) => void;
}

/** The row's one click target: a button or link stretched over the row by CSS (::after). */
function Hit(props: { readonly row: ListRowProps; readonly part: PartName }): JSX.Element {
  const title = (): JSX.Element => (
    <span data-kit="list-row-title" data-part={sub(props.part, 'title')} title={props.row.title}>
      {props.row.title}
    </span>
  );
  const current = (): 'page' | undefined => (props.row.current ? 'page' : undefined);
  const plain = (): JSX.Element => (
    <Show when={props.row.onOpen} fallback={<span data-kit="list-row-hit">{title()}</span>}>
      {(open) => (
        <button type="button" data-kit="list-row-hit" aria-current={current()} onClick={(e) => open()(e)}>
          {title()}
        </button>
      )}
    </Show>
  );
  return (
    <Show when={props.row.href} fallback={plain()}>
      {(href) => (
        <a href={href()} data-kit="list-row-hit" aria-current={current()} onClick={(e) => props.row.onOpen?.(e)}>
          {title()}
        </a>
      )}
    </Show>
  );
}

export function ListRow(props: ListRowProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.list-row';
  return (
    <div
      id={props.id}
      data-kit="list-row"
      data-part={part()}
      aria-selected={props.selected === undefined ? undefined : props.selected}
      data-selected={flag(props.selected)}
      data-current={flag(props.current)}
      data-quiet={flag(props.quiet)}
      data-time={flag(props.time !== undefined)}
      data-interactive={flag(props.onOpen !== undefined || props.href !== undefined)}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <div data-kit="list-row-lead" data-part={sub(part(), 'lead')}>{props.lead}</div>
      <div data-kit="list-row-main" data-part={sub(part(), 'main')}>
        <Hit row={props} part={part()} />
        <div data-kit="list-row-sub" data-part={sub(part(), 'sub')}>{props.sub}</div>
      </div>
      <div data-kit="list-row-pills" data-part={sub(part(), 'pills')}>{props.pills}</div>
      <div data-kit="list-row-time" data-part={sub(part(), 'time')}>{props.time}</div>
      <div data-kit="list-row-actions" data-part={sub(part(), 'actions')}>{props.actions}</div>
    </div>
  );
}
