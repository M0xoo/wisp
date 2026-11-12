// Section (a titled group, with actions on the right of its title) and SettingsRow (a short
// title, one line saying what it does, and its control in a fixed right column; copy.md).
import { createUniqueId, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import type { HeadingLevel } from '../content/Text.tsx';
import { Heading } from '../content/Text.tsx';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface SectionProps extends KitProps, WithChildren {
  readonly title: string;
  readonly description?: JSX.Element;
  /** Buttons at the end of the title row. */
  readonly actions?: JSX.Element;
  readonly level?: HeadingLevel;
}

export function Section(props: SectionProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.section';
  const headingId = createUniqueId();
  return (
    <section id={props.id} aria-labelledby={headingId} data-kit="section" data-part={part()}>
      <div data-kit="section-head" data-part={sub(part(), 'head')}>
        <div data-kit="section-titles">
          <Heading level={props.level ?? 3} part={sub(part(), 'title')} id={headingId}>
            {props.title}
          </Heading>
          <Show when={props.description}>
            <p data-kit="section-description">{props.description}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div data-kit="section-actions" data-part={sub(part(), 'actions')}>
            {props.actions}
          </div>
        </Show>
      </div>
      <div data-kit="section-body" data-part={sub(part(), 'body')}>
        {props.children}
      </div>
    </section>
  );
}

export interface SettingsRowProps extends KitProps {
  readonly title: string;
  /** One line in the person's terms. */
  readonly description?: JSX.Element;
  /** A Switch, Select, Button…; none: the text takes the whole row (v1 .sx-ctl:empty) */
  readonly control?: JSX.Element;
  /** The control's id, so the title is its label. */
  readonly controlId?: string;
  /** A wide control (a Select, an Input) drops under the text on phones instead of squeezing it. */
  readonly wideControl?: boolean;
  /** a mark before the title: an image URL (a harness's logo, v1 Settings → Agents) */
  readonly logo?: string;
  /** a mark before the title from the icon set, where there is no logo (v1 GitHub, git) */
  readonly icon?: IconName;
  /** a 26px tile before the text, with an icon in it (v1 .cn-ico: Settings → Connectors) */
  readonly tile?: IconName;
  /** the title as the box's headline, 15px (v1 .wtr-total) */
  readonly big?: boolean;
}

export function SettingsRow(props: SettingsRowProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.settings-row';
  return (
    <div
      id={props.id}
      data-kit="settings-row"
      data-part={part()}
      data-wide={props.wideControl ? '' : undefined}
      data-layout={props.wideControl ? undefined : 'wrap'}
      data-tile={props.tile ? '' : undefined}
      data-bare={props.control === undefined ? '' : undefined}
      data-big={props.big ? '' : undefined}
    >
      <Show when={props.tile}>
        {(n) => (
          <span data-kit="settings-row-tile" aria-hidden="true">
            <Icon name={n()} size="sm" />
          </span>
        )}
      </Show>
      <div data-kit="settings-row-text">
        <Show
          when={props.controlId}
          fallback={
            <span data-kit="settings-row-title" data-text="control">
              <Show when={props.logo}>{(src) => <img data-kit="settings-row-logo" src={src()} alt="" />}</Show>
              <Show when={props.icon}>{(n) => <Icon name={n()} size="sm" />}</Show>
              {props.title}
            </span>
          }
        >
          {(forId) => (
            <label data-kit="settings-row-title" data-text="control" for={forId()}>
              <Show when={props.logo}>{(src) => <img data-kit="settings-row-logo" src={src()} alt="" />}</Show>
              <Show when={props.icon}>{(n) => <Icon name={n()} size="sm" />}</Show>
              {props.title}
            </label>
          )}
        </Show>
        <Show when={props.description}>
          <span data-kit="settings-row-description">{props.description}</span>
        </Show>
      </div>
      <Show when={props.control !== undefined}>
        <div data-kit="settings-row-control" data-part={sub(part(), 'control')}>
          {props.control}
        </div>
      </Show>
    </div>
  );
}
