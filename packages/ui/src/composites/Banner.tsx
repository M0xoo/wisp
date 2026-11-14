// Banner (a bar across a pane: *Reconnecting to wisp…*, an update) and Callout (a note inside
// content, v1's .b-callout). The tone tints the fill and the full 1px border; no side stripes.
import { Show, type JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { IconButton } from '../controls/Button.tsx';

export interface NoticeProps extends KitProps, WithChildren {
  readonly tone?: Tone;
  readonly icon?: IconName;
  readonly title?: string;
  /** One action: a Button. */
  readonly action?: JSX.Element;
  /** Shows ×; its name is the kit's "Dismiss". */
  readonly onDismiss?: () => void;
  readonly t?: Translate;
}

const DEFAULT_ICON: Readonly<Record<Tone, IconName>> = { neutral: 'info', accent: 'info', info: 'info', good: 'check', warn: 'warn', bad: 'warn' };

function Notice(props: NoticeProps & { readonly kit: 'banner' | 'callout'; readonly fallbackPart: PartName; readonly role?: 'status' | 'alert' }): JSX.Element {
  const t = useT(() => props.t);
  const part = (): PartName => props.part ?? props.fallbackPart;
  const tone = (): Tone => props.tone ?? 'info';
  return (
    <div id={props.id} role={props.role} data-kit={props.kit} data-part={part()} data-tone={tone()}>
      <span data-kit="notice-icon" data-part={sub(part(), 'icon')}>
        <Icon name={props.icon ?? DEFAULT_ICON[tone()]} size="md" />
      </span>
      <div data-kit="notice-text" data-part={sub(part(), 'text')}>
        <Show when={props.title}>{(title) => <p data-kit="notice-title">{title()}</p>}</Show>
        <Show when={props.children}>
          <div data-kit="notice-body">{props.children}</div>
        </Show>
      </div>
      <Show when={props.action}>
        <div data-kit="notice-action" data-part={sub(part(), 'action')}>{props.action}</div>
      </Show>
      <Show when={props.onDismiss}>
        {(dismiss) => <IconButton part={sub(part(), 'dismiss')} icon="x" size="xs" label={t('dismiss')} onClick={() => dismiss()()} />}
      </Show>
    </div>
  );
}

/** A status bar across a pane. Errors are announced at once (role=alert), the rest politely. */
export function Banner(props: NoticeProps): JSX.Element {
  return <Notice {...props} kit="banner" fallbackPart="ui.banner" role={props.tone === 'bad' ? 'alert' : 'status'} />;
}

/** A note inside content; part of the page, so it announces nothing. */
export function Callout(props: NoticeProps): JSX.Element {
  return <Notice {...props} kit="callout" fallbackPart="ui.callout" />;
}
