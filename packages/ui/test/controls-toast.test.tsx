import { describe, expect, test, vi } from 'vitest';
import { mount, part, tick } from './helpers.tsx';
import { createToaster, type RollbackToaster } from '../src/controls/toaster.ts';
import { Toasts } from '../src/controls/Toast.tsx';

describe('toaster', () => {
  test('the same text twice shows once', () => {
    const toaster = createToaster();
    const a = toaster.show('Archived');
    const b = toaster.show('Archived');
    expect(a).toBe(b);
    expect(toaster.store.getVisibleToasts().length).toBe(1);
  });

  test('at most three on screen; the rest wait', () => {
    const toaster = createToaster();
    for (const msg of ['Archived', 'Marked done', 'Saved for later', 'Reopened']) toaster.show(msg);
    expect(toaster.store.getVisibleToasts().length).toBe(3);
  });

  test('error is the red one, and a command runner can call it through RollbackToaster', () => {
    const toaster = createToaster();
    const sink: RollbackToaster = toaster;
    sink.error('Still working — stop it first or let it finish.', { action: { label: 'Stop', onClick: () => {} } });
    const [shown] = toaster.store.getVisibleToasts();
    expect(shown?.type).toBe('error');
    expect(shown?.action?.label).toBe('Stop');
  });
});

describe('<Toasts>', () => {
  test('renders each toast with its parts; the action runs and × has a name', async () => {
    const toaster = createToaster();
    const undo = vi.fn();
    mount(() => <Toasts toaster={toaster} />);
    toaster.show('Archived', { action: { label: 'Undo', onClick: undo } });
    await tick(30);
    expect(part('ui.toast.group')).not.toBeNull();
    expect(part('ui.toast')?.textContent).toContain('Archived');
    expect(part('ui.toast.close')?.getAttribute('aria-label')).toBe('Dismiss');
    part('ui.toast.action')?.click();
    await tick(10);
    expect(undo).toHaveBeenCalled();
  });

  test('dismiss plays the exit and then removes it; clear removes the rest', async () => {
    const toaster = createToaster();
    mount(() => <Toasts toaster={toaster} />);
    const id = toaster.show('Archived');
    toaster.show('Marked done');
    await tick(30);
    toaster.dismiss(id);
    await tick(400);
    expect(toaster.store.isDismissed(id)).toBe(true);
    expect(toaster.store.getVisibleToasts().length).toBe(1);
    toaster.clear();
    await tick(400);
    expect(toaster.store.getVisibleToasts().length).toBe(0);
  });

  test('an error toast is marked as one', async () => {
    const toaster = createToaster();
    mount(() => <Toasts toaster={toaster} part="app.toast" />);
    toaster.error('Can’t reach wisp. Check the connection and try again.');
    await tick(30);
    expect(part('app.toast')?.getAttribute('data-type')).toBe('error');
  });
});
