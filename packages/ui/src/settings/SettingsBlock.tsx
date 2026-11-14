// SettingsBlock: a titled block inside a settings group's box, its title and lede on top and what it holds under
// them (v1 .cg-signin: Sign in to a wisp Grid, the line, then the address and Sign in). 14px in, 10px apart.
import { Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';

export interface SettingsBlockProps extends KitProps, WithChildren {
  readonly title: string;
  readonly description?: JSX.Element;
}

export function SettingsBlock(props: SettingsBlockProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.block';
  return (
    <div id={props.id} data-kit="settings-block" data-part={part()}>
      <p data-kit="settings-block-head" data-part={sub(part(), 'head')}>
        <b data-text="control">{props.title}</b>
        <Show when={props.description}>
          <small>{props.description}</small>
        </Show>
      </p>
      {props.children}
    </div>
  );
}
