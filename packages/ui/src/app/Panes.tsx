// Apps pinned on Home (v1 split.js .sh-panes and panes.js .pa): a "Panes" heading with the count, then, side by side,
// tiles in columns at least 300px wide (as many as fit, at most one each), 420px tall; stacked, a quiet row per pane
// that opens it as a page filling Home. A pane is a bar (its name, what it still asks for, Allow…, Reload, Unpin, and
// Back on its page) over its stage, where the owner puts the app's frame or a line saying why there's none.
import { For, Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { Button, IconButton } from '../controls/Button.tsx';

export interface HomePanesProps extends KitProps, WithChildren {
  readonly heading: string;
  readonly count: number;
  /** stacked (a phone, a narrow window): rows instead of tiles */
  readonly stacked: boolean;
  /** the rows, stacked (PaneRow each) */
  readonly rows?: JSX.Element;
  /** a pane opened as a page (stacked): it covers Home */
  readonly page?: boolean;
}

export function HomePanes(props: HomePanesProps): JSX.Element {
  const part = (): PartName => props.part ?? 'split.panes';
  return (
    <section data-kit="home-panes" data-part={part()} data-stacked={flag(props.stacked)} data-many={flag(!props.stacked && props.count > 1)}>
      <Show when={true}>
        <h4 data-kit="home-panes-head">
          {props.heading}
          <span data-kit="home-panes-n">{props.count}</span>
        </h4>
      </Show>
      <Show when={props.stacked}>
        <div data-kit="home-panes-rows" data-part={sub(part(), 'rows')}>
          {props.rows}
        </div>
      </Show>
      <div data-kit="home-panes-tiles" data-part={sub(part(), 'tiles')}>
        {props.children}
      </div>
    </section>
  );
}

export interface PaneRowProps extends KitProps {
  readonly name: string;
  /** what it still asks for ("Asks to read your tasks"), if anything */
  readonly need?: string | undefined;
  readonly onOpen: () => void;
}

/** Stacked: one pane's row, quiet like Needs you's above it; a tap opens it as a page. */
export function PaneRow(props: PaneRowProps): JSX.Element {
  return (
    <button type="button" data-kit="pane-row" data-part={props.part ?? 'split.panes.row'} onClick={() => props.onOpen()}>
      <span data-kit="pane-ic">
        <Icon name="app" size="sm" />
      </span>
      <span data-kit="pane-name" data-text="control">
        {props.name}
      </span>
      <Show when={props.need}>{(n) => <span data-kit="pane-need">{n()}</span>}</Show>
      <Icon name="chevron" size="sm" />
    </button>
  );
}

export interface PaneViewProps extends KitProps, WithChildren {
  readonly name: string;
  readonly need?: string | undefined;
  /** Allow… on the bar, while it still asks for something */
  readonly allow?: { readonly label: string; readonly onClick: (anchor: HTMLElement) => void } | undefined;
  readonly reload: { readonly label: string; readonly onClick: () => void };
  readonly unpin: { readonly label: string; readonly onClick: () => void };
  /** on its page (stacked): Back to Home */
  readonly back?: { readonly label: string; readonly onClick: () => void } | undefined;
  /** shown as a page (stacked), or hidden there until its row opens it */
  readonly open?: boolean;
  readonly hidden?: boolean;
}

/** A pane: its bar over its stage (the app's frame, or why there's none). */
export function PaneView(props: PaneViewProps): JSX.Element {
  return (
    <section data-kit="pane" data-part={props.part ?? 'ui.pane'} aria-label={props.name} data-open={flag(props.open)} hidden={props.hidden}>
      <div data-kit="pane-bar" data-part={sub(props.part ?? 'ui.pane', 'bar')}>
        <Show when={props.back}>{(b) => <IconButton icon="back" size="xs" label={b().label} onClick={() => b().onClick()} />}</Show>
        <span data-kit="pane-ic">
          <Icon name="app" size="sm" />
        </span>
        <b data-kit="pane-name" data-text="control">
          {props.name}
        </b>
        <Show when={props.need}>
          {(n) => (
            <span data-kit="pane-need" title={n()}>
              {n()}
            </span>
          )}
        </Show>
        <span data-kit="pane-grow" />
        <Show when={props.allow}>
          {(a) => {
            let el: HTMLElement | undefined;
            return (
              <span data-kit="pane-allow" ref={(x) => (el = x)}>
                <Button size="xs" variant="ghost" icon="lock" onClick={() => el && a().onClick(el)}>
                  {a().label}
                </Button>
              </span>
            );
          }}
        </Show>
        <IconButton icon="rerun" size="xs" label={props.reload.label} onClick={() => props.reload.onClick()} />
        <IconButton icon="x" size="xs" label={props.unpin.label} onClick={() => props.unpin.onClick()} />
      </div>
      <div data-kit="pane-stage">{props.children}</div>
    </section>
  );
}

/** Why a pane has no frame (v1 .pa-off): where it runs, or what went wrong. */
export function PaneOff(props: { readonly text: string; readonly tone?: 'info' | 'warn' }): JSX.Element {
  return (
    <p data-kit="pane-off">
      <Icon name={props.tone === 'warn' ? 'warn' : 'info'} size="sm" />
      {props.text}
    </p>
  );
}

/** Every pane's row, for HomePanes' `rows`. */
export function PaneRows<T>(props: { readonly each: readonly T[]; readonly children: (item: T) => JSX.Element }): JSX.Element {
  return <For each={props.each}>{(x) => props.children(x)}</For>;
}
