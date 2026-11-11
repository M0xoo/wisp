// A reply in a task that starts with @a member is for them (v1 crew.js replyIn): who it's for and the words; the
// answers kept on a turn read back from its row (flat or under `body`).
import { describe, expect, it } from 'vitest';
import { answersOf, askedOf, isReply } from '../src/answers.ts';

describe('crew answers in a task', () => {
  it('a_reply_starting_with_crew_members_goes_to_them_and_their_answers_read_back_from_the_turn', () => {
    expect(askedOf('@[Ada](crew:a1), @[Bo](crew:b2): check the docs')).toEqual({ ids: ['a1', 'b2'], question: 'check the docs' });
    expect(askedOf('@[Ada](crew:a1) @[Ada](crew:a1) again')).toEqual({ ids: ['a1'], question: 'again' });
    // for the task's agent: a member mentioned later, a task mention first, nothing left to ask
    expect(askedOf('ask @[Ada](crew:a1) about it')).toBeNull();
    expect(askedOf('@[Fix login](wisp:t1) is done')).toBeNull();
    expect(askedOf('@[Ada](crew:a1)  ')).toBeNull();
    const a = { id: 'e1', crew: 'a1', member: 'Ada', question: 'q', answer: 'yes', status: 'done', askedAt: 1 };
    const r = { ...a, id: 'e2', thread: 'e1' };
    expect(answersOf({ id: 't', body: { ext: { 'wisp.crew': { answers: [a, r] } } } })).toEqual([a, r]);
    expect(answersOf({ id: 't', ext: { 'wisp.crew': { answers: [a] } } })).toEqual([a]);
    expect(answersOf({ id: 't', body: { ext: {} } })).toEqual([]);
    expect(answersOf(undefined)).toEqual([]);
    expect([isReply(a as never), isReply(r as never)]).toEqual([false, true]);
  });
});
