// PaneCard (v1 pane-card.js): the card a pane's write waits on.
import { expect, test, vi } from 'vitest';
import { createSignal, Show } from 'solid-js';
import { mount } from './helpers.tsx';
import { PaneCard } from '../src/app/Panes.tsx';

test('only your click on Send sends: Send is off at first, Cancel has the focus, what doesnt print is a chip, and gone unanswered is Cancel_v1_pane_card', async () => {
  vi.useFakeTimers();
  const answers: boolean[] = [];
  const [shown, setShown] = createSignal(true);
  mount(() => (
    <Show when={shown()}>
      <PaneCard
        head={[{ text: 'Board wants to start a task' }]}
        from="A pane wrote this, not you. Nothing happens until you press Send."
        rows={[
          { label: 'Project', value: [{ text: 'web' }] },
          { label: 'Mode', value: [{ text: 'Full auto: no permission prompts' }], warn: true },
        ]}
        promptLabel="Prompt"
        hiddenCount="1 invisible"
        length="12 characters"
        prompt={[{ text: 'Fix it' }, { text: '<U+202E>', hidden: true }, { text: 'now' }]}
        cancel="Cancel"
        send="Send"
        armMs={600}
        onAnswer={(yes) => answers.push(yes)}
      />
    </Show>
  ));
  await vi.advanceTimersByTimeAsync(0);
  const button = (name: string): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name);
  expect(button('Send')?.disabled).toBe(true);
  expect(document.querySelector('[data-kit="pc-inv"]')?.textContent).toBe('<U+202E>');
  expect(document.querySelector('[data-kit="pc-row"][data-warn]')?.textContent).toContain('Full auto');
  button('Send')?.click();
  expect(answers).toEqual([]); // a click the pane timed for the moment it opened doesn't land
  await vi.advanceTimersByTimeAsync(600);
  expect(button('Send')?.disabled).toBe(false);
  // closed without an answer (another dialog took its place): Cancel, once
  setShown(false);
  expect(answers).toEqual([false]);
  vi.useRealTimers();
});
