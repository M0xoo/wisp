// A `code` or `diff` block about a .env file (v1 blocks.js R.code / R.diff with `masked`): its values read KEY=••••
// under a line that says so, Reveal there shows this one block as it is, Hide masks it again, in place. The host's
// `env` keeps what's shown per task; a host without one (a share page) keeps it in the block.
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import { EnvMask, envName } from '../content/EnvMask.tsx';
import { maskBlock } from '../content/env-mask.ts';
import type { PartName } from '../core/props.ts';
import { useBlocks, useBlockT } from './context.tsx';
import type { AnswerBlock, BlockProps } from './types.ts';

export interface EnvView {
  /** the block as it shows: masked, or as the agent wrote it */
  readonly block: () => AnswerBlock;
  /** the line over it (nothing for any other file, or with masking off) */
  readonly bar: () => JSX.Element;
}

export function useEnvView(props: BlockProps, part: PartName): EnvView {
  const ctx = useBlocks();
  const t = useBlockT();
  const id = (): string => `block:${props.index}`;
  const [own, setOwn] = createSignal(false);
  const shown = (): boolean => (ctx.env ? ctx.env.shown(id()) : own());
  const masked = createMemo(() => (ctx.env?.on() ?? true ? maskBlock(props.block) : undefined));
  const name = (): string => envName(props.block['file'] ?? props.block['path']);
  return {
    block: () => (masked() && !shown() ? (masked() as AnswerBlock) : props.block),
    bar: () => (
      <Show when={masked()}>
        <EnvMask
          part={part}
          shown={shown()}
          what={t(shown() ? 'block.env.shown' : 'block.env.hidden', { name: name() })}
          action={t(shown() ? 'block.env.hide' : 'block.env.reveal')}
          onToggle={(on) => (ctx.env ? ctx.env.set(id(), on) : setOwn(on))}
        />
      </Show>
    ),
  };
}
