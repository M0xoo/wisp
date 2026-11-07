// The `steps` block (v1 R.steps): what the agent did, in order, through the kit's Steps. A step
// is done unless it says skipped or failed; a bare string is a done step.
import { Show, type JSX } from 'solid-js';
import { Steps, type Step, type StepStatus } from '../composites/Steps.tsx';
import { BlockTitle } from './content-parts.tsx';
import { items, oneOf, opt, str } from './read.ts';
import type { BlockProps } from './types.ts';

const STATUS: readonly StepStatus[] = ['done', 'skipped', 'failed', 'current', 'pending'];

export function readSteps(v: unknown): Step[] {
  return items<Step>(
    v,
    (o) => {
      const detail = opt(o['detail']);
      const step: Step = { title: str(o['title']), status: oneOf(o['status'], STATUS, 'done') };
      return detail === undefined ? step : { ...step, detail };
    },
    (s) => ({ title: s, status: 'done' }),
  );
}

export function StepsBlock(props: BlockProps): JSX.Element {
  const title = (): string => str(props.block['title']);
  return (
    <div data-kit="cb-card" data-part="block.steps" data-type="steps">
      <Show when={title()}>
        <BlockTitle part="block.steps.title" title={title()} />
      </Show>
      <Steps part="block.steps.list" items={readSteps(props.block['items'])} />
    </div>
  );
}
