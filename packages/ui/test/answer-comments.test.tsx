import { describe, expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, part, tick } from './helpers.tsx';
import { Answer, type AnswerCommentAt, type AnswerCommentMark } from '../src/index.ts';
import { locate, quoteOf } from '../src/blocks/comment-range.ts';

describe('F-page-10: comments on an answer (v1 comments.js)', () => {
  test('F-page-10: locate_finds_the_words_across_text_nodes_with_whitespace_runs_as_one_v1_find_range', () => {
    // a selection across two paragraphs reads "one two\n\nthree"; the text nodes have the break in their own way
    const texts = ['Intro: one ', 'two', '\n  \n', 'three four'];
    expect(locate(texts, 'one two\n\nthree')).toEqual({ from: [0, 7], to: [3, 5] });
    expect(locate(texts, 'two')).toEqual({ from: [1, 0], to: [1, 3] });
    expect(locate(texts, 'missing')).toBeUndefined();
    expect(locate(texts, '   ')).toBeUndefined();
    expect(locate([], 'x')).toBeUndefined();
    // <p>one</p><p>two</p> has no whitespace node between them: the break the walk adds stands in for it
    expect(locate(['one', ' ', 'two'], 'one\n\ntwo')).toEqual({ from: [0, 0], to: [2, 3] });
    expect(quoteOf(' a ')).toBeUndefined();
    expect(quoteOf('x'.repeat(700))?.length).toBe(600);
  });

  test('F-page-10: a_block_takes_a_comment_from_its_button_and_shows_its_number_once_kept_v1_comments', async () => {
    const [marks, setMarks] = createSignal<readonly AnswerCommentMark[]>([]);
    const added: [AnswerCommentAt, string][] = [];
    const comment = {
      marks,
      next: () => marks().length + 1,
      label: (at: AnswerCommentAt) => `Text · ${at.i}`,
      add: (at: AnswerCommentAt, note: string) => {
        added.push([at, note]);
        setMarks([...marks(), { n: marks().length + 1, i: at.i, note }]);
      },
    };
    const blocks = [{ type: 'markdown', text: 'Hello there' }, { type: 'next', items: ['Ship it'] }];
    const host = mount(() => <Answer blocks={blocks} ctx={{ comment }} />);
    // the buttons-already blocks (next, actions, question, blocked) take none
    const buttons = host.querySelectorAll('[data-part="answer.block.comment"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest('[data-kit="answer-block"]')?.getAttribute('data-type')).toBe('markdown');
    (buttons[0] as HTMLButtonElement).click();
    const card = part('answer.comment.card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Text · 0');
    const box = card?.querySelector('textarea');
    if (!box) throw new Error('no note box');
    box.value = 'Say it shorter';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(added).toEqual([[{ i: 0, block: blocks[0] }, 'Say it shorter']]);
    expect(part('answer.comment.card')).toBeNull();
    await tick();
    // kept: the block is ringed, its number in the corner
    const mark = host.querySelector('[data-kit="cmt-corners"] [data-part="answer.comment.mark"]');
    expect(mark?.textContent).toBe('1');
    expect(mark?.getAttribute('title')).toBe('Say it shorter');
    expect(host.querySelector('[data-kit="cmt-ring"]')).not.toBeNull();
  });

  test('F-page-10: escape_lets_the_card_go_and_nothing_is_kept_and_an_answer_without_a_host_offers_no_comments', () => {
    const added: unknown[] = [];
    const comment = { marks: () => [], next: () => 1, label: () => 'Text', add: (...a: unknown[]) => void added.push(a) };
    const host = mount(() => <Answer blocks={[{ type: 'markdown', text: 'Hi' }]} ctx={{ comment }} />);
    (host.querySelector('[data-part="answer.block.comment"]') as HTMLButtonElement).click();
    part('answer.comment.card')?.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(part('answer.comment.card')).toBeNull();
    expect(added).toEqual([]);
    const share = mount(() => <Answer blocks={[{ type: 'markdown', text: 'Hi' }]} ctx={{}} />);
    expect(share.querySelector('[data-part="answer.block.comment"]')).toBeNull();
  });
});
