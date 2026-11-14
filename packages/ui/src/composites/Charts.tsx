// Numbers over time and in rows (v1 usage.js, Settings → Usage → Open usage): DayBars, one bar per day with its
// tip on hover and the axis under it (.us-chart, .us-axis); DataTable, a breakdown whose first column names the
// row and the rest are numbers on the right (.us-table).
import { createSignal, For, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';

export interface DayBar {
  readonly key: string;
  /** 0–1 of the tallest */
  readonly share: number;
  /** what hovering it says: "Nov 12: $0.40 · 3 turns" */
  readonly tip: string;
}

export interface DayBarsProps extends KitProps {
  readonly bars: readonly DayBar[];
  readonly label: string;
  /** under the bars: the first day, the scale, today */
  readonly axis: readonly [string, string, string];
}

export function DayBars(props: DayBarsProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.day-bars';
  const [tip, setTip] = createSignal<{ text: string; at: number } | undefined>();
  return (
    <div id={props.id} data-kit="day-bars" data-part={part()}>
      <div data-kit="day-bars-plot" role="img" aria-label={props.label} onMouseLeave={() => setTip(undefined)}>
        <For each={props.bars}>
          {(b, i) => (
            <div data-kit="day-bar" title={b.tip} onMouseEnter={() => setTip({ text: b.tip, at: (i() + 0.5) / Math.max(1, props.bars.length) })}>
              <i style={{ '--k-v': `${b.share > 0 ? Math.max(2, b.share * 100) : 0}%` }} />
            </div>
          )}
        </For>
        <Show when={tip()}>
          {(x) => (
            <span data-kit="day-bars-tip" style={{ '--k-x': `${x().at * 100}%` }}>
              {x().text}
            </span>
          )}
        </Show>
      </div>
      <div data-kit="day-bars-axis" data-part={sub(part(), 'axis')}>
        <span>{props.axis[0]}</span>
        <span>{props.axis[1]}</span>
        <span>{props.axis[2]}</span>
      </div>
    </div>
  );
}

export interface DataTableProps extends KitProps {
  readonly columns: readonly string[];
  readonly rows: readonly { readonly key: string; readonly cells: readonly JSX.Element[] }[];
  /** no rows: this line instead */
  readonly empty: string;
}

export function DataTable(props: DataTableProps): JSX.Element {
  return (
    <Show when={props.rows.length > 0} fallback={<p data-kit="data-table-empty">{props.empty}</p>}>
      <table id={props.id} data-kit="data-table" data-part={props.part ?? 'ui.data-table'}>
        <thead>
          <tr>
            <For each={props.columns}>{(c) => <th scope="col">{c}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(r) => (
              <tr>
                {r.cells.map((c) => (
                  <td>{c}</td>
                ))}
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}
