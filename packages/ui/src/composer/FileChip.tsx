// FileChip: one attachment in a prompt (v1 .att): a thumbnail or a file icon, the name cut with …,
// the size, and × to take it out. Chips sit in a `Wrap` (design/layout.md §5: attachment chips may
// wrap as a group); the chip itself is control text and never wraps.
import { Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { IconButton } from '../controls/Button.tsx';

export type FileChipStatus = 'uploading' | 'ready' | 'failed' | 'held';

export interface FileChipProps extends KitProps {
  readonly name: string;
  /** "1.2 MB": never cut, it is the last thing to go. */
  readonly size?: string;
  /** An image preview (an object URL); otherwise `icon`. */
  readonly thumb?: string;
  readonly icon?: IconName;
  readonly status?: FileChipStatus;
  /** The full name and state, shown on hover ("photo.png · uploading"). */
  readonly title?: string;
  readonly onRemove?: () => void;
  readonly removeLabel: string;
}

export function FileChip(props: FileChipProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.file-chip';
  return (
    <span data-kit="file-chip" data-part={part()} data-status={props.status ?? 'ready'} title={props.title ?? props.name} aria-busy={props.status === 'uploading' ? true : undefined}>
      <Show when={props.thumb} fallback={<Icon name={props.status === 'uploading' ? 'clock' : (props.icon ?? 'file')} size="sm" />}>
        {(src) => <img data-kit="file-chip-thumb" src={src()} alt="" />}
      </Show>
      <span data-kit="file-chip-name" data-text="control">{props.name}</span>
      <Show when={props.size}>
        <span data-kit="file-chip-size" data-text="control">{props.size}</span>
      </Show>
      <Show when={props.onRemove}>
        <IconButton part={sub(part(), 'remove')} icon="x" size="xs" label={props.removeLabel} onClick={() => props.onRemove?.()} />
      </Show>
    </span>
  );
}

/** "512 B", "14 KB", "1.2 MB": a file size as v1's fmtSize wrote it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return mb < 1024 ? `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}
