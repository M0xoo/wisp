// Save to My Stuff on a reply's picture, video, doc and code (v1 features/stuff.js saveButtonHtml): the My Stuff icon,
// in the accent once the thing is kept; a click keeps it, or takes it out again. No host `keep`: no button.
import { Show, type JSX } from 'solid-js';
import { IconButton } from '../controls/Button.tsx';
import type { PartName } from '../core/props.ts';
import { useBlocks, useBlockT } from './context.tsx';
import type { KeepWhat } from './types.ts';

export function KeepButton(props: { readonly keep: { readonly what: string; readonly it: KeepWhat } | undefined; readonly part: PartName; readonly size?: 'xs' | 'sm' }): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  return (
    <Show when={ctx.keep && props.keep && (ctx.keep.files !== false || props.keep.it.text !== undefined) ? props.keep : undefined}>
      {(k) => {
        const host = ctx.keep;
        const saved = host ? host.saved(k().what) : () => false;
        return (
          <IconButton
            icon="stuff"
            size={props.size ?? 'xs'}
            pressed={saved()}
            label={saved() ? t('block.keep.saved') : t('block.keep.save')}
            onClick={(e) => {
              e.stopPropagation();
              host?.toggle(k().what, k().it);
            }}
            part={props.part}
          />
        );
      }}
    </Show>
  );
}
