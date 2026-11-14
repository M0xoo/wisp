// A task's usage in its details (app/TaskUsage.tsx, v1 #785 .plan-used, .pu-ring, .plan-menu): the plan line and the
// context line with its ring, either opening the card; a subagent's row opens it.
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { TaskUsage, type TaskUsageProps } from '../src/app/TaskUsage.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

test('the_usage_lines_say_the_share_and_the_context_and_open_the_card_v1_785', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const opened: string[] = [];
  let settings = 0;
  const props: TaskUsageProps = {
    plan: { text: '6% of weekly · 21% of 5-hour', title: 'share' },
    context: { text: '85% context', title: 'ctx', share: 0.85, hi: true },
    sections: () => [
      { title: 'This task', rows: [{ label: 'Tokens, subagents in', value: '56k' }] },
      { title: 'Plan', rows: [] },
      { title: 'Context', rows: [{ label: 'In use', value: '170k of 200k', bar: { share: 0.85, hi: true } }] },
      { title: 'Subagents', rows: [{ label: 'tester', value: '40k', onOpen: () => opened.push('k1') }] },
    ],
    label: 'Task usage',
    more: { label: 'All usage in Settings', onClick: () => settings++ },
  };
  dispose = render(() => <TaskUsage {...props} />, host);
  const lines = [...host.querySelectorAll<HTMLButtonElement>('[data-kit="plan-used"]')];
  expect(lines.map((b) => b.textContent)).toEqual(['6% of weekly · 21% of 5-hour', '85% context']);
  // the ring fills to the share, amber past 80%
  const ring = host.querySelector<HTMLElement>('[data-kit="pu-ring"]');
  expect(ring?.style.getPropertyValue('--ctx')).toBe('85%');
  expect(ring?.hasAttribute('data-hi')).toBe(true);
  lines[1]?.click();
  await tick();
  const card = document.querySelector('[data-part="split.usage.card"][data-state="open"]');
  // an empty section isn't drawn
  expect([...(card?.querySelectorAll('h5') ?? [])].map((h) => h.textContent)).toEqual(['This task', 'Context', 'Subagents']);
  expect(card?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('85');
  card?.querySelector<HTMLButtonElement>('[data-part="split.usage.sub"]')?.click();
  expect(opened).toEqual(['k1']);
  lines[0]?.click();
  await tick();
  document.querySelector<HTMLButtonElement>('[data-part="split.usage.more"]')?.click();
  expect(settings).toBe(1);
});

test('no_usage_line_when_nothing_was_measured_v1_785', () => {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TaskUsage sections={() => []} label="Task usage" more={{ label: 'All', onClick: () => undefined }} />, host);
  expect(host.querySelector('[data-kit="plan-used"]')).toBeNull();
});
