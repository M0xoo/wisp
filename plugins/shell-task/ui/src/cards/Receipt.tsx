// A turn's usage receipt (v1 receipt.js, turns.js receiptHtml): after the turn's token count, quiet, the share of
// what it read that came from the cache, its share of the plan's longest window, and Past your plan; every window
// and the whole count in the title.
import type { JSX } from 'solid-js';
import { Text } from '@wisp/ui';
import type { ReceiptLine } from './model.ts';

export function Receipt(props: { readonly line: Pick<ReceiptLine, 'parts' | 'tip'>; readonly part?: 'turn.receipt' | 'turn.agents' }): JSX.Element {
  return (
    <Text size="sm" tone="muted" part={props.part ?? 'turn.receipt'} title={props.line.tip} truncate>
      {props.line.parts.join(' · ')}
    </Text>
  );
}
