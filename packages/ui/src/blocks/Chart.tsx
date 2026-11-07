// The `chart` block (v1 web/js/blocks.js R.chart): one bar per item, scaled to the largest value,
// with the real value and its unit beside it. The bars are drawn for the eye and hidden from
// readers; a table with the same numbers is there for them.
import { createMemo, For, Show, type JSX } from 'solid-js';
import { styleOf } from '../core/props.ts';
import { useBlockT } from './context.tsx';
import { items, num, opt, str } from './read.ts';
import { BlockTitle } from './rich-ui.tsx';
import type { BlockProps } from './types.ts';

export interface ChartBar {
  readonly label: string;
  /** what's written beside the bar: the agent's value as it wrote it */
  readonly shown: string;
  /** 0–100: the bar's share of the largest |value| */
  readonly pct: number;
}

/** Bars from the block's items: a value that isn't a number draws no bar but still shows. */
export function chartBars(v: unknown): ChartBar[] {
  const rows = items(v, (o) => ({ label: str(o['label']), value: num(o['value']), raw: str(o['value']) }));
  const max = Math.max(...rows.map((r) => Math.abs(r.value ?? 0)), 1);
  return rows.map((r) => ({ label: r.label, shown: r.value === undefined ? r.raw || '–' : String(r.value), pct: (Math.abs(r.value ?? 0) / max) * 100 }));
}

export function ChartBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const bars = createMemo(() => chartBars(props.block['items']));
  const unit = (): string | undefined => opt(props.block['unit']);
  const title = (): string | undefined => opt(props.block['title']);
  return (
    <div data-kit="rb-chart" data-card="" data-part="block.chart">
      <Show when={title()}>{(s) => <BlockTitle part="block.chart.title">{s()}</BlockTitle>}</Show>
      <div data-kit="rb-chart-bars" aria-hidden="true">
        <For each={bars()}>
          {(bar, i) => (
            <div data-kit="rb-chart-row" data-part="block.chart.row" style={styleOf({ '--k': i() })}>
              <span data-kit="rb-chart-label" data-text="control" title={bar.label}>
                {bar.label}
              </span>
              <span data-kit="rb-chart-track">
                <span data-kit="rb-chart-bar" style={styleOf({ '--k-w': `${bar.pct}%` })} />
              </span>
              <span data-kit="rb-chart-value">
                {bar.shown}
                <Show when={unit()}>{(u) => <span data-kit="rb-chart-unit">{u()}</span>}</Show>
              </span>
            </div>
          )}
        </For>
      </div>
      <table data-kit="rb-chart-table" data-part="block.chart.table">
        <Show when={title()}>{(s) => <caption>{s()}</caption>}</Show>
        <thead>
          <tr>
            <th scope="col">{t('block.chart.label')}</th>
            <th scope="col">{t('block.chart.value')}</th>
          </tr>
        </thead>
        <tbody>
          <For each={bars()}>
            {(bar) => (
              <tr>
                <th scope="row">{bar.label}</th>
                <td>{unit() ? `${bar.shown} ${unit() ?? ''}` : bar.shown}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
