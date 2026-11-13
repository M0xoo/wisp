// The `code` block (v1 R.code): a key snippet with its line numbers (from `line`), the lines it
// points at highlighted, and the file it's from (opening it at that line), or its language. Copy
// takes the code. A .env file's values show masked under a Reveal line (./env-view.tsx). A long
// snippet lays out only its lines near the screen.
import { createMemo, For, Show, type JSX } from 'solid-js';
import { highlight, type Token } from '../content/highlight.ts';
import { flag } from '../core/props.ts';
import { useBlocks, useBlockT } from './context.tsx';
import { CopyButton } from './content-copy.tsx';
import { InlineMd, PathText } from './content-parts.tsx';
import { chunksOf, langOf } from './content-util.ts';
import { useEnvView } from './env-view.tsx';
import { list, num, str } from './read.ts';
import type { BlockProps } from './types.ts';

/** The code's tokens split into lines; a token that spans lines (a block comment) is cut at each. */
export function tokenLines(code: string, lang: string): Token[][] {
  const lines: Token[][] = [[]];
  for (const tk of highlight(code, lang)) {
    const parts = tk.text.split('\n');
    parts.forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines[lines.length - 1]?.push({ kind: tk.kind, text });
    });
  }
  return lines;
}

const CHUNK = 100;

interface Line {
  readonly no: number;
  readonly tokens: Token[];
  readonly hl: boolean;
}

function CodeHead(props: { readonly file: string; readonly line: number | undefined; readonly lang: string; readonly code: () => string }): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const label = (): JSX.Element => (
    <>
      <PathText part="block.code.path" path={props.file} />
      <Show when={props.line !== undefined}>
        <span data-kit="cb-lineno" data-text="control">{`:${props.line ?? ''}`}</span>
      </Show>
    </>
  );
  return (
    <div data-kit="cb-code-head" data-part="block.code.head">
      <Show when={props.file} fallback={<span data-kit="cb-lang" data-part="block.code.lang" data-text="control">{props.lang || t('block.code.label')}</span>}>
        <Show when={ctx.openFile} fallback={<span data-kit="cb-code-file" data-part="block.code.file">{label()}</span>}>
          {(open) => (
            <button type="button" data-kit="cb-code-file" data-part="block.code.file" onClick={() => open()(props.file, props.line)}>
              {label()}
            </button>
          )}
        </Show>
      </Show>
      <CopyButton part="block.code.copy" text={props.code} />
    </div>
  );
}

export function CodeBlock(props: BlockProps): JSX.Element {
  // a .env file's values masked until Reveal (copy takes what shows)
  const env = useEnvView(props, 'block.code.envMask');
  const code = (): string => str(env.block()['code']).replace(/\n$/, '');
  const file = (): string => str(props.block['file']);
  const line = (): number | undefined => {
    const n = num(props.block['line']);
    return n !== undefined && n >= 1 ? Math.floor(n) : undefined;
  };
  const lang = (): string => str(props.block['language']) || langOf(file());
  const lines = createMemo((): Line[] => {
    const hl = new Set(list(props.block['highlight']).map(num));
    const start = line() ?? 1;
    return tokenLines(code(), lang()).map((tokens, i) => ({ no: start + i, tokens, hl: hl.has(i + 1) }));
  });
  const caption = (): string => str(props.block['caption']);
  return (
    <div data-kit="cb-code" data-part="block.code">
      <CodeHead file={file()} line={line()} lang={lang()} code={code} />
      {env.bar()}
      <div data-kit="cb-code-scroll" data-part="block.code.body" tabIndex={0}>
        <div data-kit="cb-code-lines" data-lang={lang() || undefined}>
          <For each={chunksOf(lines(), CHUNK)}>
            {(chunk) => (
              <div data-kit="cb-code-chunk" data-lazy={flag(lines().length > CHUNK * 2)}>
                <For each={chunk}>
                  {(l) => (
                    <div data-kit="cb-code-line" data-hl={flag(l.hl)}>
                      <span data-kit="cb-code-no">{l.no}</span>
                      <span data-kit="cb-code-src">
                        <For each={l.tokens}>{(tk) => (tk.kind ? <span data-tk={tk.kind}>{tk.text}</span> : tk.text)}</For>
                        {l.tokens.length ? '' : ' '}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={caption()}>
        <p data-kit="cb-caption" data-part="block.code.caption">
          <InlineMd source={caption()} part="block.code.caption" />
        </p>
      </Show>
    </div>
  );
}
