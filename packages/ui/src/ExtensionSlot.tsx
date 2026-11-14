// ExtensionSlot: where the shell's extension tree puts what plugins attached to one input
// (`shell.composer:left`). A dumb component: the shell resolves which extensions apply, in what
// order, with what config; this only renders the list it's given.
import { ErrorBoundary, Show, type JSX } from 'solid-js';
import { Key } from '@zag-js/solid';
import type { Space } from '@wisp/tokens';
import { spaceVar } from '@wisp/tokens';
import type { KitProps, PartName } from './core/props.ts';

export interface ExtensionOutput {
  /** The extension's id (`claude.model-picker`): rows are keyed by it, so a reorder moves them. */
  readonly id: string;
  readonly render: () => JSX.Element;
}

export interface ExtensionSlotProps extends KitProps {
  /** The input id, `<parent>:<input>`; also the default `data-part`. */
  readonly input: `${string}.${string}`;
  readonly extensions: readonly ExtensionOutput[];
  /** inline: one row that never wraps; wrap: a group that may wrap (chips); stack: a column;
   * contents: no box of its own (the parent lays them out). */
  readonly layout?: 'inline' | 'wrap' | 'stack' | 'contents';
  readonly gap?: Space;
  /** Shown when no extension is attached. */
  readonly fallback?: JSX.Element;
  /** One extension throwing renders nothing in its place and reports here; the others stay. */
  readonly onError?: (id: string, error: unknown) => void;
}

export function ExtensionSlot(props: ExtensionSlotProps): JSX.Element {
  const part = (): PartName => props.part ?? props.input;
  return (
    <div
      id={props.id}
      data-kit="slot"
      data-part={part()}
      data-input={props.input}
      data-layout={props.layout ?? 'inline'}
      data-empty={props.extensions.length === 0 ? '' : undefined}
      style={{ '--k-gap': spaceVar(props.gap ?? '3') }}
    >
      <Show when={props.extensions.length > 0} fallback={props.fallback}>
        <Key each={props.extensions} by={(e) => e.id}>
          {(ext) => (
            <div data-kit="extension" data-extension={ext().id}>
              <ErrorBoundary
                fallback={(err) => {
                  props.onError?.(ext().id, err);
                  return null;
                }}
              >
                {ext().render()}
              </ErrorBoundary>
            </div>
          )}
        </Key>
      </Show>
    </div>
  );
}
