// Usage at a glance under Home's prompt box (v1 #790, budget.js homeUsageHtml, split.css .sh-usage/.hu-*): one quiet
// row, per account its mark, its name when the harness has several, and a thin meter and a percentage per window,
// amber near the line and red when used up. The whole row is one button (Settings → Usage). Nothing with no groups.
// A Wrap group (design/layout.md): accounts wrap as wholes on a narrow screen, never mid-meter.
import { For, Show, type JSX } from 'solid-js';
import { styleOf, type KitProps } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export interface HomeUsageWindow {
  readonly key: string;
  /** "5h", "Week", "Opus week" */
  readonly short: string;
  /** 0..1 */
  readonly used: number;
  /** "42%" */
  readonly pct: string;
  readonly tone?: 'warn' | 'full' | undefined;
  /** what hovering says: whose window, how much is used, when it resets */
  readonly tip: string;
  /** the meter's name, read out with its value */
  readonly aria: string;
}

export interface HomeUsageGroup {
  readonly key: string;
  /** the harness's mark (an image URL) */
  readonly logo?: string | undefined;
  /** the logo's title: "Claude Code (Work)" */
  readonly who: string;
  /** the account's name, when the harness has several */
  readonly account?: string | undefined;
  readonly windows: readonly HomeUsageWindow[];
}

export interface HomeUsageProps extends KitProps {
  readonly groups: readonly HomeUsageGroup[];
  /** the row's title: "Usage: open Settings → Usage" */
  readonly title: string;
  readonly onOpen: () => void;
}

const pctVar = (x: number): string => `${Math.round(Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0)) * 1000) / 10}%`;

export function HomeUsage(props: HomeUsageProps): JSX.Element {
  return (
    <Show when={props.groups.length > 0}>
      <div id={props.id} data-kit="home-usage" data-part={props.part ?? 'home.usage.row'}>
        <button type="button" data-kit="hu-row" data-layout="wrap" data-part="home.usage.wrap" title={props.title} onClick={() => props.onOpen()}>
          <For each={props.groups}>
            {(g) => (
              <span data-kit="hu-acct">
                <span data-kit="hu-logo" title={g.who}>
                  <Show when={g.logo} fallback={<Icon name="stats" size="sm" />}>
                    {(src) => <img src={src()} alt="" />}
                  </Show>
                </span>
                <Show when={g.account}>
                  <span data-kit="hu-acc" data-text="control">
                    {g.account}
                  </span>
                </Show>
                <For each={g.windows}>
                  {(w) => (
                    <span data-kit="hu-win" data-tone={w.tone} title={w.tip}>
                      <span data-kit="hu-l" data-text="control">
                        {w.short}
                      </span>
                      <span data-kit="hu-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.used * 100)} aria-label={w.aria}>
                        <i style={styleOf({ '--k-p': pctVar(w.used) })} />
                      </span>
                      <b data-kit="hu-p">{w.pct}</b>
                    </span>
                  )}
                </For>
              </span>
            )}
          </For>
        </button>
      </div>
    </Show>
  );
}
