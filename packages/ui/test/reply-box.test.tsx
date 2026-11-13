// The reply box's fold (app/Task.tsx ReplyBox, v1 composer.js): a press outside folds it once it's let go.
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { ReplyBox } from '../src/app/Task.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

test('a press outside folds the awake box only once it is let go: what was pressed (a follow-up\'s ×) is still where the press began', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const over = document.createElement('button');
  document.body.prepend(over);
  dispose = render(() => <ReplyBox placeholder="Follow up" value="" onInput={() => {}} onSend={() => {}} attach="Attach" mode={{ label: 'Auto', title: 'Mode' }} runner={{ title: 'Claude Code' }} team="Team" goal="Goal" later="Later" send="Send" />, host);
  const box = host.querySelector('[data-kit="reply-box"]') as HTMLElement;
  (host.querySelector('textarea') as HTMLTextAreaElement).focus();
  expect(box.hasAttribute('data-awake')).toBe(true);
  over.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  expect(box.hasAttribute('data-awake')).toBe(true); // still awake under the finger: nothing moves yet
  over.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  expect(box.hasAttribute('data-awake')).toBe(true);
  over.click(); // the click the release makes: the pressed control has had it
  expect(box.hasAttribute('data-awake')).toBe(false);
  // a right-click outside makes no click: it doesn't arm a fold that a later click inside would set off
  (host.querySelector('textarea') as HTMLTextAreaElement).blur();
  (host.querySelector('textarea') as HTMLTextAreaElement).focus();
  over.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  box.click();
  expect(box.hasAttribute('data-awake')).toBe(true);
  // a press inside keeps it awake
  (host.querySelector('textarea') as HTMLTextAreaElement).blur();
  (host.querySelector('textarea') as HTMLTextAreaElement).focus();
  expect(box.hasAttribute('data-awake')).toBe(true);
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  box.click();
  expect(box.hasAttribute('data-awake')).toBe(true);
});

// F-comp-46: Send from a finished task (Enter, or the Send button) leaves the keyboard in the box, awake, even as the
// task moves to Working and the box's props change under it (v1: the caret stays for the next follow-up).
test('send keeps the caret in the reply box while the task moves to working_v1_send_keeps_focus', async () => {
  const { createSignal } = await import('solid-js');
  const host = document.createElement('div');
  document.body.append(host);
  const [value, setValue] = createSignal('one more thing');
  const [working, setWorking] = createSignal(false);
  const send = (): void => {
    setValue('');
    setWorking(true); // the row moves to Working: the queue switch shows
  };
  dispose = render(
    () => (
      <ReplyBox
        placeholder="Follow up"
        value={value()}
        onInput={setValue}
        onSend={send}
        attach="Attach"
        mode={{ label: 'Auto', title: 'Mode' }}
        runner={{ title: 'Claude Code' }}
        team="Team"
        goal="Goal"
        later="Later"
        send="Send"
        queue={working() ? { label: 'Queue', title: 'Queue', on: true, act: { onClick: () => {} } } : undefined}
      />
    ),
    host,
  );
  const ta = host.querySelector('textarea') as HTMLTextAreaElement;
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(working()).toBe(true);
  expect(document.activeElement).toBe(ta);
  expect(host.querySelector('[data-kit="reply-box"]')?.hasAttribute('data-awake')).toBe(true);
});

// F-task-49 (v1 0.42.0 "One click when you leave the follow-up box"): a suggestion above the awake box takes the first
// click: its own handler runs while the box is still awake (nothing moved), and the box folds after it.
test('a_suggestion_above_the_open_reply_box_takes_one_click_v1_0_42', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const seen: boolean[] = [];
  dispose = render(
    () => (
      <>
        <button type="button" data-kit="next-chip" onClick={() => seen.push(!!document.querySelector('[data-kit="reply-box"][data-awake]'))}>
          Add a test
        </button>
        <ReplyBox placeholder="Follow up" value="" onInput={() => {}} onSend={() => {}} attach="Attach" mode={{ label: 'Auto', title: 'Mode' }} runner={{ title: 'Claude Code' }} team="Team" goal="Goal" later="Later" send="Send" />
      </>
    ),
    host,
  );
  const chip = host.querySelector('[data-kit="next-chip"]') as HTMLButtonElement;
  const box = host.querySelector('[data-kit="reply-box"]') as HTMLElement;
  (host.querySelector('textarea') as HTMLTextAreaElement).focus();
  chip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  chip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  chip.click();
  expect(seen).toEqual([true]); // one click, and the box hadn't folded under it
  expect(box.hasAttribute('data-awake')).toBe(false);
});
