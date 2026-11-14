// Comments on one turn's answer (v1 comments.js, F-page-10): what the kit's Answer asks of its host (BlockContext
// `comment`), answered by the prompt source that keeps comments (`PromptSourceDef.answer`: wisp.shell-task's, with
// the line comments of Changes), looked up when asked.
import type { AnswerComments } from '@wisp/ui';
import { useSignal } from '@wisp/ui';
import type { PromptSourceDef, ShellContext } from '../contract.ts';
import { blockLabel } from './comment-text.ts';

export function answerComments(o: {
  readonly shell: ShellContext;
  readonly client: (plugin: string) => ReturnType<ShellContext['client']['plugin']>;
  readonly task: string;
  readonly turn: string;
  /** this answer's prompt when it isn't the latest (the agent is told which answer it was on), else undefined */
  readonly of: () => string | undefined;
}): AnswerComments {
  // looked up on each read: a plugin's UI that registers after this turn drew still gets its comments
  const src = (): (PromptSourceDef & { plugin?: string }) | undefined => o.shell.promptSources()().find((p) => p.answer);
  const ctx = (p: PromptSourceDef & { plugin?: string }): { client: ReturnType<ShellContext['client']['plugin']>; task: string } => ({ client: o.client(p.plugin ?? 'shell'), task: o.task });
  // the source's store is a client signal: read through useSignal so the answer's marks follow it
  const marks = useSignal(() => {
    const p = src();
    return p?.answer?.marks(o.turn, ctx(p)) ?? [];
  });
  const all = useSignal(() => {
    const p = src();
    return p ? (p.waiting?.(ctx(p)) ?? 0) : 0;
  });
  return {
    marks,
    next: () => all() + 1,
    label: (at) => blockLabel(at.block),
    add: (at, note) => {
      const p = src();
      if (!p?.answer) return;
      const of = o.of();
      p.answer.add({ turn: o.turn, i: at.i, label: blockLabel(at.block), kind: at.quote ? 'text' : 'block', ...(at.quote && { quote: at.quote }), note, ...(of && { of }) }, ctx(p));
    },
  };
}
