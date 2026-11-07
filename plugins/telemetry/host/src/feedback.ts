// Feedback for the wisp team: thumbs on a turn and/or a note (v1 server/services/feedback.js). A rating
// sticks to its turn (it shows on the card and can be taken back). What goes out is the rating, the
// user's own words and how the run was set up, never the prompt or the result.
import type { Json } from '@wisp/kernel';
import { splitId, type MachinesService } from '@wisp-plugin/machines-api';
import { COMMANDS, type Session, type Turn } from '@wisp-plugin/runtime-api';
import type { FeedbackArgs, FeedbackResult, Props, RatedEvent, Rating, TurnFeedback } from '@wisp-plugin/telemetry-api';
import { EVENTS, TELEMETRY_ID } from '@wisp-plugin/telemetry-api';
import { bad, record } from './kernel.ts';
import type { Telemetry } from './telemetry.ts';
import { blocksOf, blockTypes, heroStatus, runProps } from './turns.ts';

export interface FeedbackDeps {
  telemetry: Telemetry;
  /** runs a command for the caller of the route */
  run<R>(cmd: string, args: unknown): Promise<R>;
  emit(type: string, data: Json): void;
  /** wisp.machines, when it is on */
  machines(): MachinesService | undefined;
  now(): number;
}

/** The body, checked as v1 checked it. */
export function parseFeedback(body: unknown): FeedbackArgs {
  const b = record(body);
  const rating = b['rating'];
  if (rating !== undefined && rating !== null && rating !== 'up' && rating !== 'down') throw bad('rating must be up or down');
  const kind = b['kind'];
  if (kind !== undefined && kind !== null && kind !== 'bug' && kind !== 'idea') throw bad('kind must be bug or idea');
  const text = String(b['text'] || '').trim();
  if (kind === 'bug' && !text) throw bad('Say what happened, so the team can fix it.');
  if (rating === undefined && !text) throw bad('Write something, or pick 👍 / 👎.');
  const opt = (k: string): string | undefined => (b[k] === undefined || b[k] === null || b[k] === '' ? undefined : String(b[k]));
  const sessionId = opt('sessionId');
  const turnId = opt('turnId');
  const source = opt('source');
  return { text, ...(rating !== undefined && { rating }), ...(kind !== undefined && { kind }), ...(sessionId && { sessionId }), ...(turnId && { turnId }), ...(source && { source }) };
}

const peerFailed = (err: unknown): boolean => record(err)['status'] === 400 || record(err)['code'] === 'invalid';

async function local(d: FeedbackDeps, a: FeedbackArgs): Promise<{ s: Session | null; turn: Turn | undefined }> {
  if (!a.sessionId) return { s: null, turn: undefined };
  const s = await d.run<Session>(COMMANDS.get, { id: a.sessionId }).catch(() => null);
  if (!s) throw bad('no such session', 404);
  const turns = await d.run<Turn[]>(COMMANDS.turns, { id: s.id });
  const turn = a.turnId ? turns.find((t) => t.id === a.turnId) : turns.reduce<Turn | undefined>((last, t) => (!last || t.idx > last.idx ? t : last), undefined);
  if (a.turnId && !turn) throw bad('no such turn', 404);
  return { s, turn };
}

function context(s: Session | null, turn: Turn | undefined): Props {
  if (!s || !turn) return {};
  const blocks = blocksOf(turn);
  return {
    ...runProps(s, turn),
    status: turn.status,
    heroStatus: heroStatus(blocks),
    blockTypes: blockTypes(blocks),
    durationMs: turn.endedAt ? turn.endedAt - turn.startedAt : undefined,
    tour: s.agent === 'wisp' || undefined,
  };
}

export async function sendFeedback(d: FeedbackDeps, a: FeedbackArgs): Promise<FeedbackResult> {
  const at = a.sessionId ? splitId(a.sessionId) : null;
  if (a.sessionId && a.turnId && a.rating !== undefined) d.emit(EVENTS.rated, { sessionId: a.sessionId, turnId: a.turnId, rating: a.rating } satisfies RatedEvent);
  // A session on a machine: that wisp keeps the rating on its turn and sends it.
  const peers = at ? d.machines() : undefined;
  if (at && peers) {
    try {
      return await peers.json<FeedbackResult>(at.machine, 'POST', '/feedback', { ...a, sessionId: at.id });
    } catch (err) {
      if (peerFailed(err)) throw err; // offline, or an older wisp there: send it from here, without the run
    }
  }
  const { s, turn } = at ? { s: null, turn: undefined } : await local(d, a);
  // Only thumbs on a turn stick to it; a rating in the feedback dialog is about wisp as a whole.
  if (s && turn && a.turnId && a.rating !== undefined) {
    const value: TurnFeedback | null = a.rating ? { feedback: { rating: a.rating, at: d.now() } } : null;
    await d.run(COMMANDS.turnExt, { id: s.id, turnId: turn.id, plugin: TELEMETRY_ID, value });
  }
  const rating: Rating | undefined = a.rating || undefined;
  const props: Props = { ...context(s, turn), rating, kind: a.kind || undefined, source: String(a.source || (turn ? 'turn' : 'app')).slice(0, 20), machine: at ? true : undefined };
  // Thumbs on a turn count as a rating; anything written, or sent from the dialog, is 'feedback'.
  const event = a.text || !a.turnId ? 'feedback' : 'turn_rated';
  if (event === 'turn_rated' && a.rating === null) props['cleared'] = true;
  const sent = await d.telemetry.feedback(event, { ...props, text: a.text || undefined });
  return { ok: true, sent, available: d.telemetry.feedbackAvailable };
}
