// Projects (v1 features/projects.js openProjects, modals.css .projects-modal): where (This computer, each machine,
// + Machine), the add row (the folder field, Browse… in the app, Add), the hint, your projects (a colour swatch, the
// name you can edit in place, its folder, how many tasks, remove), then the git repos found on this machine, one click
// to add. Value for value from v1; the caller owns the data and the writes, and passes the field (a kit PathField).
import { For, Index, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import type { ReorderAttrs } from '../core/reorder.ts';
import { Icon } from '../content/Icon.tsx';
import { MenuOn, type MenuEntry } from '../controls/Menu.tsx';

export interface ProjectsPlace {
  readonly id: string;
  readonly label: string;
  readonly icon: 'folder' | 'server';
  readonly on: boolean;
  readonly title?: string;
  /** a machine's state: online, or not */
  readonly ok?: boolean;
}

export interface ProjectsRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly count: string;
  readonly color: string;
  readonly reorder?: ReorderAttrs;
}

export interface ProjectsSheetProps {
  readonly places: readonly ProjectsPlace[];
  readonly onPlace: (id: string) => void;
  readonly addMachine?: { readonly label: string; readonly title: string; readonly onClick: () => void } | undefined;
  /** the folder field (a kit PathField, size lg) */
  readonly field: JSX.Element;
  readonly browse?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly add: { readonly label: string; readonly onClick: () => void; readonly busy?: boolean };
  /** the line under it: words, and `{ code }` for a command (v1 `wisp add`) */
  readonly hint: readonly (string | { readonly code: string })[];
  readonly rows: readonly ProjectsRow[];
  readonly empty: string;
  readonly nameLabel: string;
  readonly colourLabel: string;
  readonly colours: readonly MenuEntry[];
  readonly onColour: (id: string, colour: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly removeLabel: (name: string) => string;
  readonly onRemove: (id: string) => void;
  readonly found?:
    | {
        readonly heading: string;
        readonly sub: string;
        readonly items: readonly { readonly path: string; readonly name: string; readonly where: string; readonly label: string }[];
        readonly onAdd: (path: string) => void;
      }
    | undefined;
}

export function ProjectsSheet(props: ProjectsSheetProps): JSX.Element {
  return (
    <div data-kit="pj-sheet" data-part="projects.dialog">
      <div data-kit="pj-where" role="tablist" data-part="projects.where">
        <For each={props.places}>
          {(p) => (
            <button type="button" role="tab" aria-selected={p.on} data-on={flag(p.on)} title={p.title} onClick={() => props.onPlace(p.id)}>
              <Icon name={p.icon} />
              {p.label}
              <Show when={p.ok !== undefined}>
                <i data-kit="pj-dot" data-ok={flag(p.ok)} />
              </Show>
            </button>
          )}
        </For>
        <i data-kit="pj-gap" />
        <Show when={props.addMachine}>
          {(m) => (
            <button type="button" title={m().title} onClick={() => m().onClick()}>
              <Icon name="plus" />
              {m().label}
            </button>
          )}
        </Show>
      </div>
      <div data-kit="pj-add" data-part="projects.add">
        <div data-kit="pj-field">{props.field}</div>
        <Show when={props.browse}>
          {(b) => (
            <button type="button" data-kit="pj-browse" data-part="projects.browse" onClick={() => b().onClick()}>
              <Icon name="folder" />
              {b().label}
            </button>
          )}
        </Show>
        <button type="button" data-kit="pj-go" data-part="projects.go" aria-busy={props.add.busy ? 'true' : undefined} onClick={() => props.add.onClick()}>
          {props.add.label}
        </button>
      </div>
      <p data-kit="pj-hint">
        <Index each={props.hint}>{(h) => (typeof h() === 'string' ? (h() as string) : <code>{(h() as { code: string }).code}</code>)}</Index>
      </p>
      <div data-kit="pj-list" data-part="projects.list">
        <Show when={props.rows.length > 0} fallback={<p data-kit="pj-none">{props.empty}</p>}>
          <For each={props.rows}>
            {(r) => (
              <div {...r.reorder} data-kit="pj-row" data-part="projects.row" data-color={r.color}>
                <Show when={props.rows.length > 1 && r.reorder}>
                  <span data-kit="pj-grip" aria-hidden="true">
                    <Icon name="grip" />
                  </span>
                </Show>
                <MenuOn items={props.colours} onSelect={(v) => props.onColour(r.id, v)} part="projects.row.colour">
                  {(trigger) => (
                    <button type="button" {...trigger()} data-kit="pj-swatch" title={props.colourLabel} aria-label={props.colourLabel}>
                      <i data-kit="pj-pdot" />
                    </button>
                  )}
                </MenuOn>
                <div data-kit="pj-main">
                  <input
                    data-kit="pj-name"
                    value={r.name}
                    aria-label={props.nameLabel}
                    spellcheck={false}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.value = r.name;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim();
                      if (v && v !== r.name) props.onRename(r.id, v);
                      else e.currentTarget.value = r.name;
                    }}
                  />
                  <span data-kit="pj-path" title={r.path}>
                    {r.path}
                  </span>
                </div>
                <span data-kit="pj-count">{r.count}</span>
                <button type="button" data-kit="pj-remove" title={props.removeLabel(r.name)} aria-label={props.removeLabel(r.name)} onClick={() => props.onRemove(r.id)}>
                  <Icon name="trash" />
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={props.found && props.found.items.length > 0 && props.found}>
        {(f) => (
          <div data-kit="pj-discover" data-part="projects.found">
            <h4>
              {f().heading} <span>{f().sub}</span>
            </h4>
            <div data-kit="pj-found">
              <For each={f().items}>
                {(it) => (
                  <button type="button" data-kit="pj-repo" data-part="projects.found.repo" aria-label={it.label} onClick={() => f().onAdd(it.path)}>
                    <Icon name="plus" />
                    <b>{it.name}</b>
                    <span>{it.where}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
