// The `markdown` block (v1 R.markdown): GitHub-flavoured markdown through the kit's Markdown, which
// renders text, never HTML. A very long answer lays out only its parts near the screen (v1
// chunked; content-visibility in answer-content.css), so opening it never freezes the page.
// Links go to the host's openUrl when it has one.
import type { JSX } from 'solid-js';
import { Markdown } from '../content/markdown/Markdown.tsx';
import { flag } from '../core/props.ts';
import { useBlocks } from './context.tsx';
import { str } from './read.ts';
import type { BlockProps } from './types.ts';

/** Past this many lines the block's parts render lazily (v1: 120 top-level children). */
const LONG_LINES = 400;

export function MarkdownBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const text = (): string => str(props.block['text']);
  const long = (): boolean => {
    let n = 0;
    for (let i = text().indexOf('\n'); i >= 0 && n <= LONG_LINES; i = text().indexOf('\n', i + 1)) n++;
    return n > LONG_LINES;
  };
  const onLink = (href: string, e: MouseEvent): void => {
    if (!ctx.openUrl || href.startsWith('#')) return;
    e.preventDefault();
    ctx.openUrl(href);
  };
  return (
    <div data-kit="cb-md" data-part="block.markdown" data-long={flag(long())}>
      <Markdown source={text()} onLink={onLink} part="block.markdown.body" />
    </div>
  );
}
