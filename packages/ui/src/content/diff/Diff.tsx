// Diff: a unified diff as files with a header (path, +N −M), hunk rows and numbered lines.
// Large files start folded behind "Show N lines"; opened, they render in chunks the browser
// lays out only near the screen (content-visibility), so a 10,000-line diff stays cheap.
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../../core/props.ts';
import { useT, type Translate } from '../../core/i18n.tsx';
import { Icon } from '../Icon.tsx';
import type { IconName } from '../icons.ts';
import { Text } from '../Text.tsx';
import { Button } from '../../controls/Button.tsx';
import { parseDiff, type DiffFile, type DiffLine, type DiffStatus } from './parse.ts';

export interface DiffProps extends KitProps {
  /** A unified diff, as `git diff` prints it. */
  readonly diff?: string;
  /** Or files parsed already (wins over `diff`). */
  readonly files?: readonly DiffFile[];
  /** Files with more lines than this start folded (default 400). */
  readonly lazyLines?: number;
  /** Shown in place of lines for a binary file. Without it the file shows its header only. */
  readonly binaryLabel?: string;
  readonly t?: Translate;
}

type Row = { readonly kind: 'hunk'; readonly text: string } | DiffLine;

const CHUNK = 200;

const STATUS_ICON: Readonly<Record<DiffStatus, IconName>> = { added: 'plus', deleted: 'minus', renamed: 'arrow', modified: 'file' };

function rowsOf(file: DiffFile): Row[] {
  const rows: Row[] = [];
  for (const h of file.hunks) {
    rows.push({ kind: 'hunk', text: h.header });
    rows.push(...h.lines);
  }
  return rows;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const SIGN: Readonly<Record<DiffLine['kind'], string>> = { add: '+', del: '-', ctx: ' ', note: '' };

function LineRow(props: { readonly row: Row }): JSX.Element {
  const r = props.row;
  if (r.kind === 'hunk') return <div data-kit="diff-hunk">{r.text}</div>;
  return (
    <div data-kit="diff-line" data-kind={r.kind}>
      <span data-kit="diff-no">{r.old ?? ''}</span>
      <span data-kit="diff-no">{r.new ?? ''}</span>
      <span data-kit="diff-sign">{SIGN[r.kind]}</span>
      <span data-kit="diff-src">{r.text}</span>
    </div>
  );
}

function FileHead(props: { readonly file: DiffFile; readonly part: PartName }): JSX.Element {
  const f = (): DiffFile => props.file;
  return (
    <header data-kit="diff-head" data-part={sub(props.part, 'head')}>
      <Icon name={STATUS_ICON[f().status]} size="md" tone={f().status === 'added' ? 'good' : f().status === 'deleted' ? 'bad' : 'faint'} />
      <span data-kit="diff-path">
        <Show when={f().status === 'renamed' && f().oldPath}>
          {(old) => (
            <Text mono size="sm" tone="faint" truncate title={old()}>
              {`${old()} → `}
            </Text>
          )}
        </Show>
        <Text mono size="sm" tone="ink" truncate title={f().path}>
          {f().path}
        </Text>
      </span>
      <span data-kit="diff-counts">
        <Show when={f().additions > 0}>
          <Text mono size="xs" tone="good" numeric>{`+${f().additions}`}</Text>
        </Show>
        <Show when={f().deletions > 0}>
          <Text mono size="xs" tone="bad" numeric>{`−${f().deletions}`}</Text>
        </Show>
      </span>
    </header>
  );
}

function FileView(props: { readonly file: DiffFile; readonly part: PartName; readonly lazyLines: number; readonly binaryLabel: string | undefined; readonly t: Translate }): JSX.Element {
  const rows = createMemo(() => rowsOf(props.file));
  const lines = (): number => props.file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const big = (): boolean => lines() > props.lazyLines;
  const [open, setOpen] = createSignal(false);
  // Gutters fit the longest line number, so columns line up down the whole file.
  const digits = createMemo(() => String(Math.max(1, ...props.file.hunks.map((h) => Math.max(h.oldStart, h.newStart) + h.lines.length))).length);
  return (
    <section data-kit="diff-file" data-part={sub(props.part, 'file')} data-status={props.file.status}>
      <FileHead file={props.file} part={props.part} />
      <Show when={!props.file.binary} fallback={<Show when={props.binaryLabel}>{(label) => <div data-kit="diff-note">{label()}</div>}</Show>}>
        <Show
          when={!big() || open()}
          fallback={
            <div data-kit="diff-fold">
              <Button variant="ghost" size="sm" icon="expand" onClick={() => setOpen(true)} part={sub(props.part, 'expand')}>
                {props.t('show-file', { n: lines() })}
              </Button>
            </div>
          }
        >
          <div data-kit="diff-scroll" tabIndex={0}>
            <div data-kit="diff-body" style={{ '--k-digits': String(digits()) }}>
              <For each={chunks(rows(), CHUNK)}>
                {(chunk) => (
                  <div data-kit="diff-chunk" data-lazy={big() ? '' : undefined} style={{ '--k-lines': String(chunk.length) }}>
                    <For each={chunk}>{(row) => <LineRow row={row} />}</For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Show>
    </section>
  );
}

export function Diff(props: DiffProps): JSX.Element {
  const t = useT(() => props.t);
  const files = createMemo(() => props.files ?? parseDiff(props.diff ?? ''));
  const part = (): PartName => props.part ?? 'ui.diff';
  return (
    <div id={props.id} data-kit="diff" data-part={part()}>
      <For each={files()}>{(file) => <FileView file={file} part={part()} lazyLines={props.lazyLines ?? 400} binaryLabel={props.binaryLabel ?? t('diff.binary')} t={t} />}</For>
    </div>
  );
}
