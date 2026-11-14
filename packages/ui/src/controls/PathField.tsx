// PathField: a folder path typed with the server's suggestions under it (v1 projects.js .path-input + .suggest, fed by
// GET /fs?q=). ↑↓ move through the suggestions, Tab completes the one picked (or the first) and goes on into it, Enter
// or a click picks it (Enter with none picked submits what's typed), Escape closes the list. The caller asks the
// server (`suggest`) and decides what a pick does; what's typed stays the caller's value.
import { createEffect, createSignal, createUniqueId, For, Show, type JSX } from 'solid-js';
import { useTimeout } from '../blocks/rich-scope.ts';
import { flag, sub, type KitProps, type Labelled, type PartName } from '../core/props.ts';
import { Input, type FieldSize } from './Input.tsx';

export interface PathFieldProps extends KitProps, Labelled {
  readonly value: string;
  readonly onInput: (value: string) => void;
  /** The folders what's typed could go on to (absolute paths); asked 120 ms after the last keystroke. */
  readonly suggest: (q: string) => Promise<readonly string[]>;
  /** A suggestion picked (a click, or Enter on the highlighted one). */
  readonly onPick: (path: string) => void;
  /** Enter with no suggestion highlighted: what's typed. */
  readonly onEnter?: (value: string) => void;
  /** How a path shows in the list (`~/code` for the home folder's); as is by default. */
  readonly label?: (path: string) => string;
  /** What Tab puts in the box for a path (the label's form, then a separator); `path/` by default. */
  readonly complete?: (path: string) => string;
  /** No suggestions for this text (a git URL typed into a box that takes either). */
  readonly skip?: (q: string) => boolean;
  readonly placeholder?: string;
  readonly size?: FieldSize;
  readonly disabled?: boolean;
  readonly ref?: (el: HTMLInputElement) => void;
}

const WAIT_MS = 120;

export function PathField(props: PathFieldProps): JSX.Element {
  const id = createUniqueId();
  const part = (): PartName => props.part ?? 'ui.path-field';
  const [items, setItems] = createSignal<readonly string[]>([]);
  const [at, setAt] = createSignal(-1);
  let input: HTMLInputElement | undefined;
  // both owned by this field: unmounting frees them
  const wait = useTimeout();
  const blur = useTimeout();
  let asked = 0;
  const close = (): void => {
    setItems([]);
    setAt(-1);
  };
  const ask = (q: string): void => {
    wait.stop();
    if (!q || props.skip?.(q)) return close();
    const n = ++asked;
    wait.start(WAIT_MS, () => {
      props.suggest(q).then(
        (list) => {
          if (n !== asked) return; // a later keystroke asked again
          setItems(list);
          setAt(-1);
        },
        () => n === asked && close(),
      );
    });
  };
  const pick = (path: string): void => {
    close();
    props.onPick(path);
  };
  const key = (e: KeyboardEvent): void => {
    const list = items();
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length) {
      e.preventDefault();
      setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
    } else if (e.key === 'Tab' && !e.shiftKey && list.length) {
      e.preventDefault();
      const p = list[Math.max(0, at())] ?? '';
      const next = props.complete ? props.complete(p) : `${p}/`;
      props.onInput(next);
      ask(next);
    } else if (e.key === 'Escape' && list.length) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const p = list[at()];
      if (p !== undefined) pick(p);
      else {
        close();
        props.onEnter?.(props.value.trim());
      }
    }
  };
  // the kit Input owns the box; the combobox wiring rides on its element
  createEffect(() => {
    if (!input) return;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', `${id}-list`);
    input.setAttribute('aria-expanded', String(items().length > 0));
    if (at() >= 0) input.setAttribute('aria-activedescendant', `${id}-${at()}`);
    else input.removeAttribute('aria-activedescendant');
  });
  return (
    <div data-kit="path-field" data-part={part()} data-open={flag(items().length > 0)}>
      <Input
        ref={(el) => {
          input = el;
          props.ref?.(el);
        }}
        mono
        icon="folder"
        spellcheck={false}
        autocomplete="off"
        value={props.value}
        onInput={(v) => {
          props.onInput(v);
          ask(v);
        }}
        onKeyDown={key}
        onFocus={() => (blur.stop(), props.value && ask(props.value))}
        onBlur={() => blur.start(WAIT_MS, close)}
        {...(props.size && { size: props.size })}
        {...(props.disabled !== undefined && { disabled: props.disabled })}
        {...(props.placeholder !== undefined && { placeholder: props.placeholder })}
        {...(props['aria-label'] !== undefined && { 'aria-label': props['aria-label'] })}
      />
      <Show when={items().length > 0}>
        <div id={`${id}-list`} role="listbox" data-kit="path-suggest" data-part={sub(part(), 'suggest')}>
          <For each={items()}>
            {(p, i) => (
              <div
                id={`${id}-${i()}`}
                role="option"
                aria-selected={at() === i()}
                data-kit="path-option"
                data-on={flag(at() === i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
              >
                {props.label ? props.label(p) : p}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
