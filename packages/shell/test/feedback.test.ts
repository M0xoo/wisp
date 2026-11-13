// Feedback for the wisp team (src/frame/feedback.ts, v1 feedback.js): `/feedback …` and `/bug …` in any prompt box,
// and what the dialog may send.
import { expect, test } from 'vitest';
import { canSend, feedbackOf, isFeedback, parseFeedback, sendFeedback } from '../src/frame/feedback.ts';
import { wireOf } from './command.ts';

test('/feedback and /bug go to the team, not to a task; a bug needs words, an idea words or a thumb_v1_feedback_command', () => {
  expect(isFeedback('/feedback love the viewer')).toBe(true);
  expect(isFeedback('  /BUG it crashed')).toBe(true);
  expect(isFeedback('/feedbacks')).toBe(false);
  expect(isFeedback('fix /bug in the parser')).toBe(false);
  expect(feedbackOf('/bug  the list jumps ')).toEqual({ kind: 'bug', note: 'the list jumps' });
  expect(feedbackOf('/feedback')).toEqual({ kind: 'idea', note: '' }); // no words: the dialog opens
  expect(canSend('bug', 'up', '  ')).toBe(false);
  expect(canSend('idea', 'up', '')).toBe(true);
  expect(canSend('idea', undefined, '')).toBe(false);
  // a bug sends no thumb; a task's note names it by its own id there
  expect(wireOf(sendFeedback)({ peer: 'p' as never, text: 'x', kind: 'bug', rating: 'up', source: 'dialog' })).toEqual({ text: 'x', source: 'dialog', kind: 'bug' });
  expect(wireOf(sendFeedback)({ peer: 'p' as never, text: 'x', kind: 'idea', rating: 'down', sessionId: 'p:s1', source: 'command' })).toEqual({
    text: 'x',
    source: 'command',
    rating: 'down',
    sessionId: 's1',
  });
  expect(parseFeedback({ kind: 'bug', text: 'a', junk: 1 })).toEqual({ kind: 'bug', text: 'a' });
});
