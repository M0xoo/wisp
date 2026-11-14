// SettingsItem: one thing in a settings list with fixed columns (v1 .wtr-row, Settings → Worktrees): who it is and
// its line, a state (warn when it holds work), a size, then its buttons. The columns never move whatever they say.
import { Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';

export interface SettingsItemProps extends KitProps {
  readonly title: string;
  readonly sub?: string;
  /** set: the title is a link that opens it */
  readonly onOpen?: () => void;
  readonly mono?: boolean;
  readonly state?: string;
  readonly warn?: boolean;
  readonly size?: string;
  readonly actions?: JSX.Element;
}

export function SettingsItem(props: SettingsItemProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.item-row';
  return (
    <div id={props.id} data-kit="settings-item" data-part={part()}>
      <span data-kit="settings-item-who">
        <Show
          when={props.onOpen}
          fallback={
            <b data-text="control" data-mono={props.mono ? '' : undefined} title={props.title}>
              {props.title}
            </b>
          }
        >
          {(open) => (
            <button type="button" data-kit="settings-item-name" data-text="control" title={props.title} onClick={() => open()()}>
              {props.title}
            </button>
          )}
        </Show>
        <small title={props.sub}>{props.sub}</small>
      </span>
      <small data-kit="settings-item-state" data-part={sub(part(), 'state')} data-warn={props.warn ? '' : undefined}>
        {props.state}
      </small>
      <small data-kit="settings-item-size">{props.size}</small>
      <span data-kit="settings-item-acts">{props.actions}</span>
    </div>
  );
}
