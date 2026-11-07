// The `callout` block (v1 R.callout): what the user must act on or might get wrong, in one of four
// tones, through the kit's Callout. Its text is markdown.
import type { JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { Callout } from '../composites/Banner.tsx';
import type { IconName } from '../content/icons.ts';
import { Markdown } from '../content/markdown/Markdown.tsx';
import { useBlocks } from './context.tsx';
import { oneOf, opt, str } from './read.ts';
import type { BlockProps } from './types.ts';

const TONES = ['info', 'success', 'warn', 'danger'] as const;
type CalloutTone = (typeof TONES)[number];
const KIT_TONE: Readonly<Record<CalloutTone, Tone>> = { info: 'info', success: 'good', warn: 'warn', danger: 'bad' };
const ICON: Readonly<Record<CalloutTone, IconName>> = { info: 'info', success: 'check', warn: 'warn', danger: 'x' };

export function CalloutBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const tone = (): CalloutTone => oneOf(props.block['tone'], TONES, 'info');
  const onLink = (href: string, e: MouseEvent): void => {
    if (!ctx.openUrl || href.startsWith('#')) return;
    e.preventDefault();
    ctx.openUrl(href);
  };
  const title = opt(props.block['title']);
  return (
    <div data-kit="cb-callout" data-part="block.callout" data-tone={tone()}>
      <Callout part="block.callout.box" tone={KIT_TONE[tone()]} icon={ICON[tone()]} {...(title === undefined ? {} : { title })}>
        <Markdown source={str(props.block['text'])} onLink={onLink} part="block.callout.text" />
      </Callout>
    </div>
  );
}
