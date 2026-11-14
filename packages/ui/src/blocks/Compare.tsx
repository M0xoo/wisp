// The `compare` block (v1 R.compare): before and after side by side with an arrow between; each side a list
// (− before, + after), markdown text, or code. Stacks on a narrow box.
import { For, Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Markdown } from '../content/markdown/Markdown.tsx';
import { InlineMd } from './content-parts.tsx';
import { useBlockT } from './context.tsx';
import { list, obj, opt, str } from './read.ts';
import type { BlockProps } from './types.ts';

function Side(props: { readonly side: Readonly<Record<string, unknown>>; readonly kind: 'before' | 'after' }): JSX.Element {
  const t = useBlockT();
  const items = (): string[] => list(props.side['items']).map(str).filter(Boolean);
  return (
    <div data-kit="cb-compare-side" data-part={`block.compare.${props.kind}`} data-side={props.kind}>
      <div data-kit="cb-compare-label">{opt(props.side['label']) ?? t(props.kind === 'before' ? 'block.compare.before' : 'block.compare.after')}</div>
      <Show when={items().length > 0}>
        <ul data-kit="cb-compare-list">
          <For each={items()}>
            {(text, i) => (
              <li style={{ '--k': String(i()) }}>
                <Icon name={props.kind === 'before' ? 'minus' : 'plus'} size="sm" />
                <span>
                  <InlineMd source={text} part="block.compare.item" />
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={opt(props.side['text'])}>{(text) => <Markdown source={text()} part="block.compare.text" />}</Show>
      <Show when={opt(props.side['code'])}>
        {(code) => (
          <pre data-kit="cb-compare-code">
            <code>{code()}</code>
          </pre>
        )}
      </Show>
    </div>
  );
}

export function CompareBlock(props: BlockProps): JSX.Element {
  return (
    <div data-kit="cb-compare" data-part="block.compare">
      <Side side={obj(props.block['before'])} kind="before" />
      <div data-kit="cb-compare-arrow" aria-hidden="true">
        <Icon name="arrow" />
      </div>
      <Side side={obj(props.block['after'])} kind="after" />
    </div>
  );
}
