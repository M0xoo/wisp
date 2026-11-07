// Toolbar: a row of controls under one name. Left/Right (and Home/End) move between them, as a
// toolbar does for keyboard and screen-reader users; Tab still reaches each one.
import type { JSX } from 'solid-js';
import type { Space } from '@wisp/tokens';
import { spaceVar } from '@wisp/tokens';
import { flag, styleOf, type KitProps, type WithChildren, type WithVars } from '../core/props.ts';
import type { Justify } from '../layout/Stack.tsx';

export interface ToolbarProps extends KitProps, WithVars, WithChildren {
  /** Required: what the toolbar acts on ("Task actions"). */
  readonly 'aria-label': string;
  readonly gap?: Space;
  readonly justify?: Justify;
  /** More than fits scrolls sideways instead of wrapping (the phone's reply bar). */
  readonly scroll?: boolean;
}

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The control a key moves to, or undefined when it isn't a toolbar key. Wraps at both ends. */
export function nextInToolbar(items: readonly HTMLElement[], current: number, key: string): HTMLElement | undefined {
  if (items.length === 0) return undefined;
  const last = items.length - 1;
  const index =
    key === 'ArrowRight' ? (current >= last ? 0 : current + 1)
    : key === 'ArrowLeft' ? (current <= 0 ? last : current - 1)
    : key === 'Home' ? 0
    : key === 'End' ? last
    : -1;
  return index < 0 ? undefined : items[index];
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const onKeyDown = (e: KeyboardEvent): void => {
    const bar = e.currentTarget;
    const target = e.target;
    if (!(bar instanceof HTMLElement) || !(target instanceof HTMLElement)) return;
    // Arrow keys inside a text field move the caret, not the focus.
    if (target.matches('input, textarea, [contenteditable]')) return;
    const items = [...bar.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const next = nextInToolbar(items, items.indexOf(target), e.key);
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  return (
    <div
      role="toolbar"
      aria-orientation="horizontal"
      id={props.id}
      aria-label={props['aria-label']}
      data-kit="toolbar"
      data-part={props.part ?? 'ui.toolbar'}
      data-justify={props.justify}
      data-scroll={flag(props.scroll)}
      onKeyDown={onKeyDown}
      style={styleOf({ '--k-gap': spaceVar(props.gap ?? '2') }, props.vars)}
    >
      {props.children}
    </div>
  );
}
