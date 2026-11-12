// The transcript's steps (transcript/Timeline.tsx).
import { expect, test } from 'vitest';
import { createSignal } from 'solid-js';
import { mount } from './helpers.tsx';
import { Timeline, TimelineStep } from '../src/transcript/Timeline.tsx';

test('an_opened_step_shows_its_whole_title_it_wraps_instead_of_a_cut_control_line', () => {
  const [open, setOpen] = createSignal(false);
  const host = mount(() => (
    <Timeline>
      <TimelineStep icon="terminal" label="Run the whole test suite with coverage and the slow integration tests too" detail={() => <pre>ok</pre>} expanded={open()} onToggle={() => setOpen(!open())} />
    </Timeline>
  ));
  const label = (): HTMLElement | null => host.querySelector('[data-kit="timeline-label"]');
  expect(label()?.getAttribute('data-text')).toBe('control'); // closed: one line and an ellipsis
  host.querySelector<HTMLButtonElement>('[data-kit="timeline-row"]')?.click();
  expect(host.querySelector('[data-kit="timeline-step"]')?.hasAttribute('data-open')).toBe(true);
  expect(label()?.hasAttribute('data-text')).toBe(false); // open: the whole title, wrapping (v1 #779)
});
