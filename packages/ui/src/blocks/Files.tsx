// The `files` block (v1 R.files): the files a turn touched, each with its change (A/M/D/R), its
// path (folder faint, name strong), +N −M when the row knows them, and the agent's note. A row
// that carries its diff folds it open under itself; Open in editor goes to the host (openFile).
// Past 50 rows the rest fold behind Show all.
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import { IconButton } from '../controls/Button.tsx';
import { Diff } from '../content/diff/Diff.tsx';
import type { DiffFile } from '../content/diff/parse.ts';
import { flag } from '../core/props.ts';
import { useBlocks, useBlockT } from './context.tsx';
import { ownDiff } from './content-diff.ts';
import { BlockTitle, ChangeBadge, Folded, InlineMd, PathText } from './content-parts.tsx';
import { changeOf, type ChangeKind } from './content-util.ts';
import { items, num, str } from './read.ts';
import type { BlockProps } from './types.ts';

export interface FileRow {
  readonly path: string;
  readonly mark: string;
  readonly kind: ChangeKind;
  readonly note: string;
  readonly add: number | undefined;
  readonly del: number | undefined;
  readonly diff: DiffFile | undefined;
}

export function readFiles(v: unknown): FileRow[] {
  return items<FileRow>(
    v,
    (o) => {
      const path = str(o['path']) || str(o['file']);
      if (!path) return undefined;
      const diff = ownDiff(o, path);
      const { mark, kind } = changeOf(o['change'], 'modified');
      return { path, mark, kind, note: str(o['note']), add: num(o['additions']) ?? diff?.additions, del: num(o['deletions']) ?? diff?.deletions, diff };
    },
    (s) => ({ path: s, ...changeOf(undefined, 'modified'), note: '', add: undefined, del: undefined, diff: undefined }),
  );
}

/** +N −M, tabular; each only when the row knows it. */
export function Counts(props: { readonly add: number | undefined; readonly del: number | undefined; readonly part: `${string}.${string}` }): JSX.Element {
  return (
    <Show when={props.add !== undefined || props.del !== undefined}>
      <span data-kit="cb-nums" data-part={props.part}>
        <Show when={props.add !== undefined}>
          <span data-kit="cb-plus" data-text="control">{`+${props.add ?? 0}`}</span>
        </Show>
        <Show when={props.del !== undefined}>
          <span data-kit="cb-minus" data-text="control">{`−${props.del ?? 0}`}</span>
        </Show>
      </span>
    </Show>
  );
}

function FileItem(props: { readonly f: FileRow }): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const [open, setOpen] = createSignal(false);
  const toggle = (): void => {
    if (props.f.diff) setOpen(!open());
  };
  return (
    <li data-kit="cb-file" data-part="block.files.item" data-open={flag(open())} data-has-diff={flag(props.f.diff !== undefined)}>
      <div data-kit="cb-file-row" data-part="block.files.row" onClick={toggle}>
        <ChangeBadge part="block.files.change" mark={props.f.mark} kind={props.f.kind} />
        <PathText part="block.files.path" path={props.f.path} />
        <Counts part="block.files.counts" add={props.f.add} del={props.f.del} />
        <span data-kit="cb-file-actions" data-part="block.files.actions">
          <Show when={props.f.diff}>
            <IconButton size="xs" icon="chevron" label={open() ? t('block.files.hideDiff') : t('block.files.showDiff')} expanded={open()} onClick={(e) => (e.stopPropagation(), toggle())} part="block.files.toggle" />
          </Show>
          <Show when={ctx.openFile}>
            {(openFile) => <IconButton size="xs" icon="external" label={t('block.content.openFile')} onClick={(e) => (e.stopPropagation(), openFile()(props.f.path))} part="block.files.open" />}
          </Show>
        </span>
      </div>
      <Show when={props.f.note}>
        <p data-kit="cb-file-note" data-part="block.files.note">
          <InlineMd source={props.f.note} part="block.files.note" />
        </p>
      </Show>
      <Show when={open() && props.f.diff}>
        {(d) => (
          <div data-kit="cb-file-diff" data-part="block.files.diff">
            <Diff part="block.files.diff.body" files={[d()]} />
          </div>
        )}
      </Show>
    </li>
  );
}

const LIMIT = 50;

export function FilesBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const rows = createMemo(() => readFiles(props.block['items']));
  return (
    <div data-kit="cb-card" data-part="block.files" data-type="files">
      <BlockTitle part="block.files.title" title={str(props.block['title']) || t('block.files.title')} count={rows().length} />
      <Folded items={rows()} limit={LIMIT} as="ul" kit="cb-files" part="block.files.list">
        {(f) => <FileItem f={f} />}
      </Folded>
    </div>
  );
}
