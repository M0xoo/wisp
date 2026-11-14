// Thumbs on a turn and the line after 👎 (src/app/Rate.tsx, v1 turns.js .rate, feedback.js whyForm).
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, part, tick } from './helpers.tsx';
import { RateButtons, WhyForm, type Rating } from '../src/index.ts';

const click = (el: Element | null | undefined): void => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('a thumb lights and the one that is on takes it back; after a thumb down Enter sends the line_v1_rate_buttons', async () => {
  const said: unknown[] = [];
  const [rating, setRating] = createSignal<Rating | undefined>();
  mount(() => (
    <RateButtons
      rating={rating()}
      labels={{ up: 'Good result', down: 'Bad result' }}
      onRate={(n) => {
        said.push(n);
        setRating(n ?? undefined);
      }}
    />
  ));
  const up = document.querySelector('[data-rate="up"]');
  click(up);
  expect(up?.getAttribute('aria-pressed')).toBe('true');
  expect(part('turn.rate')?.hasAttribute('data-rated')).toBe(true);
  click(up);
  expect(said).toEqual(['up', null]);
  expect(part('turn.rate')?.hasAttribute('data-rated')).toBe(false);

  const sent: string[] = [];
  let closed = 0;
  mount(() => <WhyForm labels={{ placeholder: 'What went wrong?', note: 'n', skip: 'Skip', send: 'Send' }} onSend={(t) => void sent.push(t)} onSkip={() => void 0} onClose={() => void closed++} />);
  const box = part('turn.why.text') as HTMLTextAreaElement;
  box.value = '  wrong file  ';
  box.dispatchEvent(new InputEvent('input', { bubbles: true }));
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  expect(sent).toEqual(['wrong file']);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(closed).toBe(1);
});
