// Answer: a turn's presentation, block by block, in one calm column (v1 renderPresentation). Each
// block is drawn by the host's renderer for its type, else the kit's, else UnknownBlock; a block
// that throws becomes UnknownBlock too, so one bad block never takes the answer down. The first
// time an answer is shown its blocks rise one after another (110 ms apart, the first 10); shown
// again (`reveal: false`) nothing moves.
import { ErrorBoundary, Index, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { flag, styleOf, sub, type KitProps, type PartName } from '../core/props.ts';
import { BlockHost, useBlockT } from './context.tsx';
import { BLOCKS } from './registry.ts';
import type { AnswerBlock, BlockContext, BlockRenderer } from './types.ts';
import { UnknownBlock } from './Unknown.tsx';

export interface AnswerProps extends KitProps {
  /** the presentation's blocks, as the agent wrote them */
  readonly blocks: readonly unknown[];
  readonly ctx?: BlockContext;
  /** the agent answered in plain text: the note above the blocks says so */
  readonly fallback?: boolean;
}

const STEP_MS = 110;
const MAX_STEPS = 10;

/** An entry that isn't an object with a string `type` is still shown, as unknown. */
export function asBlock(v: unknown): AnswerBlock {
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string') return v as AnswerBlock;
  return { type: '?', value: v };
}

export function rendererFor(type: string, ctx: BlockContext | undefined): BlockRenderer | undefined {
  return ctx?.renderers?.[type] ?? (Object.hasOwn(BLOCKS, type) ? BLOCKS[type] : undefined);
}

function FallbackNote(): JSX.Element {
  const t = useBlockT();
  return (
    <div data-kit="answer-note" data-part="answer.fallback">
      {t('block.fallback')}
    </div>
  );
}

export function Answer(props: AnswerProps): JSX.Element {
  const part = (): PartName => props.part ?? 'answer.blocks';
  const reveal = (): boolean => props.ctx?.reveal !== false;
  return (
    <BlockHost ctx={props.ctx ?? {}}>
      <div id={props.id} data-kit="answer" data-part={part()} data-still={flag(!reveal())}>
        <Show when={props.fallback}>
          <FallbackNote />
        </Show>
        <Index each={props.blocks}>
          {(raw, i) => {
            const block = (): AnswerBlock => asBlock(raw());
            return (
              <div
                data-kit="answer-block"
                data-part={sub(part(), 'block')}
                data-type={block().type}
                data-i={i}
                style={styleOf({ '--k-answer-d': reveal() ? `${Math.min(i, MAX_STEPS) * STEP_MS}ms` : undefined })}
              >
                <ErrorBoundary fallback={() => <UnknownBlock block={block()} index={i} failed />}>
                  <Show when={rendererFor(block().type, props.ctx)} keyed fallback={<UnknownBlock block={block()} index={i} />}>
                    {(r) => <Dynamic component={r} block={block()} index={i} />}
                  </Show>
                </ErrorBoundary>
              </div>
            );
          }}
        </Index>
      </div>
    </BlockHost>
  );
}
