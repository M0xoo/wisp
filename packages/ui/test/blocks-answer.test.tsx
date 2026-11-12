import { describe, expect, test } from 'vitest';
import type { JSX } from 'solid-js';
import { mount, part } from './helpers.tsx';
import { Answer, BLOCK_TYPES, asBlock, type BlockProps } from '../src/index.ts';

// Every type v1 draws (web/js/blocks.js R; server/protocol.js documents them).
const V1_TYPES = ['hero', 'markdown', 'steps', 'stats', 'files', 'tree', 'diff', 'code', 'compare', 'tests', 'commits', 'graph', 'checklist', 'callout', 'terminal', 'flow', 'chart', 'image', 'video', 'preview', 'map', 'doc', 'task', 'stuff', 'question', 'blocked', 'actions', 'next', 'app'];

describe('Answer', () => {
  // v1 blocks.js R.hero: in a task's page the latest answer's state is the task bar's (own) and a title that only
  // repeats the task's is left out (echo); with the transcript open the state row comes back with its meta
  test('a_heros_state_row_is_left_out_on_a_tasks_latest_answer_and_back_with_the_transcript', () => {
    const hero = { type: 'hero', title: 'Fake claude finished', summary: 'No question asked.', status: 'done' };
    const own = mount(() => <Answer blocks={[hero]} ctx={{ inTask: true, latest: true, taskTitle: 'Fix the login bug' }} />);
    expect(own.querySelector('[data-part="block.hero.status"]')).toBeNull();
    expect(own.querySelector('[data-part="block.hero.title"]')?.textContent).toBe('Fake claude finished');
    const echo = mount(() => <Answer blocks={[hero]} ctx={{ inTask: true, latest: true, taskTitle: 'Fake claude finished' }} />);
    expect(echo.querySelector('[data-part="block.hero.title"]')).toBeNull();
    const tx = mount(() => <Answer blocks={[hero]} ctx={{ inTask: false, latest: true, heroMeta: ['369ms', '$0.01', '1 file touched'] }} />);
    expect(tx.querySelector('[data-part="block.hero.status"]')).not.toBeNull();
    expect([...tx.querySelectorAll('[data-kit="cb-hero-meta"]')].map((m) => m.textContent)).toEqual(['369ms', '$0.01', '1 file touched']);
  });

  test('the kit has a renderer for every block type v1 draws', () => {
    expect([...BLOCK_TYPES].sort()).toEqual([...V1_TYPES].sort());
  });

  test('an unknown type shows as its JSON with "Update the app to see this" (plan §7.3.2)', () => {
    mount(() => <Answer blocks={[{ type: 'hologram', depth: 3 }]} />);
    const unknown = part('block.unknown');
    expect(unknown).not.toBeNull();
    expect(unknown?.textContent).toContain('Update the app to see this');
    expect(unknown?.textContent).toContain('"depth": 3');
    expect(unknown?.textContent).toContain('hologram');
  });

  test('an entry that is not a block is kept, as unknown', () => {
    expect(asBlock('text')).toEqual({ type: '?', value: 'text' });
    expect(asBlock({ type: 4 })).toEqual({ type: '?', value: { type: 4 } });
    mount(() => <Answer blocks={['text', null]} />);
    expect(document.querySelectorAll('[data-part="block.unknown"]').length).toBe(2);
  });

  test('a renderer that throws falls back to unknown, and the blocks after it still show', () => {
    const Boom = (_: BlockProps): JSX.Element => {
      throw new Error('boom');
    };
    const Fine = (p: BlockProps): JSX.Element => <p data-part="test.fine">{String(p.block['text'])}</p>;
    mount(() => <Answer blocks={[{ type: 'boom' }, { type: 'fine', text: 'after' }]} ctx={{ renderers: { boom: Boom, fine: Fine } }} />);
    expect(part('block.unknown')?.textContent).toContain('couldn’t be shown');
    expect(part('test.fine')?.textContent).toBe('after');
  });

  test("a host's renderer overrides the kit's", () => {
    const Mine = (): JSX.Element => <p data-part="test.mine">mine</p>;
    mount(() => <Answer blocks={[{ type: 'hero', title: 'x' }]} ctx={{ renderers: { hero: Mine } }} />);
    expect(part('test.mine')).not.toBeNull();
  });

  test('blocks rise in turn on first show, and not at all when shown again', () => {
    mount(() => <Answer blocks={[{ type: 'x' }, { type: 'y' }, { type: 'z' }]} />);
    const delays = [...document.querySelectorAll<HTMLElement>('[data-kit="answer-block"]')].map((n) => n.style.getPropertyValue('--k-answer-d'));
    expect(delays).toEqual(['0ms', '110ms', '220ms']);
    document.body.innerHTML = '';
    mount(() => <Answer blocks={[{ type: 'x' }]} ctx={{ reveal: false }} />);
    expect(part('answer.blocks')?.hasAttribute('data-still')).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-kit="answer-block"]')?.style.getPropertyValue('--k-answer-d')).toBe('');
  });

  test('a plain-text answer says so above its blocks', () => {
    mount(() => <Answer fallback blocks={[]} />);
    expect(part('answer.fallback')?.textContent).toContain('plain text');
  });
});
