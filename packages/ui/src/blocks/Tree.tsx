// The `tree` block (v1 R.tree): new modules and scaffolding as a nested file tree, folders first,
// a folder holding one folder shown as one row (`src/lib/`), each file with its change mark (A by
// default) and note. A file row opens the file (openFile). Past 120 rows the rest fold.
import { createMemo, Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { styleOf } from '../core/props.ts';
import { useBlocks } from './context.tsx';
import { BlockTitle, ChangeBadge, Folded, InlineMd } from './content-parts.tsx';
import { treeRows, type TreeItem, type TreeRow } from './content-tree.ts';
import { changeOf } from './content-util.ts';
import { items, str } from './read.ts';
import type { BlockProps } from './types.ts';

export function readTree(v: unknown): TreeItem[] {
  return items<TreeItem>(
    v,
    (o) => {
      const path = str(o['path']);
      return path ? { path, change: o['change'], note: str(o['note']) } : undefined;
    },
    (s) => ({ path: s, change: undefined, note: '' }),
  );
}

function RowBody(props: { readonly r: TreeRow }): JSX.Element {
  const change = (): ReturnType<typeof changeOf> | undefined => (props.r.item ? changeOf(props.r.item.change, 'added') : undefined);
  return (
    <>
      <Icon name={props.r.dir ? 'folder' : 'file'} size="md" tone="faint" />
      <span data-kit="cb-tree-name" data-part="block.tree.name" data-text="control" title={props.r.path}>
        {props.r.dir ? `${props.r.name}/` : props.r.name}
      </span>
      <Show when={change()}>{(c) => <ChangeBadge part="block.tree.change" mark={c().mark} kind={c().kind} />}</Show>
      <Show when={props.r.item?.note}>
        {(note) => (
          <span data-kit="cb-tree-note" data-part="block.tree.note">
            <InlineMd source={note()} part="block.tree.note" />
          </span>
        )}
      </Show>
    </>
  );
}

function TreeLine(props: { readonly r: TreeRow }): JSX.Element {
  const ctx = useBlocks();
  const opens = (): ((path: string) => void) | undefined => (props.r.dir ? undefined : ctx.openFile);
  return (
    <li data-kit="cb-tree-item" data-part="block.tree.item" data-dir={props.r.dir ? '' : undefined} style={styleOf({ '--k-depth': props.r.depth })}>
      <Show when={opens()} fallback={<span data-kit="cb-tree-row" data-part="block.tree.row"><RowBody r={props.r} /></span>}>
        {(open) => (
          <button type="button" data-kit="cb-tree-row" data-part="block.tree.row" onClick={() => open()(props.r.path)}>
            <RowBody r={props.r} />
          </button>
        )}
      </Show>
    </li>
  );
}

const LIMIT = 120;

export function TreeBlock(props: BlockProps): JSX.Element {
  const rows = createMemo(() => treeRows(readTree(props.block['items'])));
  const title = (): string => str(props.block['title']);
  return (
    <div data-kit="cb-card" data-part="block.tree" data-type="tree">
      <Show when={title()}>
        <BlockTitle part="block.tree.title" title={title()} />
      </Show>
      <Folded items={rows()} limit={LIMIT} as="ul" kit="cb-tree" part="block.tree.list">
        {(r) => <TreeLine r={r} />}
      </Folded>
    </div>
  );
}
