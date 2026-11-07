// Code: an inline chip (`<Code>npm test</Code>`) or a block (`<Code block lang="ts">…</Code>`)
// that scrolls sideways rather than wrap, with a small highlighter. The text is rendered as
// text, so code that looks like HTML stays code.
import { For, Show, createMemo, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { highlight } from './highlight.ts';

export interface CodeProps extends KitProps {
  /** The code, as text. */
  readonly children?: string;
  /** A block on its own lines instead of a chip in the text. */
  readonly block?: boolean;
  /** Block only: the language, for highlighting (`ts`, `sh`, `py`, …). */
  readonly lang?: string;
  /** Block only: a file name or label above the code. */
  readonly title?: string;
  /** Block only: wrap long lines instead of scrolling sideways. */
  readonly wrap?: boolean;
  /** Block only: leave it plain even when the language is known. */
  readonly plain?: boolean;
}

function CodeBlock(props: CodeProps & { readonly partName: PartName }): JSX.Element {
  const tokens = createMemo(() => (props.plain ? [{ kind: null, text: props.children ?? '' }] : highlight(props.children ?? '', props.lang)));
  return (
    <figure id={props.id} data-kit="code-block" data-part={props.partName}>
      <Show when={props.title}>
        {(title) => (
          <figcaption data-kit="code-title" data-part={sub(props.partName, 'title')}>
            {title()}
          </figcaption>
        )}
      </Show>
      {/* Focusable so a keyboard can scroll a long line into view. */}
      <pre data-kit="code-pre" data-wrap={flag(props.wrap)} tabIndex={0}>
        <code data-lang={props.lang || undefined}>
          <For each={tokens()}>{(tk) => (tk.kind ? <span data-tk={tk.kind}>{tk.text}</span> : tk.text)}</For>
        </code>
      </pre>
    </figure>
  );
}

export function Code(props: CodeProps): JSX.Element {
  return (
    <Show
      when={props.block}
      fallback={
        <code id={props.id} data-kit="code" data-part={props.part ?? 'ui.code'}>
          {props.children}
        </code>
      }
    >
      <CodeBlock {...props} partName={props.part ?? 'ui.code-block'} />
    </Show>
  );
}
