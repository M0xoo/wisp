// A task's usage in its details column (v1 #785, TRY-16; web/js/features/budget.js planLine and usageMenu, split.css
// .plan-used, subagents.css .plan-menu): a line with its share of the plan (its subagents' in; with none traced, its
// tokens), a line with a ring that fills as its context does (amber past 80%), and either opens the whole of it:
// sections of label · number rows, a subagent's row opening it, and Settings → Usage last. Shown in the wide pane only.
import * as popover from '@zag-js/popover';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { For, Show, createMemo, createUniqueId, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from '../content/Icon.tsx';
import type { PartName } from '../core/props.ts';

export interface TaskUsageRow {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
  /** a subagent's row: opens it */
  readonly onOpen?: () => void;
  /** a meter under the row (the context): 0–1, amber when `hi` */
  readonly bar?: { readonly share: number; readonly hi: boolean };
}

export interface TaskUsageSection {
  readonly title: string;
  readonly rows: readonly TaskUsageRow[];
}

export interface TaskUsageProps {
  /** "6% of weekly · 21% of 5-hour", or "1.2M tokens" */
  readonly plan?: { readonly text: string; readonly title: string };
  /** "62% context" with its ring (share 0–1, or none when the window isn't known) */
  readonly context?: { readonly text: string; readonly title: string; readonly share?: number; readonly hi: boolean };
  /** what the card says; read when it opens */
  readonly sections: () => readonly TaskUsageSection[];
  /** the card's name ("Task usage") */
  readonly label: string;
  /** its last row: Settings → Usage */
  readonly more: { readonly label: string; readonly onClick: () => void };
}

/** One label · number row, a meter under it when it has one; a subagent's row is a button that opens it. */
function UsageRowView(props: { readonly row: TaskUsageRow; readonly section: string; readonly close: () => void }): JSX.Element {
  const r = (): TaskUsageRow => props.row;
  return (
    <>
      <Show
        when={r().onOpen}
        fallback={
          <div data-kit="pu-row" title={r().title}>
            <span>{r().label}</span>
            <b>{r().value}</b>
          </div>
        }
      >
        {(open) => (
          <button
            type="button"
            data-kit="pu-row"
            data-part="split.usage.sub"
            title={r().title}
            onClick={() => {
              props.close();
              open()();
            }}
          >
            <span>{r().label}</span>
            <b>{r().value}</b>
          </button>
        )}
      </Show>
      <Show when={r().bar}>
        {(b) => {
          const share = (): number => Math.min(1, Math.max(0, b().share));
          return (
            <div data-kit="pu-bar" data-hi={b().hi ? '' : undefined} role="meter" aria-label={props.section} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share() * 100)} style={{ '--pu': `${(share() * 100).toFixed(1)}%` }}>
              <i />
            </div>
          );
        }}
      </Show>
    </>
  );
}

/** The card's sections (read when it opens), then Settings → Usage. */
function UsageCard(props: { readonly card: TaskUsageProps; readonly close: () => void }): JSX.Element {
  return (
    <>
      <For each={props.card.sections().filter((s) => s.rows.length > 0)}>
        {(s) => (
          <div data-kit="pu-sec">
            <h5>{s.title}</h5>
            <For each={s.rows}>{(r) => <UsageRowView row={r} section={s.title} close={props.close} />}</For>
          </div>
        )}
      </For>
      <button
        type="button"
        data-kit="pu-more"
        data-part="split.usage.more"
        onClick={() => {
          props.close();
          props.card.more.onClick();
        }}
      >
        <Icon name="stats" />
        <span>{props.card.more.label}</span>
      </button>
    </>
  );
}

function UsageLine(props: { readonly lead: JSX.Element; readonly text: string; readonly title: string; readonly part: PartName; readonly card: TaskUsageProps }): JSX.Element {
  const id = createUniqueId();
  const service = useMachine(popover.machine, () => ({ id, positioning: { placement: 'bottom-start' as const, gutter: 6, flip: true } }));
  const api = createMemo(() => popover.connect(service, normalizeProps));
  return (
    <>
      <button {...api().getTriggerProps()} type="button" data-kit="plan-used" data-part={props.part} title={props.title}>
        {props.lead}
        <span>{props.text}</span>
      </button>
      <Portal>
        <div {...api().getPositionerProps()} data-kit="positioner">
          <div {...api().getContentProps()} data-kit="plan-menu" data-part="split.usage.card" aria-label={props.card.label}>
            <Show when={api().open}>
              <UsageCard card={props.card} close={() => api().setOpen(false)} />
            </Show>
          </div>
        </div>
      </Portal>
    </>
  );
}

/** The task's usage lines; nothing when nothing was measured. */
export function TaskUsage(props: TaskUsageProps): JSX.Element {
  return (
    <>
      <Show when={props.plan}>{(p) => <UsageLine lead={<Icon name="stats" />} text={p().text} title={p().title} part="split.usage" card={props} />}</Show>
      <Show when={props.context}>
        {(c) => (
          <UsageLine
            lead={<span data-kit="pu-ring" data-hi={c().hi ? '' : undefined} style={{ '--ctx': `${Math.round((c().share ?? 0) * 100)}%` }} aria-hidden="true" />}
            text={c().text}
            title={c().title}
            part="split.context"
            card={props}
          />
        )}
      </Show>
    </>
  );
}
