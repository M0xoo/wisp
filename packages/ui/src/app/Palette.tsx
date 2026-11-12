// v1 web/js/palette.js (⌘K): one sheet, the input along its top (a search glyph, 16px text), the grouped list
// under it (a faint group line, then 38px rows: the lead, a project's dot or an icon, the label with what the query
// found marked, a faint second part on the same line, the shortcut at the end), and the keys along the bottom.
// The caller owns the query, the ranking and the selection; this draws them.
import { For, Show, type JSX } from 'solid-js';
import type { ProjectColor } from '@wisp/tokens';
import { flag, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { Dot } from '../shell-list/Dot.tsx';

export interface PaletteRow {
  readonly id: string;
  /** the group line over this row (only on a group's first row) */
  readonly head?: string;
  /** the label in runs, the found ones marked */
  readonly label: readonly (readonly [string, boolean])[];
  readonly sub?: string;
  readonly dot?: ProjectColor;
  readonly icon?: IconName;
  readonly kbd?: readonly string[];
  readonly tip?: string;
}

export interface PaletteSheetProps {
  readonly value: string;
  readonly placeholder: string;
  /** the listbox's name (Command palette) */
  readonly label: string;
  readonly rows: readonly PaletteRow[];
  readonly selected: number;
  /** shown when there are no rows (No results for “…”) */
  readonly empty: string;
  readonly foot: { readonly navigate: string; readonly open: string; readonly close: string };
  readonly onInput: (value: string) => void;
  readonly onKeyDown: (e: KeyboardEvent) => void;
  readonly onPick: (i: number) => void;
  /** the pointer moved over a row (mousemove, not enter: rows sliding under a still pointer don't take it) */
  readonly onHover: (i: number) => void;
  readonly inputRef?: (el: HTMLInputElement) => void;
  readonly part?: PartName;
}

export const paletteRowId = (i: number): string => `palette-row-${i}`;

export function PaletteSheet(props: PaletteSheetProps): JSX.Element {
  return (
    <div data-kit="pal" data-part={props.part ?? 'shell.palette'}>
      <div data-kit="pal-input" data-part="shell.palette.input">
        <Icon name="search" size="md" />
        <input
          ref={(el) => props.inputRef?.(el)}
          type="text"
          value={props.value}
          placeholder={props.placeholder}
          spellcheck={false}
          autocomplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="palList"
          aria-label={props.label}
          aria-activedescendant={props.rows.length > 0 ? paletteRowId(props.selected) : undefined}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => props.onKeyDown(e)}
        />
      </div>
      <div data-kit="pal-list" id="palList" role={props.rows.length > 0 ? 'listbox' : 'presentation'} aria-label={props.label} data-part="shell.palette.list">
        <Show when={props.rows.length > 0} fallback={<div data-kit="pal-empty">{props.empty}</div>}>
          <For each={props.rows}>
            {(r, i) => (
              <>
                <Show when={r.head}>
                  <div data-kit="pal-group" data-part="shell.palette.group">
                    {r.head}
                  </div>
                </Show>
                <div
                  id={paletteRowId(i())}
                  data-kit="pal-row"
                  data-part="shell.palette.row"
                  data-on={flag(i() === props.selected)}
                  role="option"
                  aria-selected={i() === props.selected}
                  title={r.tip}
                  onMouseMove={() => i() !== props.selected && props.onHover(i())}
                  onClick={() => props.onPick(i())}
                >
                  <span data-kit="pal-lead">
                    <Show when={r.dot} fallback={<Icon name={r.icon ?? 'arrow'} size="sm" />}>
                      {(c) => <Dot size="md" color={c()} />}
                    </Show>
                  </span>
                  <span data-kit="pal-label">
                    <For each={r.label}>{([text, hit]) => (hit ? <mark>{text}</mark> : text)}</For>
                  </span>
                  <Show when={r.sub}>
                    <span data-kit="pal-sub">{r.sub}</span>
                  </Show>
                  <Show when={r.kbd}>
                    {(k) => (
                      <span data-kit="pal-kbd">
                        <For each={k()}>{(key) => <kbd data-kit="kbd">{key}</kbd>}</For>
                      </span>
                    )}
                  </Show>
                </div>
              </>
            )}
          </For>
        </Show>
      </div>
      <footer data-kit="pal-foot" data-part="shell.palette.foot">
        <span>
          <kbd data-kit="kbd">↑</kbd>
          <kbd data-kit="kbd">↓</kbd> {props.foot.navigate}
        </span>
        <span>
          <kbd data-kit="kbd">↵</kbd> {props.foot.open}
        </span>
        <span>
          <kbd data-kit="kbd">esc</kbd> {props.foot.close}
        </span>
      </footer>
    </div>
  );
}
