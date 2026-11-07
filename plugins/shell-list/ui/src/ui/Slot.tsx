// The extensions other plugins attach to one of the list's inputs (shell.row:hover, shell.list:top…),
// resolved by the shell (overrides, disable, attach, order) and filtered by their own `if`. Rendered
// through the kit's ExtensionSlot, so one extension that throws renders nothing and the rest stay.

import { createMemo, type JSX } from 'solid-js';
import { ExtensionSlot, type ExtensionOutput } from '@wisp/ui';
import type { ExtensionProps, InputId } from '@wisp/shell/contract';
import { useEnv } from './env.ts';

type SessionOf = NonNullable<ExtensionProps['session']>;

export function Slot(props: { readonly input: InputId; readonly session?: SessionOf; readonly layout?: 'inline' | 'stack' | 'contents' }): JSX.Element {
  const env = useEnv();
  const resolved = env.shell.extensions(props.input);
  const outputs = createMemo<readonly ExtensionOutput[]>(() =>
    resolved()
      .map((ext) => {
        // the extension reads its own plugin's client in the shell; here, the list's (see report)
        const p: ExtensionProps = { client: env.client, config: ext.config, ...(props.session ? { session: props.session } : {}) };
        return { ext, p };
      })
      .filter(({ ext, p }) => ext.def.if?.(p) ?? true)
      .map(({ ext, p }) => ({ id: ext.id, render: () => ext.def.component(p) })),
  );
  return <ExtensionSlot input={props.input as `${string}.${string}`} extensions={outputs()} layout={props.layout ?? 'inline'} gap="2" />;
}

/** Whether anything is attached to an input (a row skips the slot's box when not). */
export function hasExtensions(input: InputId): () => boolean {
  const env = useEnv();
  const resolved = env.shell.extensions(input);
  return () => resolved().length > 0;
}
