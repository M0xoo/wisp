// SettingsInset: a small bordered box inside a settings group, under the row it belongs to (v1 .sx-accts:
// a harness's accounts, each on its line, and "Add another … account" last). Its rows are 44px, 13px text.
import { Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export type SettingsInsetProps = KitProps & WithChildren;

export function SettingsInset(props: SettingsInsetProps): JSX.Element {
  return (
    <div id={props.id} data-kit="settings-inset" data-part={props.part ?? 'settings.inset'}>
      {props.children}
    </div>
  );
}

export interface SettingsInsetRowProps extends KitProps {
  readonly title: JSX.Element;
  /** its one line (an email, a plan) */
  readonly description?: JSX.Element;
  /** a state before the controls (At its limit, Signed out) */
  readonly state?: JSX.Element;
  readonly control?: JSX.Element;
}

/** One line in the box (v1 .sx-acct): the name and its line, then its state and controls. */
export function SettingsInsetRow(props: SettingsInsetRowProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.inset.row';
  return (
    <div id={props.id} data-kit="settings-inset-row" data-part={part()}>
      <span data-kit="settings-inset-text">
        <b data-text="control">{props.title}</b>
        <Show when={props.description}>
          <small>{props.description}</small>
        </Show>
      </span>
      <Show when={props.state}>
        <span data-kit="settings-inset-state" data-part={sub(part(), 'state')}>
          {props.state}
        </span>
      </Show>
      {props.control}
    </div>
  );
}

export interface SettingsInsetAddProps extends KitProps {
  readonly label: string;
  readonly onClick: () => void;
}

/** The last line of the box: a + and what it adds (v1 .sx-acct-add). */
export function SettingsInsetAdd(props: SettingsInsetAddProps): JSX.Element {
  return (
    <button type="button" id={props.id} data-kit="settings-inset-row" data-add="" data-part={props.part ?? 'settings.inset.add'} onClick={() => props.onClick()}>
      <Icon name="plus" size="sm" />
      <span data-text="control">{props.label}</span>
    </button>
  );
}
