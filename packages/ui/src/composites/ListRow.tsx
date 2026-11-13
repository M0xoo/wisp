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
  /** the sub line's tone (feed: v1 .q-live running in accent ink, waiting in warn) and its tooltip. Additive (2026-11-12). */
  readonly subTone?: 'accent-ink' | 'warn' | 'muted' | undefined;
  readonly subTitle?: string | undefined;
  /** feed: how many quick actions the row has (0–2): the title makes room for them while they show. Additive (2026-11-12). */
  readonly quick?: 0 | 1 | 2 | undefined;
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

/** A row's quick action (v1 .it-quick, .it-later): an icon the pointer presses, hidden from assistive tech and the
 *  Tab order as v1's are (the row's head is the one button in it; the keys E and L do the same from the keyboard).
 *  It never opens the row. v1's element tree: the box, the glyph, its path. */
export function RowButton(props: { readonly icon: IconName; readonly label: string; readonly tone?: 'good' | 'bad'; readonly pressed?: boolean; readonly part?: PartName; readonly onClick: () => void }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      title={props.label}
      data-kit="icon-button"
      data-part={props.part ?? 'ui.row-button'}
      data-variant="ghost"
      data-size="sm"
      data-tone={props.tone}
      data-on={flag(props.pressed)}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <Icon name={props.icon} size="md" />
    </span>
  );
}

/** v1 feed.js runLine(): the harness's logo and name (and its model), then where it runs after a `·`. */
export function RowRun(props: {
  readonly logo?: JSX.Element;
  readonly name: string;
  /** v1 .ir-m: the model in its own span, so a long one ellipsises before the place does */
  readonly model?: string | undefined;
  /** v1 .it-run[title]: harness · model · effort · place, on the whole line */
  readonly title?: string | undefined;
  readonly where: { readonly icon: IconName; readonly text: string };
  readonly part?: PartName;
}): JSX.Element {
  return (
    <div data-kit="row-run" data-part={props.part ?? 'ui.row-run'} title={props.title}>
      {props.logo}
      <span data-kit="ir-h">{props.name}</span>
      <Show when={props.model}>{(m) => <span data-kit="ir-m">{m()}</span>}</Show>
      <span data-kit="ir-w">
        <Icon name={props.where.icon} size="xs" />
        <span>{props.where.text}</span>
      </span>
    </div>
  );
}

/** v1 #feed .it-head, element for element (qa/parity.mjs compares a hovered row's tree by index): the head is the
 *  row's one button; in it the dot, the title, the sub's words, the run line, the pills with the time last, then the
 *  quick actions. */
function FeedRow(props: ListRowProps & { readonly partName: PartName }): JSX.Element {
  const p = (): PartName => props.partName;
  const open = (e: MouseEvent): void => props.onOpen?.(e);
  return (
    <div
      {...props.reorder}
      id={props.id}
      role="button"
      tabIndex={0}
      aria-current={props.current ? 'page' : undefined}
      data-kit="list-row"
      data-part={named(props, p(), 'row')}
      data-selected={flag(props.selected)}
      data-current={flag(props.current)}
      data-quiet={flag(props.quiet)}
      data-strong={flag(props.strong)}
      data-time={flag(props.time !== undefined)}
      data-layout="feed"
      data-quick={props.quick ? String(props.quick) : undefined}
      data-foot={flag(!!props.foot)}
      data-interactive={flag(props.onOpen !== undefined)}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open(new MouseEvent('click'));
      }}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      {props.lead}
      <span data-kit="list-row-title" data-text="control" data-part={named(props, p(), 'title')} title={props.title}>
        {props.title}
      </span>
      <div data-kit="list-row-sub" data-part={named(props, p(), 'sub')} data-tone={props.subTone} title={props.subTitle}>
        {props.sub}
      </div>
      {props.foot}
      <div data-kit="list-row-pills" data-part={named(props, p(), 'pills')}>
        {props.pills}
        {props.time}
      </div>
      {props.actions}
    </div>
  );
}

export function ListRow(props: ListRowProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.list-row';
  if (props.layout === 'feed') return <FeedRow {...props} partName={part()} />;
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
