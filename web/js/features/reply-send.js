// A follow-up on its way to the server. DOM-free: test/reply-send.test.js runs it.
import { api } from '../core/api.js';

// Longer than a worktree coming back takes, the one slow thing a reply waits for, and short of the
// 30 s that reads as a hang. Hitting it wrongly costs a toast, not a second run (see sendId).
export const REPLY_TIMEOUT = 20_000;
// As long as the server remembers a sendId (server/services/send-once.js).
const REMEMBERED = 10 * 60_000;

const newSendId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; // crypto.randomUUID needs https

// The last send on each task that got no answer. It may still have reached the server, or be there
// now: the box has the text back, and sending that again is the same message with the same sendId.
const unanswered = new Map();

// path: 'reply' or 'answer'. An answer the server took can come back here as a reply (the question
// has gone), so what makes it the same message is what it says, not the route.
export async function sendFollowUp(id, path, body, { timeout = REPLY_TIMEOUT } = {}) {
  const said = JSON.stringify([body.text, body.attachments || []]);
  const last = unanswered.get(id);
  const again = last?.said === said && Date.now() - last.at < REMEMBERED ? last : null;
  const sendId = again?.sendId || newSendId();
  try {
    const out = await api(`/sessions/${id}/${path}`, { method: 'POST', body: { ...body, sendId }, timeout });
    unanswered.delete(id);
    return out;
  } catch (err) {
    if (err.status === undefined) unanswered.set(id, again || { said, sendId, at: Date.now() });
    else unanswered.delete(id); // refused: nothing happened
    throw err;
  }
}
