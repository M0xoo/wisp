// Feedback for the wisp team: thumbs on a turn and/or a note.
// A rating sticks to its turn (it shows on the card and can be taken back). What goes out is
// the rating, the user's own words, and how the run was set up — never the prompt or the result.

import { splitId } from '../machines.js';
import { feedbackAvailable } from '../telemetry.js';
import { bad } from '../util.js';
import { runProps } from './telemetry.js';

export function createFeedback(app) {
  const { store, machines, telemetry } = app;

  return async function sendFeedback({ rating, text, sessionId, turnId, source } = {}) {
    if (rating !== undefined && rating !== null && rating !== 'up' && rating !== 'down') throw bad('rating must be up or down');
    text = String(text || '').trim();
    if (rating === undefined && !text) throw bad('Write something, or pick 👍 / 👎.');
    // A session on a machine: that wisp keeps the rating on its turn and sends it.
    const at = sessionId && splitId(sessionId);
    if (sessionId && turnId && rating !== undefined) app.router.signal(sessionId, { feedback: rating });
    if (at) {
      try {
        return await machines.json(at.machine, 'POST', '/feedback', { rating, text, sessionId: at.id, turnId, source });
      } catch (err) {
        if (err.status === 400) throw err; // offline, or an older wisp there: send it from here, without the run
      }
    }
    const s = sessionId && !at ? store.get(sessionId) : null;
    if (sessionId && !at && !s) throw bad('no such session', 404);
    const turn = s && (turnId ? s.turns.find((t) => t.id === turnId) : s.turns.at(-1));
    if (turnId && s && !turn) throw bad('no such turn', 404);
    // Only thumbs on a turn stick to it; a rating in the feedback dialog is about wisp as a whole.
    if (turn && turnId && rating !== undefined) {
      turn.feedback = rating ? { rating, at: Date.now() } : undefined;
      store.save(s);
      app.broadcast('turn', { sessionId: s.id, turnId: turn.id });
    }
    const blocks = turn?.presentation?.blocks || [];
    const context = turn && {
      ...runProps(s, turn),
      status: turn.status,
      heroStatus: blocks.find((b) => b.type === 'hero')?.status,
      blockTypes: [...new Set(blocks.map((b) => b.type))],
      durationMs: turn.endedAt ? turn.endedAt - turn.startedAt : undefined,
      tour: s.agent === 'wisp' || undefined,
    };
    const props = { ...context, rating: rating || undefined, source: String(source || (turn ? 'turn' : 'app')).slice(0, 20), machine: at ? true : undefined };
    // Thumbs on a turn count as a rating; anything written, or sent from the dialog, is 'feedback'.
    const event = text || !turnId ? 'feedback' : 'turn_rated';
    if (event === 'turn_rated' && rating === null) props.cleared = true;
    const sent = await telemetry.feedback(event, { ...props, text: text || undefined });
    return { ok: true, sent, available: feedbackAvailable() };
  };
}
