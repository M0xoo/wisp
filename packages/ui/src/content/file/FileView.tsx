// FileView: a file to read and edit (v1 features/editor.js, design/v1-reference/task.editor): line numbers, the
// highlighted text with an editable layer over it (a textarea whose text is transparent, so the colours show and
// the caret, selection and typing are the browser's own), and an optional why-gutter: each line's task, a click
// opens it. The gutter and the numbers scroll with the text; nothing reflows on a keystroke but the text itself.
import { For, Show, createEffect, createMemo, type JSX } from 'solid-js';
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
  /** the line to show (scrolled to, its number marked, the caret at its start): Go to definition's */
  readonly line?: number | undefined;
  /** the lines selected (1-based, inclusive), as the selection changes; undefined when it's only a caret */
  readonly onSelectLines?: (lines: { readonly from: number; readonly to: number } | undefined) => void;
  /** ⌘-click (Ctrl-click) or F12 on a name: where is it declared? */
  readonly onDefinition?: (name: string) => void;
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

/** The line (1-based) an offset in `text` is on. */
export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The name around an offset (letters, digits, _ and $), or undefined. */
export function nameAt(text: string, offset: number): string | undefined {
  const w = /[A-Za-z0-9_$]/;
  let a = offset;
  let b = offset;
  while (a > 0 && w.test(text[a - 1] ?? '')) a--;
  while (b < text.length && w.test(text[b] ?? '')) b++;
  const name = text.slice(a, b);
  return name && !/^[0-9]/.test(name) ? name : undefined;
}

export function FileView(props: FileViewProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.file-view';
  const lines = createMemo(() => props.text.split('\n').length);
  const tokens = createMemo(() => highlight(props.text, props.lang));
  const numbers = createMemo(() => Array.from({ length: lines() }, (_, i) => i + 1));
  let box: HTMLDivElement | undefined;
  let area: HTMLTextAreaElement | undefined;
  const selected = (): void => {
    if (!area || !props.onSelectLines) return;
    const { selectionStart: a, selectionEnd: b, value } = area;
    props.onSelectLines(a === b ? undefined : { from: lineAt(value, a), to: lineAt(value, Math.max(a, b - 1)) });
  };
  const definition = (): void => {
    if (!area || !props.onDefinition) return;
    const name = nameAt(area.value, area.selectionStart);
    if (name) props.onDefinition(name);
  };
  // Go to definition's line: in view, its number marked, the caret at its start
  createEffect(() => {
    const n = props.line;
    if (!n || !area || !box) return;
    const lines = props.text.split('\n');
    const at = lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
    area.setSelectionRange(at, at);
    const row = box.querySelector<HTMLElement>(`[data-kit="fv-nums"] > span:nth-child(${n})`);
    if (row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 3);
  });
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'F12') {
      e.preventDefault();
      definition();
      return;
    }
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
      <div ref={(el) => (box = el)} id={props.id} data-kit="file-view" data-part={part()} data-gutter={flag(props.gutter !== undefined)} style={{ '--k-digits': String(String(lines()).length) }}>
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
          <For each={numbers()}>{(n) => <span data-on={flag(n === props.line)}>{n}</span>}</For>
        </div>
        <div data-kit="fv-text">
          <pre data-kit="fv-pre" aria-hidden="true">
            <code data-lang={props.lang}>
              <For each={tokens()}>{(tk) => (tk.kind ? <span data-tk={tk.kind}>{tk.text}</span> : tk.text)}</For>
              {'\n'}
            </code>
          </pre>
          <textarea
            ref={(el) => (area = el)}
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
            onSelect={selected}
            onKeyUp={selected}
            onMouseUp={selected}
            onClick={(e) => (e.metaKey || e.ctrlKey) && definition()}
          />
        </div>
      </div>
    </div>
  );
}
