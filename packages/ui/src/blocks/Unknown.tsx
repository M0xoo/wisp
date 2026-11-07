// A block this app can't draw (plan §7.3.2 rule 4): shown safely as its JSON, never dropped, with
// the one thing the reader can do about it. Also what a block that threw falls back to.
import type { JSX } from 'solid-js';
import { Code } from '../content/Code.tsx';
import { useBlockT } from './context.tsx';
import { str } from './read.ts';
import type { BlockProps } from './types.ts';

export function UnknownBlock(props: BlockProps & { readonly failed?: boolean }): JSX.Element {
  const t = useBlockT();
  const json = (): string => {
    try {
      return JSON.stringify(props.block, null, 2) ?? '';
    } catch {
      return String(props.block.type);
    }
  };
  return (
    <div data-kit="answer-unknown" data-part="block.unknown">
      <div data-kit="answer-unknown-note" data-part="block.unknown.note">
        {props.failed ? t('block.failed') : t('block.unknown')}
      </div>
      <Code block lang="json" title={t('block.unknownType', { type: str(props.block.type) || '?' })}>
        {json()}
      </Code>
    </div>
  );
}
