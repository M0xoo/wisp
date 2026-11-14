// Avatar: a picture, or initials on a soft fill when there is none (or it fails to load).
import { createSignal, Show, type JSX } from 'solid-js';
import type { ProjectColor, Tone } from '@wisp/tokens';
import type { KitProps } from '../core/props.ts';

export interface AvatarProps extends KitProps {
  /** Who it is: the accessible name, and the initials when there is no picture. */
  readonly name: string;
  readonly src?: string;
  readonly size?: 'sm' | 'md' | 'lg';
  /** The fill behind initials. */
  readonly color?: ProjectColor;
  /** A status dot at the corner. */
  readonly status?: Tone;
  readonly shape?: 'circle' | 'square';
}

/** Up to two initials: first and last word. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar(props: AvatarProps): JSX.Element {
  const [failed, setFailed] = createSignal(false);
  return (
    <span
      id={props.id}
      role="img"
      aria-label={props.name}
      title={props.name}
      data-kit="avatar"
      data-part={props.part ?? 'ui.avatar'}
      data-size={props.size ?? 'md'}
      data-shape={props.shape ?? 'circle'}
      style={props.color ? { '--k-avatar': `var(--${props.color})` } : undefined}
    >
      <Show when={props.src && !failed()} fallback={<span data-kit="avatar-initials" aria-hidden="true">{initials(props.name)}</span>}>
        <img src={props.src} alt="" data-kit="avatar-img" onError={() => setFailed(true)} />
      </Show>
      <Show when={props.status}>{(tone) => <span data-kit="avatar-status" data-tone={tone()} />}</Show>
    </span>
  );
}
