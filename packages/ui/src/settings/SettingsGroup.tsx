// SettingsGroup: rows that belong together, in one bordered box (v1 .sx-group), with an optional
// head above it (v1 .sx-head: a title, one line, and buttons on the right).
import { Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';

export interface SettingsGroupProps extends KitProps, WithChildren {
  readonly title?: string;
  readonly description?: JSX.Element;
  readonly actions?: JSX.Element;
}

export function SettingsGroup(props: SettingsGroupProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.group';
  return (
    <section id={props.id} data-kit="settings-group" data-part={part()}>
      <Show when={props.title !== undefined || props.actions !== undefined}>
        <div data-kit="settings-group-head" data-part={sub(part(), 'head')}>
          <div data-kit="settings-group-titles">
            <Show when={props.title}>{(t) => <h3 data-kit="settings-group-title" data-text="control">{t()}</h3>}</Show>
            <Show when={props.description}>
              <p data-kit="settings-group-description">{props.description}</p>
            </Show>
          </div>
          <Show when={props.actions}>
            <div data-kit="settings-group-actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      <div data-kit="settings-group-body" data-part={sub(part(), 'body')}>{props.children}</div>
    </section>
  );
}
