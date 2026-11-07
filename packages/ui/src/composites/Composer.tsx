// Composer: the reply box frame (v1's .composer). A textarea that grows with its text, a hint row
// above it, slots left and right of Send, docked at the bottom of its scroll parent so it never
// moves. The text is controlled from outside (the drafts store): the caller clears it on send.
import { createEffect, on, onMount, Show, type JSX } from 'solid-js';
import { fitTextarea } from '../core/autosize.ts';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { IconButton } from '../controls/Button.tsx';

export interface ComposerProps extends KitProps {
  readonly value: string;
  readonly onInput: (value: string) => void;
  /** Called with the text when Send is pressed or the send key is typed. */
  readonly onSend: (value: string) => void;
  readonly placeholder?: string;
  /** The textarea's accessible name, when the placeholder isn't one. */
  readonly 'aria-label'?: string;
  /** One line above the box: *Side question · …*, a read time. */
  readonly head?: JSX.Element;
  /** Pickers and chips left of Send (attach, mode, model). */
  readonly left?: JSX.Element;
  /** Controls just before Send. */
  readonly right?: JSX.Element;
  /** Send's name; defaults to the kit's "Send". */
  readonly sendLabel?: string;
  /** `enter`: Enter sends, Shift+Enter is a new line. `mod-enter`: ⌘/Ctrl+Enter sends. */
  readonly submit?: 'enter' | 'mod-enter';
  /** Sending: Send shows its ring and ignores presses; typing still works. */
  readonly busy?: boolean;
  readonly disabled?: boolean;
  /** Whether Send is offered; default: there is non-blank text. */
  readonly canSend?: boolean;
  readonly minRows?: number;
  readonly maxRows?: number;
  /** Docked to the bottom of its scroll parent (default true). */
  readonly pinned?: boolean;
  readonly textareaRef?: (el: HTMLTextAreaElement) => void;
  readonly t?: Translate;
}

/** Whether a keydown in the box should send, given the submit mode. */
export function sendsOn(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>, mode: 'enter' | 'mod-enter'): boolean {
  // An IME composing a word uses Enter to confirm it: that is not a send.
  if (e.key !== 'Enter' || e.isComposing) return false;
  if (mode === 'mod-enter') return e.metaKey || e.ctrlKey;
  return !e.shiftKey && !e.altKey;
}

export function Composer(props: ComposerProps): JSX.Element {
  const t = useT(() => props.t);
  const part = (): PartName => props.part ?? 'ui.composer';
  const box: { el: HTMLTextAreaElement | undefined } = { el: undefined };
  const fit = (): void => {
    if (box.el) fitTextarea(box.el, props.minRows ?? 1, props.maxRows ?? 10);
  };
  const canSend = (): boolean => !props.disabled && !props.busy && (props.canSend ?? props.value.trim() !== '');
  const send = (): void => {
    if (canSend()) props.onSend(props.value);
  };
  onMount(fit);
  // The value also changes from outside (cleared on send, a restored draft): refit then too.
  createEffect(on(() => props.value, fit, { defer: true }));
  return (
    <div
      id={props.id}
      data-kit="composer"
      data-part={part()}
      data-pinned={flag(props.pinned !== false)}
      data-disabled={flag(props.disabled)}
    >
      <Show when={props.head}>
        <div data-kit="composer-head" data-part={sub(part(), 'head')}>{props.head}</div>
      </Show>
      <textarea
        ref={(el) => {
          box.el = el;
          props.textareaRef?.(el);
        }}
        data-kit="composer-input"
        data-part={sub(part(), 'input')}
        rows={props.minRows ?? 1}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props['aria-label'] ?? props.placeholder}
        disabled={props.disabled}
        onInput={(e) => {
          props.onInput(e.currentTarget.value);
          fit();
        }}
        onKeyDown={(e) => {
          if (!sendsOn(e, props.submit ?? 'enter')) return;
          e.preventDefault();
          send();
        }}
      />
      <div data-kit="composer-bar" data-part={sub(part(), 'bar')}>
        <div data-kit="composer-left" data-part={sub(part(), 'left')}>{props.left}</div>
        <div data-kit="composer-right" data-part={sub(part(), 'right')}>
          {props.right}
          <IconButton
            part={sub(part(), 'send')}
            icon="send"
            variant="primary"
            size="sm"
            label={props.sendLabel ?? t('send')}
            loading={props.busy === true}
            disabled={!canSend() && !props.busy}
            onClick={send}
          />
        </div>
      </div>
    </div>
  );
}
