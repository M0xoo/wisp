// The `checklist` block (v1 R.checklist): where a ship, release or deploy stands, one item per
// stage, ticked or not, through the kit's Checklist. A bare string is an undone item.
import { Show, type JSX } from 'solid-js';
import { Checklist, type ChecklistItem } from '../composites/Steps.tsx';
import { useBlockT } from './context.tsx';
import { BlockTitle } from './content-parts.tsx';
import { bool, items, str } from './read.ts';
import type { BlockProps } from './types.ts';

export function readChecklist(v: unknown): ChecklistItem[] {
  return items<ChecklistItem>(v, (o) => ({ text: str(o['text']), done: bool(o['done']) }), (s) => ({ text: s, done: false }));
}

export function ChecklistBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const title = (): string => str(props.block['title']);
  return (
    <div data-kit="cb-card" data-part="block.checklist" data-type="checklist">
      <Show when={title()}>
        <BlockTitle part="block.checklist.title" title={title()} />
      </Show>
      <Checklist
        part="block.checklist.list"
        items={readChecklist(props.block['items'])}
        statusLabel={(done) => (done ? t('block.checklist.done') : t('block.checklist.undone'))}
      />
    </div>
  );
}
