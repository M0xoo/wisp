// A transcript step whose label the harness had to cut (frame/TurnTranscript.tsx, v1 #779/#780).
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { TurnTranscript } from '../src/frame/TurnTranscript.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

test('an_opened_step_shows_its_whole_title_not_the_label_cut_for_the_row', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const whole = 'Searching for “a-very-long-pattern-a-very-long-pattern-a-very-long-pattern” in src';
  dispose = render(
    () => (
      <TurnTranscript
        steps={[
          { kind: 'run', label: 'Searching for “a-very-long-pattern-a-very-long…” in src', title: whole },
          { kind: 'read', label: 'Reading src/a.ts' },
        ]}
        changes={[]}
        here={(s) => s}
        status="done"
        t={(k) => k}
      />
    ),
    host,
  );
  const labels = (): string[] => [...host.querySelectorAll('[data-kit="timeline-label"]')].map((e) => e.textContent ?? '');
  expect(labels()[0]).toContain('…');
  // a step with no more to it is a plain row; the cut one opens
  expect(host.querySelectorAll('button[data-kit="timeline-row"]').length).toBe(1);
  host.querySelector<HTMLButtonElement>('button[data-kit="timeline-row"]')?.click();
  expect(labels()[0]).toBe(whole);
});
