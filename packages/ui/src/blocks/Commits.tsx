// The `commits` block (v1 R.commits): the commits the agent made, newest first, on a line: the
// message (inline markdown), the short hash, files touched and +N −M. Titled by the branch.
import { createMemo, Show, type JSX } from 'solid-js';
import { useBlockT } from './context.tsx';
import { Counts } from './Files.tsx';
import { BlockTitle, Folded, InlineMd } from './content-parts.tsx';
import { shortHash } from './content-util.ts';
import { items, num, str } from './read.ts';
import type { BlockProps } from './types.ts';

export interface CommitRow {
  readonly hash: string;
  readonly message: string;
  readonly files: number | undefined;
  readonly add: number | undefined;
  readonly del: number | undefined;
}

export function readCommits(v: unknown): CommitRow[] {
  return items<CommitRow>(
    v,
    (o) => ({ hash: str(o['hash']), message: str(o['message']), files: num(o['files']), add: num(o['additions']), del: num(o['deletions']) }),
    (s) => ({ hash: '', message: s, files: undefined, add: undefined, del: undefined }),
  );
}

function CommitItem(props: { readonly c: CommitRow }): JSX.Element {
  const t = useBlockT();
  const files = (): string => {
    const n = props.c.files;
    return n === undefined || n <= 0 ? '' : t(n === 1 ? 'block.commits.file' : 'block.commits.files', { n });
  };
  return (
    <li data-kit="cb-commit" data-part="block.commits.item">
      <span data-kit="cb-commit-node" aria-hidden="true" />
      <div data-kit="cb-commit-text">
        <div data-kit="cb-commit-msg" data-part="block.commits.message">
          <InlineMd source={props.c.message} part="block.commits.message" />
        </div>
        <div data-kit="cb-commit-sub" data-part="block.commits.sub">
          <Show when={props.c.hash}>
            <code data-kit="cb-hash" data-part="block.commits.hash" data-text="control" title={props.c.hash}>{shortHash(props.c.hash)}</code>
          </Show>
          <Show when={files()}>
            <span data-kit="cb-commit-files" data-text="control">{files()}</span>
          </Show>
          <Counts part="block.commits.counts" add={props.c.add} del={props.c.del} />
        </div>
      </div>
    </li>
  );
}

export function CommitsBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const rows = createMemo(() => readCommits(props.block['items']));
  return (
    <div data-kit="cb-card" data-part="block.commits" data-type="commits">
      <BlockTitle part="block.commits.title" icon="branch" title={str(props.block['branch']) || t('block.commits.title')} count={rows().length} />
      <Folded items={rows()} limit={50} as="ol" kit="cb-commits" part="block.commits.list">
        {(c) => <CommitItem c={c} />}
      </Folded>
    </div>
  );
}
