// Automations (v1 features/automations.js openAutomations, automations.css): the lede, Recipes · Triggers with their
// counts, then the tab's list (each item an icon, its name, a line, tags and actions), "+ New …" and a hint; or a
// form: the trigger kinds as tiles (v1 .au-kinds), then rows of a label and its control (.au-form), the When presets
// with what the box will do read back, a warning, and Cancel / Create. Value for value; the owner draws the data.
import { For, Index, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

/** words with `{ code }` runs, as v1 wrote `<code>{name}</code>` in its lines */
export type Rich = readonly (string | { readonly code: string })[];

function RichText(props: { readonly text: Rich }): JSX.Element {
  return <Index each={props.text}>{(x) => (typeof x() === 'string' ? (x() as string) : <code>{(x() as { code: string }).code}</code>)}</Index>;
}

export interface AutomationsTab {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export function AutomationsBody(props: {
  readonly lede: Rich;
  readonly tabs: readonly AutomationsTab[];
  readonly tab: string;
  readonly onTab: (v: string) => void;
  readonly children?: JSX.Element;
}): JSX.Element {
  return (
    <div data-kit="au-body" data-part="automations.modal.body">
      <p data-kit="au-lede">
        <RichText text={props.lede} />
      </p>
      <div data-kit="au-tabs" role="tablist" data-part="automations.tabs">
        <For each={props.tabs}>
          {(x) => (
            <button type="button" role="tab" aria-selected={props.tab === x.value} data-on={flag(props.tab === x.value)} data-value={x.value} onClick={() => props.onTab(x.value)}>
              {x.label}
              <span>{x.count}</span>
            </button>
          )}
        </For>
      </div>
      {props.children}
    </div>
  );
}

export interface AutoItem {
  readonly id: string;
  readonly icon: IconName;
  readonly name: string;
  readonly line: Rich;
  readonly tags?: readonly string[];
  readonly off?: boolean;
  readonly actions?: JSX.Element;
}

export function AutoList(props: {
  readonly items: readonly AutoItem[];
  readonly empty: string;
  readonly add: { readonly label: string; readonly onClick: () => void };
  readonly hint?: Rich;
}): JSX.Element {
  return (
    <>
      <div data-kit="au-list" data-part="automations.list">
        <Show when={props.items.length > 0} fallback={<p data-kit="au-empty">{props.empty}</p>}>
          <For each={props.items}>
            {(it) => (
              <div data-kit="au-item" data-off={flag(it.off)} data-part="automations.item">
                <span data-kit="au-ico">
                  <Icon name={it.icon} />
                </span>
                <div data-kit="au-main">
                  <b>{it.name}</b>
                  <p>
                    <RichText text={it.line} />
                  </p>
                  <Show when={(it.tags?.length ?? 0) > 0}>
                    <span data-kit="au-tags">
                      <For each={it.tags}>{(t) => <i>{t}</i>}</For>
                    </span>
                  </Show>
                </div>
                <Show when={it.actions}>
                  <span data-kit="au-acts">{it.actions}</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
      <button type="button" data-kit="au-add" data-part="automations.new" onClick={() => props.add.onClick()}>
        <Icon name="plus" />
        {props.add.label}
      </button>
      <Show when={props.hint}>
        {(h) => (
          <p data-kit="au-hint">
            <RichText text={h()} />
          </p>
        )}
      </Show>
    </>
  );
}

export interface TriggerKind {
  /** the tile's own key (a kind, or kind:preset) */
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
}

/** v1 .au-kinds: three across (two on a narrow dialog), the picked one in the accent */
export function TriggerKinds(props: { readonly kinds: readonly TriggerKind[]; readonly value: string; readonly onPick: (key: string) => void }): JSX.Element {
  return (
    <div data-kit="au-kinds" data-part="automations.kinds">
      <For each={props.kinds}>
        {(k) => (
          <button type="button" data-on={flag(props.value === k.key)} aria-pressed={props.value === k.key} data-kind={k.key} onClick={() => props.onPick(k.key)}>
            <Icon name={k.icon} />
            <b>{k.label}</b>
            <small>{k.hint}</small>
          </button>
        )}
      </For>
    </div>
  );
}

/** v1 .au-form > label: the label (92px) and its control on one row, a line under; `stack`: the label over it */
export function AutoRow(props: { readonly label: JSX.Element; readonly stack?: boolean; readonly part?: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <div data-kit="au-row" data-stack={flag(props.stack)} data-part={props.part ?? 'automations.row'}>
      <span data-kit="au-label">{props.label}</span>
      {props.children}
    </div>
  );
}

/** v1 .au-presets: the schedule's chips under When (a group that wraps, as v1's), and what the box will do read back */
export function AutoPresets(props: {
  readonly items: readonly string[];
  readonly onPick: (v: string) => void;
  readonly read?: { readonly text: string; readonly bad?: boolean } | undefined;
}): JSX.Element {
  return (
    <p data-kit="au-presets" data-layout="wrap" data-part="automations.presets">
      <For each={props.items}>
        {(w) => (
          <button type="button" data-kit="lp-chip" onClick={() => props.onPick(w)}>
            {w.charAt(0).toUpperCase() + w.slice(1)}
          </button>
        )}
      </For>
      <span data-kit="au-read" data-bad={flag(props.read?.bad)} aria-live="polite">
        {props.read?.text ?? ''}
      </span>
    </p>
  );
}

export function AutoNote(props: { readonly tone: 'warn' | 'muted'; readonly children: JSX.Element }): JSX.Element {
  return (
    <p data-kit={props.tone === 'warn' ? 'au-warn' : 'au-note'}>
      <Show when={props.tone === 'warn'}>
        <Icon name="warn" />
      </Show>
      <span>{props.children}</span>
    </p>
  );
}

export function AutoFoot(props: { readonly cancel: string; readonly ok: string; readonly busy?: boolean; readonly onCancel: () => void; readonly onOk: () => void }): JSX.Element {
  return (
    <div data-kit="au-foot" data-part="automations.foot">
      <button type="button" data-kit="au-cancel" onClick={() => props.onCancel()}>
        {props.cancel}
      </button>
      <button type="button" data-kit="au-ok" data-part="automations.create" aria-busy={props.busy ? 'true' : undefined} onClick={() => props.onOk()}>
        {props.ok}
      </button>
    </div>
  );
}
