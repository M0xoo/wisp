// Compare runs (v1 features/compare.js compareView, ship.css .compare-modal): the ask, a table of each run's numbers
// (a row label, then a cell per run under its letter and harness), the totals line, then the runs side by side: each
// a head (letter, harness logo, harness and model, its state), its last answer, and Open card / Keep this. Value for
// value; the owner computes the numbers and renders the answers.
import { For, Show, type JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { Button } from '../controls/Button.tsx';
import { Pill } from '../content/Pill.tsx';

export interface CompareCellView {
  readonly text: string;
  readonly add?: number;
  readonly del?: number;
  readonly tone?: 'good' | 'bad';
  readonly tip?: string;
}

export interface CompareRowView {
  readonly key: string;
  readonly label: string;
  readonly tip?: string;
  readonly cells: readonly CompareCellView[];
}

export interface CompareRunView {
  readonly id: string;
  readonly letter: string;
  readonly harness: string;
  /** the harness logo's src */
  readonly logo?: string | undefined;
  /** model · thinking */
  readonly base: string;
  /** the row's state and its tone, as the list says it (done, info, warn, bad, live) */
  readonly state: { readonly label: string; readonly tone: string; readonly live?: boolean };
  /** the run's last answer (or its live line while it works) */
  readonly body: JSX.Element;
  /** Keep this waits for the run to finish */
  readonly working?: boolean;
}

export interface CompareRunsProps {
  readonly prompt: string;
  readonly rows: readonly CompareRowView[];
  readonly runs: readonly CompareRunView[];
  readonly total?: string;
  readonly sentence?: string;
  /** Try it two ways: what differed between the runs, under the ask (v1 .cmp-diff); `same` mutes it */
  readonly differs?: { readonly text: string; readonly same?: boolean } | undefined;
  readonly labels: { readonly runs: string; readonly open: string; readonly keep: string; readonly stillWorking: string };
  readonly onOpen: (id: string) => void;
  readonly onKeep: (id: string, anchor: HTMLElement) => void;
}

function Cell(props: { readonly cell: CompareCellView | undefined; readonly row: string }): JSX.Element {
  return (
    <td data-row={props.row} title={props.cell?.tip ?? ''} data-tone={props.cell?.tone}>
      {props.cell?.text ?? ''}
      <Show when={props.cell?.add !== undefined}>
        {' '}
        <span data-kit="cmp-plus">+{props.cell?.add}</span> <span data-kit="cmp-minus">−{props.cell?.del}</span>
      </Show>
    </td>
  );
}

/** the list's state tones as a pill's */
const PILL: Readonly<Record<string, Tone>> = { done: 'good', info: 'info', warn: 'warn', bad: 'bad', live: 'accent' };

export function CompareRuns(props: CompareRunsProps): JSX.Element {
  const n = (): number => props.runs.length;
  return (
    <div data-kit="cmp" data-n={Math.min(n(), 4)} style={{ '--n': String(n()) }} data-part="compare.body">
      <p data-kit="cmp-prompt" tabindex={props.prompt.length > 240 ? 0 : undefined}>
        {props.prompt}
      </p>
      <Show when={props.differs}>
        {(d) => (
          <p data-kit="cmp-diff" data-same={d().same ? '' : undefined} data-part="compare.differs">
            {d().text}
          </p>
        )}
      </Show>
      <div data-kit="cmp-scroll" {...(n() > 3 && { tabindex: 0, role: 'region', 'aria-label': props.labels.runs })}>
        <table data-kit="cmp-table" data-part="compare.table">
          <thead>
            <tr>
              <td />
              <For each={props.runs}>
                {(r) => (
                  <th scope="col">
                    <span data-kit="cmp-run">
                      <b data-kit="cmp-letter">{r.letter}</b>
                      <span title={r.harness}>{r.harness}</span>
                    </span>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row) => (
                <tr>
                  <th scope="row" title={row.tip ?? ''}>
                    {row.label}
                  </th>
                  <For each={props.runs}>{(_, i) => <Cell cell={row.cells[i()]} row={row.key} />}</For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <p data-kit="cmp-note">
        <span data-kit="cmp-total">{props.total ?? ''}</span> <span>{props.sentence ?? ''}</span>
      </p>
      <div data-kit="cmp-grid" data-part="compare.runs">
        <For each={props.runs}>
          {(r) => (
            <section data-kit="cmp-col" data-id={r.id} data-part="compare.run">
              <div data-kit="cmp-head">
                <b data-kit="cmp-letter">{r.letter}</b>
                <Show when={r.logo}>{(src) => <img data-kit="cmp-logo" src={src()} alt="" />}</Show>
                <span data-kit="cmp-who">
                  <b>{r.harness}</b>
                  <small title={r.base}>{r.base}</small>
                </span>
                <Pill tone={PILL[r.state.tone] ?? 'neutral'} dot live={r.state.live === true} size="sm">
                  {r.state.label}
                </Pill>
              </div>
              <div data-kit="cmp-body">{r.body}</div>
              <div data-kit="cmp-foot">
                <Button variant="ghost" size="xs" icon="chevron" onClick={() => props.onOpen(r.id)} part="compare.open">
                  {props.labels.open}
                </Button>
                <span data-kit="cmp-grow" />
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  disabled={r.working === true}
                  title={r.working ? props.labels.stillWorking : ''}
                  onClick={(e) => props.onKeep(r.id, e.currentTarget as HTMLElement)}
                  part="compare.keep"
                >
                  {props.labels.keep}
                </Button>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
