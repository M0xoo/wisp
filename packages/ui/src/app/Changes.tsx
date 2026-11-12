// v1 features/changes.js (design/side-panel.md): the side panel's Changes. A summary row (files, +/−, what it's
// compared with, how many viewed, Expand / Collapse all, Open file…), the commit row (a one-line message, how many
// staged, Commit), then one row per file (its status badge, the path cut from its start, +/−, Stage, Viewed, Edit,
// ⋯) opening in place to its diff: one block per hunk with its own head row (Line n, Stage / Unstage, Revert), the
// unchanged runs between folded to a line. A file or hunk being reverted is hidden until the diff comes back.
import { For, Show, createSignal, type JSX } from 'solid-js';
import { flag, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { WithAct, type Act } from './act.tsx';

/** A row of a git diff (wisp-git's FileDiff rows): ' ', '+', '-', or '…' for a gap of `count` unchanged lines. */
export interface ChangeRow {
  readonly op: string;
  readonly text?: string;
  readonly a?: number;
  readonly b?: number;
  readonly count?: number;
}

export type StageState = 'none' | 'stage' | 'part' | 'staged';

export interface ChangeFile {
  readonly path: string;
  /** git's letter: A, M, D, R */
  readonly status: string;
  readonly add: number;
  readonly del: number;
  readonly binary: boolean;
  readonly rows: readonly ChangeRow[];
  readonly from?: string | null;
  /** the file's stage toggle (undefined: not a worktree, no staging here) */
  readonly stage?: StageState;
  /** per hunk: 'stage' while any of it is still to stage, 'unstage' once all of it is, undefined when committed */
  readonly hunkStage?: readonly ('stage' | 'unstage' | undefined)[];
  /** git's diff of a file changed in place: each hunk can be put back */
  readonly revertable: boolean;
  /** a .env file (v1 env-mask.js): its values read KEY=•••• ('hidden') until Reveal shows them ('shown') */
  readonly env?: 'hidden' | 'shown';
}

export interface ChangesLabels {
  readonly files: (n: number) => string;
  readonly vs: string;
  readonly vsTitle: string;
  readonly viewedOf?: string;
  readonly expandAll: string;
  readonly collapseAll: string;
  readonly openFile?: string;
  readonly openFileTitle?: string;
  readonly stage: string;
  readonly part: string;
  readonly staged: string;
  readonly viewed: string;
  readonly viewedTitle: (on: boolean) => string;
  readonly edit: string;
  readonly more: string;
  readonly line: (n: string | number) => string;
  readonly revert: string;
  readonly revertTitle: string;
  readonly stageHunk: string;
  readonly unstageHunk: string;
  readonly unchanged: (n: number) => string;
  readonly commit: string;
  readonly commitPlaceholder: string;
  /** the line over a .env file's diff: what's hidden or shown, and its button */
  readonly envHidden?: (name: string) => string;
  readonly envShown?: (name: string) => string;
  readonly reveal?: string;
  readonly hide?: string;
}

export interface ChangesListProps {
  readonly files: readonly ChangeFile[];
  readonly labels: ChangesLabels;
  readonly open: (path: string) => boolean;
  readonly viewed: (path: string) => boolean;
  readonly onToggle: (path: string) => void;
  readonly onViewed: (path: string) => void;
  readonly allOpen: boolean;
  readonly onAll: () => void;
  readonly onFind?: () => void;
  readonly onStage?: (path: string, unstage: boolean) => void;
  readonly onHunkStage?: (path: string, hunk: number, key: string, unstage: boolean) => void;
  readonly onRevertHunk?: (path: string, hunk: number, key: string) => void;
  /** Reveal (true) or Hide (false) a .env file's values */
  readonly onReveal?: (path: string, on: boolean) => void;
  readonly onEdit?: (path: string) => void;
  /** the file's ⋯ (Revert file…, Copy path, Open in editor) */
  readonly fileMenu?: (path: string) => Act;
  /** the commit row: shown while anything here is staged or still to stage */
  readonly commit?: { readonly count: string; readonly countTitle: string; readonly placeholder: string; readonly onCommit: (message: string) => void };
  /** hunks being reverted: `path#hunk`, hidden until the diff comes back */
  readonly going?: ReadonlySet<string>;
  /** comments on lines, like a review (v1 comments.js): a + over the sign of the line under the pointer, each
   * commented line's number marked, and the card under the line it's being written on */
  readonly comment?: {
    readonly label: (row: ChangeRow) => string;
    readonly onAdd: (path: string, row: ChangeRow) => void;
    /** `n12` / `o12` → its number in the tray */
    readonly marks: (path: string) => ReadonlyMap<string, number>;
    /** the line a card is open on, and the card */
    readonly open?: { readonly path: string; readonly key: string; readonly card: JSX.Element } | undefined;
  };
  readonly part?: PartName;
}

const BADGE: Readonly<Record<string, string>> = { A: 'add', M: 'mod', D: 'del', R: 'ren' };

/** djb2 over `op + (text ?? count) + "\n"` per row, base 36: the hunk's key, as wisp-git checks it (v1 hash()). */
export function hunkKey(rows: readonly ChangeRow[]): string {
  let h = 5381;
  // per code point, its first UTF-16 unit (v1's for…of + charCodeAt(0); wisp-git hashes the same)
  for (const r of rows) for (const c of `${r.op}${r.text ?? r.count}\n`) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/** A diff's hunks: the runs between '…' gaps (v1 hunkRuns). `gap`: the gap row before it. */
export function hunkRuns(rows: readonly ChangeRow[]): { from: number; rows: ChangeRow[]; gap: ChangeRow | null }[] {
  const out: { from: number; rows: ChangeRow[]; gap: ChangeRow | null }[] = [];
  let h: { from: number; rows: ChangeRow[]; gap: ChangeRow | null } | null = null;
  let gap: ChangeRow | null = null;
  rows.forEach((o, i) => {
    if (o.op === '…') {
      h = null;
      gap = o;
      return;
    }
    if (!h) {
      h = { from: i, rows: [], gap };
      out.push(h);
      gap = null;
    }
    h.rows.push(o);
  });
  return out;
}

/** Where a hunk's change is: its first changed line (the old number for a line only removed). */
export const firstLine = (rows: readonly ChangeRow[]): string | number => {
  const o = rows.find((r) => r.op !== ' ') ?? rows[0];
  return (o?.op === '-' ? o.a : o?.b) ?? '';
};

function Path(props: { readonly path: string }): JSX.Element {
  const i = (): number => props.path.lastIndexOf('/');
  return (
    <span data-kit="cx-path">
      <Show when={i() >= 0}>
        <span data-kit="cx-dir">
          <bdi>{props.path.slice(0, i() + 1)}</bdi>
        </span>
      </Show>
      <span data-kit="cx-base">{props.path.slice(i() + 1)}</span>
    </span>
  );
}

/** `n12` / `o12`: a row's place in its file, as comments key it */
export const rowKey = (o: ChangeRow): string | undefined => {
  const n = o.op === '-' ? o.a : o.b;
  return n === undefined || o.op === '…' ? undefined : `${o.op === '-' ? 'o' : 'n'}${n}`;
};

interface LineCtx {
  readonly path: string;
  readonly p: ChangesListProps;
  /** the row the + sits on (the pointer's, else the diff's last) */
  readonly at: () => ChangeRow | undefined;
  readonly hover: (o: ChangeRow) => void;
}

function Line(props: { readonly o: ChangeRow; readonly c?: LineCtx | undefined }): JSX.Element {
  const kind = (): string => (props.o.op === '+' ? 'add' : props.o.op === '-' ? 'del' : 'ctx');
  const cm = (): ChangesListProps['comment'] => props.c?.p.comment;
  const key = (): string | undefined => rowKey(props.o);
  const mark = (): number | undefined =>
    key()
      ? cm()
          ?.marks(props.c?.path ?? '')
          .get(key() as string)
      : undefined;
  const open = (): JSX.Element | undefined => {
    const o = cm()?.open;
    return o && o.path === props.c?.path && o.key === key() ? o.card : undefined;
  };
  return (
    <>
      <tr data-kit="cx-line" data-op={kind()} data-lit={flag(mark() !== undefined || open() !== undefined)} onPointerEnter={() => props.c?.hover(props.o)}>
        <td data-kit="cx-no">
          <Show when={mark()}>{(n) => <span data-kit="cx-mark">{n()}</span>}</Show>
          {(props.o.op === '-' ? props.o.a : props.o.b) ?? ''}
        </td>
        <td data-kit="cx-sign">
          {props.o.op === ' ' ? '' : props.o.op === '-' ? '−' : '+'}
          <Show when={cm() && key() && props.c?.at() === props.o}>
            <button
              type="button"
              data-kit="cx-cmt"
              data-part="panel.changes.comment"
              aria-label={cm()?.label(props.o)}
              title={cm()?.label(props.o)}
              onClick={() => cm()?.onAdd(props.c?.path ?? '', props.o)}
            >
              <Icon name="plus" size="sm" />
            </button>
          </Show>
        </td>
        <td data-kit="cx-src">{props.o.text || ' '}</td>
      </tr>
      <Show when={open()}>
        {(card) => (
          <tr data-kit="cx-cmt-row">
            <td colSpan={3}>{card()}</td>
          </tr>
        )}
      </Show>
    </>
  );
}

function FileDiff(props: { readonly f: ChangeFile; readonly p: ChangesListProps }): JSX.Element {
  const L = props.p.labels;
  // one + per diff, on the line under the pointer; before any, on the last numbered line (as v1's sat where it was left)
  const [hovered, setHovered] = createSignal<ChangeRow | undefined>();
  const last = (): ChangeRow | undefined => [...props.f.rows].reverse().find((o) => rowKey(o) !== undefined);
  const ctx: LineCtx = { path: props.f.path, p: props.p, at: () => hovered() ?? last(), hover: (o) => rowKey(o) && setHovered(o) };
  const gap = (o: ChangeRow): JSX.Element => (
    <tr data-kit="cx-gap">
      <td colSpan={3}>
        <Icon name="dots" size="sm" /> {L.unchanged(o.count ?? 0)}
      </td>
    </tr>
  );
  const name = (): string => props.f.path.split(/[\\/]/).pop() ?? props.f.path;
  return (
    <div data-kit="cx-diff">
      <Show when={props.f.env}>
        {(env) => (
          <div data-kit="cx-env" data-part="changes.envMask">
            <span data-kit="cx-env-what">{env() === 'shown' ? L.envShown?.(name()) : L.envHidden?.(name())}</span>
            <button type="button" data-kit="cx-env-btn" data-part="changes.envReveal" aria-pressed={env() === 'shown'} onClick={() => props.p.onReveal?.(props.f.path, env() !== 'shown')}>
              {env() === 'shown' ? L.hide : L.reveal}
            </button>
          </div>
        )}
      </Show>
      <Show when={props.f.from}>
        {(from) => (
          <p data-kit="cx-from">
            <Icon name="arrow" size="sm" />
            <code>{from()}</code>
          </p>
        )}
      </Show>
      <div data-kit="cx-scroll">
        <table>
          <Show
            when={props.f.revertable}
            fallback={
              <tbody>
                <For each={props.f.rows}>{(o) => (o.op === '…' ? gap(o) : <Line o={o} c={ctx} />)}</For>
              </tbody>
            }
          >
            <For each={hunkRuns(props.f.rows)}>
              {(h, i) => {
                const key = hunkKey(h.rows);
                const st = (): 'stage' | 'unstage' | undefined => props.f.hunkStage?.[i()];
                return (
                  <>
                    <Show when={h.gap}>{(g) => <tbody data-kit="cx-gapb">{gap(g())}</tbody>}</Show>
                    <tbody data-kit="cx-hunk" hidden={props.p.going?.has(`${props.f.path}#${i()}`)}>
                      <tr data-kit="cx-hk-head">
                        <td colSpan={3}>
                          <div data-kit="cx-hk-bar">
                            <span>{L.line(firstLine(h.rows))}</span>
                            <Show when={st() && props.p.onHunkStage}>
                              <button
                                type="button"
                                data-kit="cx-hk-stage"
                                data-part="panel.changes.stageHunk"
                                data-un={flag(st() === 'unstage')}
                                onClick={() => props.p.onHunkStage?.(props.f.path, i(), key, st() === 'unstage')}
                              >
                                {st() === 'unstage' ? L.unstageHunk : L.stageHunk}
                              </button>
                            </Show>
                            <Show when={props.p.onRevertHunk}>
                              <button type="button" data-kit="cx-hk-rev" data-part="panel.changes.revertHunk" title={L.revertTitle} onClick={() => props.p.onRevertHunk?.(props.f.path, i(), key)}>
                                {L.revert}
                              </button>
                            </Show>
                          </div>
                        </td>
                      </tr>
                      <For each={h.rows}>{(o) => <Line o={o} c={ctx} />}</For>
                    </tbody>
                  </>
                );
              }}
            </For>
          </Show>
        </table>
      </div>
    </div>
  );
}

function FileRow(props: { readonly f: ChangeFile; readonly p: ChangesListProps }): JSX.Element {
  const L = props.p.labels;
  const opens = (): boolean => !props.f.binary && props.f.rows.length > 0;
  const isOpen = (): boolean => opens() && props.p.open(props.f.path);
  const seen = (): boolean => props.p.viewed(props.f.path);
  const stage = (): StageState | undefined => props.f.stage;
  return (
    <div data-kit="cx-file" data-part="changes.file" data-open={flag(isOpen())} data-viewed={flag(seen())} data-gone={flag(props.f.status === 'D')}>
      <div data-kit="cx-head">
        <button type="button" data-kit="cx-row" aria-expanded={isOpen()} title={props.f.from ?? props.f.path} disabled={!opens()} onClick={() => props.p.onToggle(props.f.path)}>
          <span data-kit="cx-chev">
            <Show when={opens()}>
              <Icon name="chevron" size="sm" />
            </Show>
          </span>
          <span data-kit="cx-badge" data-st={BADGE[props.f.status] ?? 'mod'}>
            {props.f.status in BADGE ? props.f.status : 'M'}
          </span>
          <Path path={props.f.path} />
        </button>
        <div data-kit="cx-acts">
          <span data-kit="cx-n" data-op="add">
            {props.f.add ? `+${props.f.add}` : ''}
          </span>
          <span data-kit="cx-n" data-op="del">
            {props.f.del ? `−${props.f.del}` : ''}
          </span>
          <Show when={stage() !== undefined}>
            <Show when={stage() !== 'none'} fallback={<span data-kit="cx-stage" data-none="" aria-hidden="true" />}>
              <button
                type="button"
                data-kit="cx-stage"
                data-part="panel.changes.stage"
                data-part-staged={flag(stage() === 'part')}
                aria-pressed={stage() === 'staged'}
                aria-label={`${stage() === 'staged' ? L.staged : L.stage} ${props.f.path}`}
                onClick={() => props.p.onStage?.(props.f.path, stage() === 'staged')}
              >
                <span data-kit="cx-box">
                  <Icon name="check" size="sm" />
                </span>
                <span>{stage() === 'staged' ? L.staged : stage() === 'part' ? L.part : L.stage}</span>
              </button>
            </Show>
          </Show>
          <button
            type="button"
            data-kit="cx-viewed"
            data-part="panel.changes.viewed"
            aria-pressed={seen()}
            title={L.viewedTitle(seen())}
            aria-label={`${L.viewed} ${props.f.path}`}
            onClick={() => props.p.onViewed(props.f.path)}
          >
            <span data-kit="cx-box">
              <Icon name="check" size="sm" />
            </span>
            <span>{L.viewed}</span>
          </button>
          <Show when={props.p.onEdit && props.f.status !== 'D' && !props.f.binary}>
            <button type="button" data-kit="cx-icon" data-part="panel.changes.edit" title={L.edit} aria-label={`${L.edit} ${props.f.path}`} onClick={() => props.p.onEdit?.(props.f.path)}>
              <Icon name="pen" />
            </button>
          </Show>
          <Show when={props.p.fileMenu}>
            {(menu) => (
              <WithAct
                act={menu()(props.f.path)}
                render={(trigger) => (
                  <button type="button" {...trigger()} data-kit="cx-icon" data-more="" title={L.more} aria-label={`${L.more} ${props.f.path}`}>
                    <Icon name="dots" />
                  </button>
                )}
              />
            )}
          </Show>
        </div>
      </div>
      <Show when={isOpen()}>
        <FileDiff f={props.f} p={props.p} />
      </Show>
    </div>
  );
}

function CommitRow(props: { readonly c: NonNullable<ChangesListProps['commit']>; readonly label: string }): JSX.Element {
  const [msg, setMsg] = createSignal('');
  const go = (): void => {
    props.c.onCommit(msg().trim() || props.c.placeholder);
    setMsg('');
  };
  return (
    <div data-kit="cx-commit" data-part="panel.changes.commit">
      <label data-kit="cx-cm-field">
        <input
          type="text"
          value={msg()}
          placeholder={props.c.placeholder}
          aria-label={props.c.placeholder}
          maxLength={500}
          autocomplete="off"
          onInput={(e) => setMsg(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              go();
            }
          }}
        />
        <span data-kit="cx-cm-n" title={props.c.countTitle}>
          {props.c.count}
        </span>
      </label>
      <button type="button" data-kit="cx-cm-go" onClick={go}>
        {props.label}
      </button>
    </div>
  );
}

export function ChangesList(props: ChangesListProps): JSX.Element {
  const L = props.labels;
  const add = (): number => props.files.reduce((n, f) => n + f.add, 0);
  const del = (): number => props.files.reduce((n, f) => n + f.del, 0);
  return (
    <section data-kit="cx" data-part={props.part ?? 'panel.changes'}>
      <div data-kit="cx-sum" data-part="panel.changes.summary">
        <span data-kit="cx-files">{L.files(props.files.length)}</span>
        <span data-kit="cx-plus">+{add()}</span>
        <span data-kit="cx-minus">−{del()}</span>
        <span data-kit="cx-vs" title={L.vsTitle}>
          {L.vs}
        </span>
        <span data-kit="cx-grow" />
        <Show when={L.viewedOf}>
          {(v) => (
            <span data-kit="cx-seen" data-part="panel.changes.viewedCount">
              {v()}
            </span>
          )}
        </Show>
        <button type="button" data-kit="cx-ghost" aria-pressed={props.allOpen} onClick={() => props.onAll()}>
          {props.allOpen ? L.collapseAll : L.expandAll}
        </button>
        <Show when={props.onFind && L.openFile}>
          <button type="button" data-kit="cx-ghost" data-part="panel.changes.open" title={L.openFileTitle} onClick={() => props.onFind?.()}>
            <Icon name="search" size="sm" />
            <span>{L.openFile}</span>
          </button>
        </Show>
      </div>
      <Show when={props.commit}>{(c) => <CommitRow c={c()} label={L.commit} />}</Show>
      <div data-kit="cx-list" data-part="panel.changes.list">
        <For each={props.files}>{(f) => <FileRow f={f} p={props} />}</For>
      </div>
    </section>
  );
}
