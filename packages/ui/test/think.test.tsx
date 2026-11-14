// The thinking slider (controls/ThinkingSlider.tsx, v1 runner-picker.js .pk-think): Default to the harness's top.
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount } from './helpers.tsx';
import { ThinkingSlider, stepKey, stopAt } from '../src/controls/ThinkingSlider.tsx';

test('the knob snaps to the nearest level; arrows, Home and End step it; Default sits on the left_v1_thinking_slider', () => {
  expect([stopAt(0, 5), stopAt(0.49, 5), stopAt(0.6, 5), stopAt(1.3, 5)]).toEqual([0, 2, 2, 4]);
  expect([stepKey('ArrowRight', 1, 4), stepKey('ArrowLeft', 0, 4), stepKey('End', 0, 4), stepKey('Home', 3, 4), stepKey('a', 1, 4)]).toEqual([2, 0, 3, 0, undefined]);
  const [v, setV] = createSignal('');
  const host = mount(() => (
    <ThinkingSlider
      heading="Thinking"
      stops={['', 'low', 'medium', 'high']}
      value={v()}
      onChange={setV}
      label={(e) => e || 'Default'}
      aria={{ label: 'Thinking level', valueText: (e) => `${e || 'Default'} thinking` }}
    />
  ));
  const track = host.querySelector('[data-kit="think-track"]') as HTMLElement;
  const think = host.querySelector('[data-kit="think"]') as HTMLElement;
  expect([track.getAttribute('role'), track.getAttribute('aria-valuemax'), think.hasAttribute('data-dflt')]).toEqual(['slider', '3', true]);
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(v()).toBe('low');
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(v()).toBe('high');
  expect(track.getAttribute('aria-valuetext')).toBe('high thinking');
  expect(think.hasAttribute('data-dflt')).toBe(false);
  expect(host.querySelectorAll('[data-kit="think-stop"][data-past]')).toHaveLength(4);
});
