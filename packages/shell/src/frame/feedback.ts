// Feedback for the wisp team (v1 features/feedback.js): `/feedback …` or `/bug …` in any prompt box sends at once
// (no words: the dialog opens), the dialog (⌘K Send feedback…, Home's foot) sends an idea or a bug, and thumbs on a
// turn (rateTurn). It goes with the harness and model, never the prompt or the code.
import { defineCommand, ownerOf, type PeerId } from '@wisp/client';
import type { ShellContext } from '../contract.ts';

const FEEDBACK_CMD = /^\/(feedback|bug)(?:\s|$)/i;

/** The text is `/feedback …` or `/bug …`. */
export const isFeedback = (text: string): boolean => FEEDBACK_CMD.test(text.trim());

/** What `/feedback …` or `/bug …` says: a bug or an idea, and the words (empty: open the dialog). */
export function feedbackOf(text: string): { readonly kind: 'bug' | 'idea'; readonly note: string } {
  const t = text.trim();
  const m = FEEDBACK_CMD.exec(t);
  return { kind: m?.[1]?.toLowerCase() === 'bug' ? 'bug' : 'idea', note: t.replace(FEEDBACK_CMD, '').trim() };
}

export interface FeedbackArgs {
  readonly peer: PeerId;
  readonly text: string;
  readonly kind?: 'bug' | 'idea';
  readonly rating?: 'up' | 'down';
  readonly sessionId?: string;
  readonly source: 'command' | 'dialog';
}

/** A note to the wisp team, through this wisp (the thanks shows at once; a refusal puts the words back). */
export const sendFeedback = defineCommand<FeedbackArgs, { ok: boolean; sent: boolean; available: boolean }>({
  id: 'telemetry.feedback',
  owner: (a) => a.peer,
  wire: (a) => ({
    text: a.text,
    source: a.source,
    ...(a.kind === 'bug' && { kind: 'bug' }),
    ...(a.kind !== 'bug' && a.rating && { rating: a.rating }),
    ...(a.sessionId && { sessionId: a.sessionId.slice(a.sessionId.indexOf(':') + 1) }),
  }),
  optimistic: 'none',
  pending: 'the dialog closes with a thank-you at once',
});

/** The dialog can send: a bug needs words, an idea words or a thumb. */
export const canSend = (kind: 'bug' | 'idea', rating: 'up' | 'down' | undefined, text: string): boolean => text.trim() !== '' || (kind !== 'bug' && rating !== undefined);

export interface FeedbackParams {
  readonly text?: string;
  readonly kind?: 'bug' | 'idea';
  readonly sessionId?: string;
  readonly source?: 'command' | 'dialog';
}

export function parseFeedback(p: unknown): FeedbackParams {
  const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
  return {
    ...(typeof o['text'] === 'string' && { text: o['text'] }),
    ...(o['kind'] === 'bug' && { kind: 'bug' as const }),
    ...(typeof o['sessionId'] === 'string' && { sessionId: o['sessionId'] }),
    ...(o['source'] === 'command' && { source: 'command' as const }),
  };
}

/** Opens Send feedback (⌘K, Home's foot, `/feedback` with no words). */
export function openFeedback(shell: ShellContext, params: { readonly kind?: 'bug' | 'idea'; readonly text?: string; readonly sessionId?: string; readonly source?: 'command' | 'dialog' } = {}): void {
  shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.feedback' as never, params } });
}

/** `/feedback …` or `/bug …` typed in a prompt box (the box is already empty): sent at once with a thank-you; no
 *  words opens the dialog; a refusal puts the text back (`restore`) and says why. */
export function feedbackCommand(shell: ShellContext, text: string, o: { readonly home: PeerId; readonly sessionId?: string; readonly restore: () => void }): void {
  const { kind, note } = feedbackOf(text);
  if (!note) return openFeedback(shell, { kind, source: 'command', ...(o.sessionId && { sessionId: o.sessionId }) });
  shell.toast.success(shell.t('shell.feedback.thanks'));
  void shell.client.commands
    .run(sendFeedback, { peer: o.sessionId ? ownerOf(o.sessionId) : o.home, text: note, kind, source: 'command', ...(o.sessionId && { sessionId: o.sessionId }) })
    .catch((e: unknown) => {
      o.restore();
      shell.toast.error(e instanceof Error ? e.message : String(e));
    });
}
