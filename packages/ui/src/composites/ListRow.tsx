// ListRow: one row of a list (a task, a machine, a file). Every cell is always rendered in a fixed
// column, so selecting, opening or hovering a row moves nothing in it: the time sits in a
// fixed-width column and hover-only actions appear beside it, never on top of it (v1 #188, #209).
import { Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import type { ReorderAttrs } from '../core/reorder.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface ListRowProps extends KitProps {
  readonly title: string;
  /** A second line: where it lives, what it's doing. */
  readonly sub?: JSX.Element;
  /** An icon, avatar or status mark before the text. */
  readonly lead?: JSX.Element;
  /** feed layout: a last line across the whole row, under the sub and the pills (v1 .it-run, the run line) */
  readonly foot?: JSX.Element;
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
  /** The title in ink and 600 (v1 .item.unread / .st-waiting / .open .it-title): it wants you. Additive (2026-11-12). */
  readonly strong?: boolean;
  /** Opening the row. Without it (and without `href`) the row is static text. */
  readonly onOpen?: (e: MouseEvent) => void;
  /** Opening as a link, so middle-click and Copy link work. */
  readonly href?: string;
  readonly onContextMenu?: (e: MouseEvent) => void;
  /** `feed`: v1's task row (#feed .it-head): the time and the actions on the title's line, the pills on the
   *  line under it, beside the sub, so the title keeps the row's width. Default `line`: everything on one line. */
  readonly layout?: 'line' | 'feed';
  /** Dragging rows into your own order: `reorderable(list, id, ids, onReorder)` (v1 #772, the Projects list). */
  readonly reorder?: ReorderAttrs;
  /** More part names for the row's elements, so a list keeps another contract's names too (v1's `card`,
   *  `card.title`… that `qa/parity.mjs` measures): `{ row: 'card', title: 'card.title' }`. Additive (2026-11-12). */
  readonly also?: Partial<Readonly<Record<RowPiece, string>>> | undefined;
}

type RowPiece = 'row' | 'lead' | 'main' | 'title' | 'sub' | 'foot' | 'pills' | 'time' | 'actions';

/** The row's one click target: a button or link stretched over the row by CSS (::after). */
/** `list.row.title`, and the name `also` gives it. */
const named = (row: ListRowProps, part: PartName, piece: RowPiece): string => {
  const own = piece === 'row' ? part : sub(part, piece);
  const more = row.also?.[piece];
  return more ? `${own} ${more}` : own;
};

function Hit(props: { readonly row: ListRowProps; readonly part: PartName }): JSX.Element {
  const title = (): JSX.Element => (
    <span data-kit="list-row-title" data-text="control" data-part={named(props.row, props.part, 'title')} title={props.row.title}>
      {props.row.title}
    </span>
  );
  const current = (): 'page' | undefined => (props.row.current ? 'page' : undefined);
  const key = (e: KeyboardEvent, open: (e: MouseEvent) => void): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    open(new MouseEvent('click'));
  };
  const plain = (): JSX.Element => (
    <Show when={props.row.onOpen} fallback={<span data-kit="list-row-hit">{title()}</span>}>
      {(open) => (
        <Show
          when={props.row.layout === 'feed'}
          fallback={
            <button type="button" data-kit="list-row-hit" aria-current={current()} onClick={(e) => open()(e)}>
              {title()}
            </button>
          }
        >
          {/* v1 feed.js .it-head role="button": a feed row has no <button> in it (its quick actions neither) */}
          <div role="button" tabIndex={0} data-kit="list-row-hit" aria-current={current()} onClick={(e) => open()(e)} onKeyDown={(e) => key(e, open())}>
            {title()}
          </div>
        </Show>
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

/** A row's quick action (v1 .it-quick, .it-later): an icon that acts like a button, without being one inside the
 *  row (v1 kept a row's head the one button-like thing in it). Space and Enter press it; it never opens the row. */
export function RowButton(props: { readonly icon: IconName; readonly label: string; readonly tone?: 'good' | 'bad'; readonly pressed?: boolean; readonly part?: PartName; readonly onClick: () => void }): JSX.Element {
  const press = (e: Event): void => {
    e.stopPropagation();
    props.onClick();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      data-kit="icon-button"
      data-part={props.part ?? 'ui.row-button'}
      data-variant="ghost"
      data-size="sm"
      data-tone={props.tone}
      onClick={press}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        press(e);
      }}
    >
      <span data-kit="button-content">
        <Icon name={props.icon} size="md" />
      </span>
    </span>
  );
}

export function ListRow(props: ListRowProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.list-row';
  return (
    <div
      {...props.reorder}
      id={props.id}
      data-kit="list-row"
      data-part={named(props, part(), 'row')}
      aria-selected={props.selected === undefined ? undefined : props.selected}
      data-selected={flag(props.selected)}
      data-current={flag(props.current)}
      data-quiet={flag(props.quiet)}
      data-strong={flag(props.strong)}
      data-time={flag(props.time !== undefined)}
      data-layout={props.layout === 'feed' ? 'feed' : undefined}
      data-foot={flag(!!props.foot)}
      data-interactive={flag(props.onOpen !== undefined || props.href !== undefined)}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <div data-kit="list-row-lead" data-part={named(props, part(), 'lead')}>
        {props.lead}
      </div>
      <div data-kit="list-row-main" data-part={named(props, part(), 'main')}>
        <Hit row={props} part={part()} />
        <div data-kit="list-row-sub" data-part={named(props, part(), 'sub')}>
          {props.sub}
        </div>
      </div>
      <Show when={props.foot}>
        <div data-kit="list-row-foot" data-part={named(props, part(), 'foot')}>
          {props.foot}
        </div>
      </Show>
      <div data-kit="list-row-pills" data-part={named(props, part(), 'pills')}>
        {props.pills}
      </div>
      <div data-kit="list-row-time" data-part={named(props, part(), 'time')}>
        {props.time}
      </div>
      <div data-kit="list-row-actions" data-part={named(props, part(), 'actions')}>
        {props.actions}
      </div>
    </div>
  );
}
