// The `preview` block (v1 web/js/blocks.js R.preview). Stub: drawn as unknown until it is built.
import type { JSX } from 'solid-js';
import { UnknownBlock } from './Unknown.tsx';
import type { BlockProps } from './types.ts';

export function PreviewBlock(props: BlockProps): JSX.Element {
  return <UnknownBlock block={props.block} index={props.index} />;
}
