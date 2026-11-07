// The `diff` block (v1 R.diff): the real change to one file, through the kit's Diff (its header
// shows the path and +N −M). The block carries it as `diff` (a unified diff) or as a hand-picked
// `before`/`after`; the host fills `diff` from the edits wisp captured. With neither it says there
// are no captured edits. The caption and Open in editor sit under it.
import { createMemo, Show, type JSX } from 'solid-js';
import { Button } from '../controls/Button.tsx';
import { Diff } from '../content/diff/Diff.tsx';
import { Icon } from '../content/Icon.tsx';
import { useBlocks, useBlockT } from './context.tsx';
import { ownDiff } from './content-diff.ts';
import { InlineMd, PathText } from './content-parts.tsx';
import { str } from './read.ts';
import type { BlockProps } from './types.ts';

export function DiffBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const file = (): string => str(props.block['file']) || str(props.block['path']);
  const diff = createMemo(() => ownDiff(props.block, file()));
  const path = (): string => diff()?.path || file();
  const caption = (): string => str(props.block['caption']);
  return (
    <div data-kit="cb-diff" data-part="block.diff" data-missing={diff() ? undefined : ''}>
      <Show
        when={diff()}
        fallback={
          <div data-kit="cb-card" data-type="diff-missing" data-part="block.diff.missing">
            <div data-kit="cb-diff-missing-head">
              <Icon name="file" size="md" tone="faint" />
              <PathText part="block.diff.path" path={path()} />
            </div>
            <p data-kit="cb-muted">{t('block.diff.missing')}</p>
          </div>
        }
      >
        {(d) => <Diff part="block.diff.body" files={[d()]} />}
      </Show>
      <Show when={caption() || (ctx.openFile && path())}>
        <div data-kit="cb-diff-foot" data-part="block.diff.foot">
          <p data-kit="cb-caption" data-part="block.diff.caption">
            <InlineMd source={caption()} part="block.diff.caption" />
          </p>
          <Show when={ctx.openFile && path() ? ctx.openFile : undefined}>
            {(openFile) => (
              <Button variant="ghost" size="xs" icon="external" onClick={() => openFile()(path())} part="block.diff.open">
                {t('block.content.openFile')}
              </Button>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
