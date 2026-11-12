// SettingsNote: a line of small muted text under a group (v1 .modal .hint: 8px under it; 10px where v1 set it so,
// e.g. Cloud's and Connectors' notes; `inset` keeps 2px off the sides as Connectors' did).
import type { JSX } from 'solid-js';
import type { KitProps, WithChildren } from '../core/props.ts';

export interface SettingsNoteProps extends KitProps, WithChildren {
  /** the space above it: 8 (v1's default) or 10 */
  readonly after?: 8 | 10;
  readonly inset?: boolean;
  /** inside a group's box, as its own line (v1 .bg-empty: 12px 14px) */
  readonly boxed?: boolean;
}

export function SettingsNote(props: SettingsNoteProps): JSX.Element {
  return (
    <p
      id={props.id}
      data-kit="settings-note"
      data-part={props.part ?? 'settings.note'}
      data-after={props.after ?? 8}
      data-inset={props.inset ? '' : undefined}
      data-boxed={props.boxed ? '' : undefined}
    >
      {props.children}
    </p>
  );
}
