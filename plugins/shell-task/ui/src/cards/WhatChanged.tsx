// The line saying what moved in the CLI since the last turn (v1 what-changed.js, what-changed-line.js): its version
// or its model catalogue. Said as a possible cause, not proof: a server-side change wouldn't show.
import type { JSX } from 'solid-js';
import { Text } from '@wisp/ui';
import type { T } from './model.ts';

export function WhatChanged(props: { readonly line: string; readonly t: T }): JSX.Element {
  return (
    <Text size="sm" tone="muted" part="turn.what-changed" title={props.t('shell-task.changed.limit')}>
      {props.line}
    </Text>
  );
}
