// FileView: a file to read and edit (v1 features/editor.js, design/v1-reference/task.editor): line numbers, the
// highlighted text with an editable layer over it (a textarea whose text is transparent, so the colours show and
// the caret, selection and typing are the browser's own), and an optional why-gutter: each line's task, a click
// opens it. The gutter and the numbers scroll with the text; nothing reflows on a keystroke but the text itself.
import { For, Show, createMemo, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../../core/props.ts';
import { highlight } from '../highlight.ts';

/** One line's mark in the why-gutter: who wrote it (a short label) and why (its title). */
export interface GutterMark {
  readonly label: string;
  readonly title?: string;
  /** a new task starts here (the line before was another's): the label shows, else only a thread */
  readonly first?: boolean;
  readonly onOpen?: () => void;
}

export interface FileViewProps extends KitProps {
  readonly text: string;
  /** a language for colours (`ts`, `py`…), from the file's extension */
  readonly lang?: string | undefined;
  /** typing changes it; without it the view is read-only */
  readonly onInput?: (text: string) => void;
  /** ⌘S / Ctrl+S */
  readonly onSave?: () => void;
  /** the why-gutter, one mark per line (1-based: index 0 is line 1); none: no gutter */
  readonly gutter?: readonly (GutterMark | undefined)[] | undefined;
  readonly 'aria-label': string;
}

/** The language for a file name's extension (`a/b.test.ts` → `ts`). */
export function langOfPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  if (/^(Dockerfile|Makefile)$/i.test(name)) return name.toLowerCase();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : undefined;
}

export function FileView(props: FileViewProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.file-view';
  const lines = createMemo(() => props.text.split('\n').length);
  const tokens = createMemo(() => highlight(props.text, props.lang));
  const numbers = createMemo(() => Array.from({ length: lines() }, (_, i) => i + 1));
  const key = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      props.onSave?.();
      return;
    }
    // Tab indents (two spaces) instead of leaving the editor; Shift+Tab leaves it
    if (e.key === 'Tab' && !e.shiftKey && props.onInput) {
      e.preventDefault();
      const el = e.currentTarget as HTMLTextAreaElement;
      el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
      props.onInput(el.value);
    }
  };
  return (
    <div data-kit="fv-wrap">
      <div id={props.id} data-kit="file-view" data-part={part()} data-gutter={flag(props.gutter !== undefined)} style={{ '--k-digits': String(String(lines()).length) }}>
        <Show when={props.gutter}>
          {(g) => (
            <div data-kit="fv-why" data-part={sub(part(), 'why')} aria-hidden="false">
              <For each={numbers()}>
                {(n) => {
                  const m = (): GutterMark | undefined => g()[n - 1];
                  return (
                    <Show when={m()} fallback={<span data-kit="fv-why-line" />}>
                      {(mark) => (
                        <button
                          type="button"
                          data-kit="fv-why-line"
                          data-first={flag(mark().first)}
                          title={mark().title ?? mark().label}
                          tabIndex={mark().first ? 0 : -1}
                          onClick={() => mark().onOpen?.()}
                        >
                          <Show when={mark().first}>{mark().label}</Show>
                        </button>
                      )}
                    </Show>
                  );
                }}
              </For>
            </div>
          )}
        </Show>
        <div data-kit="fv-nums" data-part={sub(part(), 'numbers')} aria-hidden="true">
          <For each={numbers()}>{(n) => <span>{n}</span>}</For>
        </div>
        <div data-kit="fv-text">
          <pre data-kit="fv-pre" aria-hidden="true">
            <code data-lang={props.lang}>
              <For each={tokens()}>{(tk) => (tk.kind ? <span data-tk={tk.kind}>{tk.text}</span> : tk.text)}</For>
              {'\n'}
            </code>
          </pre>
          <textarea
            data-kit="fv-input"
            data-part={sub(part(), 'input')}
            aria-label={props['aria-label']}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            wrap="off"
            readOnly={!props.onInput}
            value={props.text}
            onInput={(e) => props.onInput?.(e.currentTarget.value)}
            onKeyDown={key}
          />
        </div>
      </div>
    </div>
  );
}
