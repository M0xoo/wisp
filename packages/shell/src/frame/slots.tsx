// The frame's extension inputs (contract INPUTS, v1's spell SLOTS): what plugins put in the sidebar's
// head (shell.topbar:*), on a task's row (shell.row:*) and in the task's head (shell.task:head). An
// input with nothing attached renders nothing at all (the kit's empty slot has no box), so the frame
// is pixel for pixel v1's until a plugin adds something.

import type { JSX } from 'solid-js';
import type { ExtensionProps } from '../contract.ts';
import { Area, Slot, useExtensions } from '../slot.tsx';

type Session = ExtensionProps['session'];

/** An area a plugin may take over (by id or by attaching): its extension, else nothing (the kit's own). */
function override(input: string, has: () => boolean): JSX.Element | undefined {
  return has() ? <Area input={input} fallback={null} form="full" /> : undefined;
}

export function useHeadSlots(): () => NonNullable<Parameters<typeof import('@wisp/ui').SidebarHead>[0]['slots']> {
  const brand = useExtensions('shell.topbar:brand');
  const search = useExtensions('shell.topbar:search');
  const account = useExtensions('shell.topbar:account');
  const view = useExtensions('shell.topbar:view');
  return () => ({
    lead: (
      <>
        <Slot input="shell.topbar:machines" layout="contents" form="full" />
        <Slot input="shell.topbar:getapp" layout="contents" form="full" />
        <Slot input="shell.topbar:automations" layout="contents" form="full" />
        <Slot input="shell.topbar:settings" layout="contents" form="full" />
      </>
    ),
    chips: <Slot input="shell.topbar:projects" layout="contents" form="full" />,
    brand: override('shell.topbar:brand', () => brand().length > 0),
    search: override('shell.topbar:search', () => search().length > 0),
    account: override('shell.topbar:account', () => account().length > 0),
    view: override('shell.topbar:view', () => view().length > 0),
  });
}

/** shell.row:* for one task's row. */
export function rowSlots(id: string, session: Session): { top: JSX.Element; head: JSX.Element; hover: JSX.Element; bottom: JSX.Element } {
  const scoped = { id, ...(session && { session }) };
  return {
    top: <Slot input="shell.row:top" layout="stack" {...scoped} />,
    head: <Slot input="shell.row:head" layout="contents" form="icon" {...scoped} />,
    hover: <Slot input="shell.row:hover" layout="contents" form="icon" {...scoped} />,
    bottom: <Slot input="shell.row:bottom" layout="stack" {...scoped} />,
  };
}

/** shell.task:head for the open task. */
export function TaskHeadSlot(props: { readonly id: string; readonly session: Session }): JSX.Element {
  return <Slot input="shell.task:head" layout="contents" form="icon" id={props.id} {...(props.session && { session: props.session })} />;
}
