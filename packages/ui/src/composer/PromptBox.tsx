// PromptBox: the reply box and New task's frame (v1 .composer / #launcher). Unlike `Composer` it
// has no Send of its own: every control, Send and Stop included, is an item of one kit Toolbar, so
// the bar folds labels to icons and then into More by priority and never takes a second line
// (design/layout.md §2, the "Full auto on two lines" bug). Above the text sit what goes with it
// (`top`: queued follow-ups, file chips in a Wrap), and over the box floats one popup (the / and @
// menus). Files pasted or dropped come out as `onFiles`; the text is controlled from outside (drafts).
import { createEffect, createSignal, on, onMount, Show, type JSX } from 'solid-js';
import { fitTextarea } from '../core/autosize.ts';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { Toolbar, type ToolbarItem } from '../composites/Toolbar.tsx';

export interface PromptBoxProps extends KitProps {
  readonly value: string;
  readonly onInput: (value: string, el: HTMLTextAreaElement) => void;
  readonly placeholder?: string;
  readonly 'aria-label': string;
  /** One line above the bar: *Side question · Claude Code keeps working*. Ends in … when long. */
  readonly head?: JSX.Element;
  /** Between the head and the text: queued follow-ups, file chips. */
  readonly top?: JSX.Element;
  /** Under the text, above the bar: a time chip, a hold row. */
  readonly bottom?: JSX.Element;
  /** The bar: Send/Stop are pinned items; the rest declare their priority. */
  readonly items: readonly ToolbarItem[];
  readonly 'bar-label': string;
  /** Floats over the box, above it (the / and @ menus). */
  readonly popup?: JSX.Element;
  /** The popup's listbox id and its active option, for the textarea's combobox semantics. */
  readonly listbox?: { readonly id: string; readonly active?: string | undefined } | undefined;
  readonly onKeyDown?: (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Any paste, before files are taken from it; preventDefault() keeps it from the box. */
  readonly onPaste?: (e: ClipboardEvent & { currentTarget: HTMLTextAreaElement }) => void;
  /** Files pasted into the box or dropped on it. */
  readonly onFiles?: (files: File[]) => void;
  /** The drop target's name while a drag is over it ("Drop to attach"). */
  readonly dropLabel?: string;
  readonly disabled?: boolean;
  readonly minRows?: number;
  readonly maxRows?: number;
  /** Docked to the bottom of its scroll parent (default true). */
  readonly pinned?: boolean;
  /** Folded: one quiet line until focused (v1's split-view reply box). */
  readonly folded?: boolean;
  readonly textareaRef?: (el: HTMLTextAreaElement) => void;
}

const filesOf = (list: FileList | null | undefined): File[] => (list ? [...list] : []);

export function PromptBox(props: PromptBoxProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.prompt';
  const box: { el: HTMLTextAreaElement | undefined } = { el: undefined };
  const [dragging, setDragging] = createSignal(0);
  const fit = (): void => {
    if (box.el) fitTextarea(box.el, props.minRows ?? 1, props.maxRows ?? 10);
  };
  onMount(fit);
  // The value changes from outside too (cleared on send, a restored draft, history): refit then.
  createEffect(on(() => props.value, fit, { defer: true }));
  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  return (
    <div
      id={props.id}
      data-kit="composer"
      data-part={part()}
      data-pinned={flag(props.pinned !== false)}
      data-disabled={flag(props.disabled)}
      data-folded={flag(props.folded)}
      data-drop={flag(dragging() > 0)}
      data-drop-label={dragging() > 0 ? props.dropLabel : undefined}
      onDragEnter={(e) => {
        if (!props.onFiles || !hasFiles(e)) return;
        e.preventDefault();
        setDragging((n) => n + 1);
      }}
      onDragOver={(e) => {
        if (props.onFiles && hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => setDragging((n) => Math.max(0, n - 1))}
      onDrop={(e) => {
        setDragging(0);
        const files = filesOf(e.dataTransfer?.files);
        if (!props.onFiles || files.length === 0) return;
        e.preventDefault();
        props.onFiles(files);
      }}
    >
      <Show when={props.popup}>
        <div data-kit="prompt-popup" data-part={sub(part(), 'popup')}>{props.popup}</div>
      </Show>
      <Show when={props.top}>
        <div data-kit="prompt-top" data-part={sub(part(), 'top')}>{props.top}</div>
      </Show>
      <textarea
        ref={(el) => {
          box.el = el;
          props.textareaRef?.(el);
        }}
        data-kit="composer-input"
        data-part={sub(part(), 'input')}
        rows={props.minRows ?? 1}
        spellcheck={false}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props['aria-label']}
        disabled={props.disabled}
        role={props.listbox ? 'combobox' : undefined}
        aria-autocomplete={props.listbox ? 'list' : undefined}
        aria-expanded={props.listbox ? true : undefined}
        aria-controls={props.listbox?.id}
        aria-activedescendant={props.listbox?.active}
        onInput={(e) => {
          props.onInput(e.currentTarget.value, e.currentTarget);
          fit();
        }}
        onKeyDown={(e) => props.onKeyDown?.(e)}
        onFocus={() => props.onFocus?.()}
        onBlur={() => props.onBlur?.()}
        onPaste={(e) => {
          props.onPaste?.(e);
          if (e.defaultPrevented) return;
          const files = filesOf(e.clipboardData?.files);
          if (!props.onFiles || files.length === 0) return;
          e.preventDefault();
          props.onFiles(files);
        }}
      />
      <Show when={props.bottom}>
        <div data-kit="prompt-bottom" data-part={sub(part(), 'bottom')}>{props.bottom}</div>
      </Show>
      <Show when={props.head}>
        <div data-kit="composer-head" data-part={sub(part(), 'head')} data-text="control">{props.head}</div>
      </Show>
      <Toolbar part={sub(part(), 'bar')} aria-label={props['bar-label']} items={props.items} gap="2" />
    </div>
  );
}
