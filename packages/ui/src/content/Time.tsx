// Time: a <time> element in a fixed-width column with tabular figures, so a list's times line up
// and don't wiggle as they tick. The clock comes from outside (`now`), so the kit runs no timers.
import { type JSX } from 'solid-js';
import { flag, type KitProps } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { timeLabel, timeTitle, toMs } from './time-format.ts';

export interface TimeProps extends KitProps {
  readonly at: number | Date | string;
  /** The current time in ms; pass a ticking signal's value to keep it fresh. Defaults to render time. */
  readonly now?: number;
  /** column: fixed width, right-aligned (lists). inline: sits in a sentence. */
  readonly layout?: 'column' | 'inline';
  readonly locale?: string;
  readonly t?: Translate;
}

export function Time(props: TimeProps): JSX.Element {
  const t = useT(() => props.t);
  const at = (): number => toMs(props.at);
  const now = (): number => props.now ?? Date.now();
  return (
    <time
      id={props.id}
      datetime={Number.isFinite(at()) ? new Date(at()).toISOString() : undefined}
      title={Number.isFinite(at()) ? timeTitle(at(), now(), t, props.locale) : undefined}
      data-kit="time"
      data-text="control"
      data-part={props.part ?? 'ui.time'}
      data-column={flag((props.layout ?? 'column') === 'column')}
    >
      {Number.isFinite(at()) ? timeLabel(at(), now(), t, props.locale) : ''}
    </time>
  );
}
