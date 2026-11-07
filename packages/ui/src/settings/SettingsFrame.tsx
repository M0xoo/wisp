// SettingsFrame: Settings as every app has it (v1 web/js/features/settings.js): a sidebar of panes
// and one pane at a time. Narrower than 640px of its own width (a container query, so it works in
// a sheet, a split or a phone), it shows the list first and a pane over it, with Back.
import { For, Show, createEffect, on, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { IconButton } from '../controls/Button.tsx';

export interface SettingsNavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** A dot after the label: something in the pane needs a look (an agent not found). */
  readonly alert?: 'bad' | 'warn';
  /** What the dot means, for its tooltip and readers. */
  readonly alertLabel?: string;
}

export interface SettingsNavGroup {
  readonly id: string;
  /** Omit for the first group. */
  readonly label?: string;
  readonly items: readonly SettingsNavItem[];
}

export interface SettingsFrameProps extends KitProps, WithChildren {
  /** "Settings" */
  readonly title: string;
  readonly groups: readonly SettingsNavGroup[];
  readonly current: string;
  readonly onPick: (id: string) => void;
  /** The open pane's title and its one-line lede. */
  readonly paneTitle: string;
  readonly lede?: JSX.Element;
  /** Narrow: the list or the pane. Wide frames show both and ignore it. */
  readonly view: 'list' | 'pane';
  /** Narrow: Back to the list. */
  readonly onUp: () => void;
  readonly upLabel: string;
  readonly onClose?: () => void;
  readonly closeLabel: string;
  /** Above the list: a search field. */
  readonly search?: JSX.Element;
  /** Keys on the whole frame (Escape closes it). */
  readonly onKeyDown?: (e: KeyboardEvent) => void;
}

function NavItems(props: { readonly frame: SettingsFrameProps; readonly part: PartName }): JSX.Element {
  const ids = (): string[] => props.frame.groups.flatMap((g) => g.items.map((i) => i.id));
  // Up and Down walk the panes, as in v1 (and every OS's settings)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = ids();
    const at = all.indexOf(props.frame.current);
    const next = all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
    if (next === undefined) return;
    e.preventDefault();
    props.frame.onPick(next);
    const nav = e.currentTarget as HTMLElement;
    nav.querySelector<HTMLElement>(`[data-pane="${CSS.escape(next)}"]`)?.focus();
  };
  return (
    <div data-kit="settings-nav-list" onKeyDown={onKey}>
      <For each={props.frame.groups}>
        {(g) => (
          <div data-kit="settings-nav-group" data-part={sub(props.part, 'group')} data-group={g.id}>
            <Show when={g.label}>{(l) => <span data-kit="settings-nav-group-label" data-text="control">{l()}</span>}</Show>
            <For each={g.items}>
              {(item) => (
                <button
                  type="button"
                  data-kit="settings-nav-item"
                  data-part={sub(props.part, 'item')}
                  data-pane={item.id}
                  aria-current={props.frame.current === item.id ? 'page' : undefined}
                  data-current={flag(props.frame.current === item.id)}
                  onClick={() => props.frame.onPick(item.id)}
                >
                  <Icon name={item.icon} size="md" />
                  <span data-kit="settings-nav-label" data-text="control">{item.label}</span>
                  <Show when={item.alert}>
                    {(tone) => <span data-kit="settings-nav-alert" data-tone={tone()} role="img" aria-label={item.alertLabel} title={item.alertLabel} />}
                  </Show>
                  <span data-kit="settings-nav-chevron"><Icon name="chevron" size="sm" /></span>
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

export function SettingsFrame(props: SettingsFrameProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.frame';
  const refs: { body?: HTMLDivElement } = {};
  // a new pane starts at its top, not where the last one was scrolled to
  createEffect(on(() => props.current, () => {
    if (refs.body) refs.body.scrollTop = 0;
  }, { defer: true }));
  return (
    <div id={props.id} data-kit="settings-frame" data-part={part()} data-view={props.view} onKeyDown={(e) => props.onKeyDown?.(e)}>
      <div data-kit="settings-frame-grid">
        <nav data-kit="settings-nav" data-part={sub(part(), 'nav')} aria-label={props.title}>
          <div data-kit="settings-nav-head" data-part={sub(part(), 'nav-head')}>
            <h2 data-kit="settings-nav-title" data-text="control">{props.title}</h2>
            <Show when={props.onClose}>
              {(close) => (
                <span data-kit="settings-nav-close">
                  <IconButton icon="x" label={props.closeLabel} onClick={() => close()()} />
                </span>
              )}
            </Show>
          </div>
          <Show when={props.search}>
            <div data-kit="settings-nav-search">{props.search}</div>
          </Show>
          <NavItems frame={props} part={part()} />
        </nav>
        <div data-kit="settings-main" data-part={sub(part(), 'main')}>
          <header data-kit="bar" data-part={sub(part(), 'head')}>
            <span data-kit="settings-up">
              <IconButton icon="back" label={props.upLabel} onClick={() => props.onUp()} />
            </span>
            <h2 data-kit="settings-pane-title" data-text="control">{props.paneTitle}</h2>
            <Show when={props.onClose}>
              {(close) => <IconButton icon="x" label={props.closeLabel} onClick={() => close()()} />}
            </Show>
          </header>
          <div data-kit="settings-body" data-part={sub(part(), 'body')} ref={(el) => (refs.body = el)}>
            <div data-kit="settings-pane">
              <Show when={props.lede}>
                <p data-kit="settings-lede">{props.lede}</p>
              </Show>
              {props.children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
