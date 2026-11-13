// Plan budget in Settings → Usage (v1 web/css/modals.css .bg-acct, .bg-where, .bg-cmp): one account's windows as rows
// (label, bar with the stop line, percent, and its line under it), a note (banked resets), and Where the window went
// (each task a button); and per harness, tokens per turn by account. The words come in ready; the kit only lays out.
import { For, Show, type JSX } from 'solid-js';
import { sub, styleOf, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { Button } from '../controls/Button.tsx';

export interface PlanWindowRow {
  readonly label: string;
  /** 0..1 */
  readonly used: number;
  /** "42%" */
  readonly pct: string;
  /** the line under it: "Resets Sat 01:31 · at this pace, runs out Fri 23:32" */
  readonly line: string;
  readonly tone?: 'warn' | 'full';
  /** read out with the bar: "Codex · Work, 5-hour window used" */
  readonly aria: string;
}

export interface PlanWhereRow {
  readonly key: string;
  readonly title: string;
  readonly pct: string;
  readonly tip?: string;
  /** a task's row opens it; the others are quiet */
  readonly onOpen?: () => void;
}

export interface PlanAccountProps extends KitProps, WithChildren {
  readonly name: string;
  readonly logo?: string | undefined;
  /** the account's name, when the harness has several */
  readonly account?: string | undefined;
  readonly windows: readonly PlanWindowRow[];
  /** where automations stop (0..1): a line across every bar */
  readonly stop?: number | null;
  readonly stopLabel?: string;
  /** one quiet line under the bars (Codex's banked resets) */
  readonly note?: { readonly text: string; readonly tip?: string; readonly warn?: boolean } | undefined;
  readonly where?: { readonly heading: string; readonly rows: readonly PlanWhereRow[] } | undefined;
}

const pctVar = (x: number): string => `${Math.round(Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0)) * 1000) / 10}%`;

/** One account's Plan budget (v1 .bg-acct); callouts (Past your plan, a window change) go in as children. */
export function PlanAccount(props: PlanAccountProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.plan';
  return (
    <div id={props.id} data-kit="plan-acct" data-part={part()} data-stops={props.stop != null ? '' : undefined} style={styleOf({ '--k-stop': props.stop != null ? pctVar(props.stop) : undefined })}>
      <b data-kit="plan-name" data-part={sub(part(), 'name')}>
        <Show when={props.logo}>{(src) => <img data-kit="plan-logo" src={src()} alt="" />}</Show>
        <span data-text="control">{props.name}</span>
        <Show when={props.account}>
          <span data-kit="plan-acc" data-text="control">
            {props.account}
          </span>
        </Show>
      </b>
      <For each={props.windows}>
        {(w) => (
          <div data-kit="plan-win" data-part={sub(part(), 'window')} data-tone={w.tone}>
            <span data-kit="plan-l" data-text="control">
              {w.label}
            </span>
            <span data-kit="plan-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.used * 100)} aria-label={w.aria}>
              <i style={styleOf({ '--k-p': pctVar(w.used) })} />
              <Show when={props.stop != null}>
                <span data-kit="plan-stop" title={props.stopLabel} />
              </Show>
            </span>
            <b data-kit="plan-p">{w.pct}</b>
            <small data-kit="plan-t">{w.line}</small>
          </div>
        )}
      </For>
      <Show when={props.note}>
        {(n) => (
          <span data-kit="plan-note" data-part={sub(part(), 'note')} data-warn={n().warn ? '' : undefined} title={n().tip}>
            <Icon name="replay" size="sm" />
            <span>{n().text}</span>
          </span>
        )}
      </Show>
      <Show when={props.children}>
        <div data-kit="plan-extra">{props.children}</div>
      </Show>
      <Show when={props.where}>
        {(wh) => (
          <div data-kit="plan-where" data-part={sub(part(), 'where')}>
            <small data-kit="plan-wh">{wh().heading}</small>
            <For each={wh().rows}>
              {(r) => (
                <Show
                  when={r.onOpen}
                  fallback={
                    <div data-kit="plan-task" data-part={sub(part(), 'rest')} data-quiet="" title={r.tip}>
                      <span data-kit="plan-tt">{r.title}</span>
                      <b data-kit="plan-p">{r.pct}</b>
                    </div>
                  }
                >
                  {(open) => (
                    <button type="button" data-kit="plan-task" data-part={sub(part(), 'task')} title={r.tip} onClick={() => open()()}>
                      <span data-kit="plan-tt">{r.title}</span>
                      <b data-kit="plan-p">{r.pct}</b>
                    </button>
                  )}
                </Show>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

export interface PlanCompareProps extends KitProps {
  readonly name: string;
  readonly logo?: string | undefined;
  /** "tokens per turn by account" */
  readonly what: string;
  /** "Median turn, last 7 days" and its tooltip */
  readonly heading: string;
  readonly tip?: string;
  readonly rows: readonly { readonly model: string; readonly words: string; readonly accounts: readonly { readonly label: string; readonly parts: readonly string[] }[] }[];
  readonly copyLabel: string;
  readonly onCopy: () => void;
}

/** Tokens per turn by account for one harness (v1 .bg-cmp): numbers only, with Copy report. */
export function PlanCompare(props: PlanCompareProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.plan.compare';
  return (
    <div id={props.id} data-kit="plan-cmp" data-part={part()}>
      <b data-kit="plan-name">
        <Show when={props.logo}>{(src) => <img data-kit="plan-logo" src={src()} alt="" />}</Show>
        <span data-text="control">{props.name}</span>
        <span data-kit="plan-ch">{props.what}</span>
      </b>
      <small data-kit="plan-wh" title={props.tip}>
        {props.heading}
      </small>
      <For each={props.rows}>
        {(r) => (
          <div data-kit="plan-cr" data-part={sub(part(), 'model')}>
            <span data-kit="plan-cm">{r.model}</span>
            <span data-kit="plan-cw">{r.words}</span>
            <For each={r.accounts}>
              {(x) => (
                <span data-kit="plan-ca">
                  <span data-kit="plan-acc" data-text="control">
                    {x.label}
                  </span>
                  <span data-kit="plan-cn">{x.parts.join(' · ')}</span>
                </span>
              )}
            </For>
          </div>
        )}
      </For>
      <span data-kit="plan-da">
        <Button size="sm" variant="ghost" icon="copy" part={sub(part(), 'copy')} onClick={() => props.onCopy()}>
          {props.copyLabel}
        </Button>
      </span>
    </div>
  );
}

/** The accounts and comparisons in a group's box, one under the other with a line between (v1 .bg-list). */
export function PlanList(props: KitProps & WithChildren): JSX.Element {
  return (
    <div id={props.id} data-kit="plan-list" data-part={props.part ?? 'settings.plan.list'}>
      {props.children}
    </div>
  );
}
