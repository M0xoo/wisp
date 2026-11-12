// v1 features/stuff.js build(): My Stuff's page. The head bar (the keep glyph in its tile, My Stuff and what it is,
// how much is kept, the head's actions and ×), the bar under it (the search with its / key, the kinds, then the
// sort and the grid/list switch), and the shelf: the caller's groups, or v1's empty shelf (three tiles, the
// lines, and "add files").
import { For, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface StuffFrameProps {
  readonly title: string;
  readonly role: string;
  /** how much is kept (3 things · 1.2 MB) */
  readonly count?: string | undefined;
  readonly actions: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly title?: string; readonly onClick: () => void }[];
  readonly close?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly search: { readonly value: string; readonly placeholder: string; readonly label: string; readonly onInput: (v: string) => void };
  /** the kind chips (v1 .sf-kinds), drawn by the caller */
  readonly kinds?: JSX.Element;
  readonly sort: { readonly icon: IconName; readonly label: string; readonly onClick: () => void };
  readonly view: { readonly list: boolean; readonly gridLabel: string; readonly listLabel: string; readonly onPick: (list: boolean) => void };
  /** nothing kept yet: v1's empty shelf */
  readonly empty?: { readonly title: string; readonly keep: readonly [string, string]; readonly asks: readonly [string, string, string, string, string]; readonly mention: readonly [string, string, string]; readonly or: string; readonly add: string; readonly onAdd: () => void } | undefined;
  readonly children?: JSX.Element;
}

export function StuffFrame(props: StuffFrameProps): JSX.Element {
  return (
    <section data-kit="sf-view" data-part="stuff.page" data-list={flag(props.view.list)}>
      <header data-kit="sf-top" data-part="stuff.head">
        <span data-kit="sf-ic">
          <Icon name="stuff" />
        </span>
        <div data-kit="sf-who">
          <h2 data-kit="sf-title">{props.title}</h2>
          <span data-kit="sf-role" data-part="stuff.role">
            {props.role}
          </span>
        </div>
        <span data-kit="sf-state">{props.count}</span>
        <span data-kit="sf-acts">
          <For each={props.actions}>
            {(a) => (
              <button type="button" data-kit="sf-ghost" data-part={`stuff.${a.id}`} data-a={a.id} title={a.title} onClick={() => a.onClick()}>
                <Icon name={a.icon} size="sm" />
                <span>{a.label}</span>
              </button>
            )}
          </For>
          <Show when={props.close}>
            {(x) => (
              <button type="button" data-kit="icon-button" data-variant="ghost" data-size="sm" title={x().label} aria-label={x().label} onClick={() => x().onClick()}>
                <Icon name="x" size="md" />
              </button>
            )}
          </Show>
        </span>
      </header>
      <div data-kit="sf-bar" data-layout="wrap" data-part="stuff.bar">
        <label data-kit="sf-search" data-part="stuff.search">
          <Icon name="search" size="sm" />
          <input type="search" value={props.search.value} placeholder={props.search.placeholder} aria-label={props.search.label} autocomplete="off" spellcheck={false} onInput={(e) => props.search.onInput(e.currentTarget.value)} />
          <kbd data-kit="kbd">/</kbd>
        </label>
        <div data-kit="sf-kinds" data-part="stuff.filters" role="tablist">
          {props.kinds}
        </div>
        <div data-kit="sf-opts">
          <button type="button" data-kit="sf-opt" onClick={() => props.sort.onClick()}>
            <Icon name={props.sort.icon} size="sm" />
            <span>{props.sort.label}</span>
          </button>
          <span data-kit="sf-seg" role="group">
            <button type="button" data-on={flag(!props.view.list)} aria-pressed={!props.view.list} title={props.view.gridLabel} aria-label={props.view.gridLabel} onClick={() => props.view.onPick(false)}>
              <Icon name="grid" size="sm" />
            </button>
            <button type="button" data-on={flag(props.view.list)} aria-pressed={props.view.list} title={props.view.listLabel} aria-label={props.view.listLabel} onClick={() => props.view.onPick(true)}>
              <Icon name="menu" size="sm" />
            </button>
          </span>
        </div>
      </div>
      <div data-kit="sf-body">
        <Show when={props.empty} fallback={props.children}>
          {(e) => (
            <div data-kit="sf-empty" data-part="stuff.empty">
              <div data-kit="sf-shelf" aria-hidden="true">
                <span data-kit="sf-tile" data-n="1">
                  <Icon name="image" />
                </span>
                <span data-kit="sf-tile" data-n="2">
                  <i />
                  <i />
                  <i />
                  <i data-short="" />
                </span>
                <span data-kit="sf-tile" data-n="3">
                  <Icon name="terminal" />
                </span>
              </div>
              <h3>{e().title}</h3>
              <p>
                {e().keep[0]}
                <Icon name="stuff" size="sm" />
                {e().keep[1]}
                <q>{e().asks[0]}</q>
                {e().asks[1]}
                <q>{e().asks[2]}</q>
                {e().asks[3]}
                {e().asks[4]}
              </p>
              <p>
                {e().mention[0]}
                <b>{e().mention[1]}</b>
                {e().mention[2]}
              </p>
              <p data-kit="sf-or">
                {e().or}
                <button type="button" data-kit="link" data-tone="accent" onClick={() => e().onAdd()}>
                  {e().add}
                </button>
                .
              </p>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}
