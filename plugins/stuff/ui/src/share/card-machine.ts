// The pasted link's card as a flow (v1 shareCard's state: off | loading | open | locked | error).
// A new link in the box starts it over; an answer for a link that's gone is dropped (the machine
// leaves the state, which aborts its peek). Unlocking keeps the locked card on screen while it asks.

import { machine } from '@wisp/client';
import type { ShareCardInfo } from './types.ts';

export type CardState = 'off' | 'loading' | 'open' | 'locked' | 'unlocking' | 'error';
export type CardEvent = 'link' | 'clear' | 'unlock' | 'opened' | 'locked' | 'failed';

export interface CardCtx {
  /** the link in the box now, and the passkey typed on the card */
  link: string;
  passkey: string;
  peek(link: string, passkey: string): Promise<ShareCardInfo>;
  /** what the last answer said: the card, or the error's words */
  card: ShareCardInfo | undefined;
  error: string;
}

const ask = async (ctx: CardCtx, signal: AbortSignal): Promise<CardEvent | void> => {
  try {
    const c = await ctx.peek(ctx.link, ctx.passkey);
    if (signal.aborted) return;
    ctx.card = c;
    return c.open ? 'opened' : 'locked';
  } catch (err) {
    if (signal.aborted) return;
    ctx.error = err instanceof Error ? err.message : String(err);
    return 'failed';
  }
};

const answered = { link: 'loading', clear: 'off' } as const;

export const cardMachine = machine<CardState, CardEvent, CardCtx>({
  id: 'stuff.share-card',
  initial: 'off',
  states: {
    off: { on: { link: 'loading' } },
    loading: { on: { ...answered, opened: 'open', locked: 'locked', failed: 'error' }, invoke: (ctx, signal) => ask(ctx, signal) },
    open: { on: answered },
    locked: { on: { ...answered, unlock: 'unlocking' } },
    unlocking: { on: { ...answered, opened: 'open', locked: 'locked', failed: 'error' }, invoke: (ctx, signal) => ask(ctx, signal) },
    error: { on: answered },
  },
});
