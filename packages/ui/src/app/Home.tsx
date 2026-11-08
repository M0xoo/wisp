// Home as v1 draws it (web/css/split.css .split-home, launcher.css, composer.css, auto.css, tips):
// the greeting, the prompt box (where it runs, the prompt, its toolbar, Recipes), what needs you,
// then the tips. On a phone it's its own page with a back button in its head.
import { For, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface SplitHomeProps {
  readonly greeting: string;
  /** stack only: back to the list */
  readonly backLabel?: string;
  readonly onBack?: () => void;
  readonly children?: JSX.Element;
}

export function SplitHome(props: SplitHomeProps): JSX.Element {
  return (
    <div data-kit="split-home" data-part="split.home">
      <Show when={props.onBack}>
        <div data-kit="sh-bar">
          <button type="button" data-kit="sh-back" data-part="split.back" aria-label={props.backLabel} title={props.backLabel} onClick={() => props.onBack?.()}>
            <Icon name="back" />
          </button>
          <h2 data-kit="sh-hello" data-part="split.greeting">{props.greeting}</h2>
        </div>
      </Show>
      <Show when={!props.onBack}>
        <h2 data-kit="sh-hello" data-part="split.greeting">{props.greeting}</h2>
      </Show>
      {props.children}
    </div>
  );
}

export interface LauncherTool {
  readonly id: string;
  readonly part: string;
  readonly icon: IconName;
  readonly label: string;
  readonly title: string;
  /** shows its label beside the icon */
  readonly text?: boolean;
  readonly on?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

export interface LauncherProps {
  readonly inLabel: string;
  readonly project: { readonly name: string; readonly title: string; readonly color: string };
  readonly noFolder: string;
  readonly noFolderTitle: string;
  readonly otherFolder: string;
  readonly otherFolderTitle: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onInput: (v: string) => void;
  readonly onSend: () => void;
  readonly inputRef?: (el: HTMLTextAreaElement) => void;
  readonly mode: { readonly label: string; readonly title: string };
  readonly runner: { readonly label: string; readonly title: string; readonly pick: string; readonly pickTitle: string; readonly logo?: string; readonly compare: string };
  /** before the runner: attach, where */
  readonly lead: readonly LauncherTool[];
  /** after the runner: try two ways, delegate */
  readonly mid: readonly LauncherTool[];
  /** after the gap: goal, worktree, later */
  readonly tail: readonly LauncherTool[];
  readonly sendLabel: string;
  readonly recipes: { readonly label: string; readonly empty: string; readonly add: string; readonly issue: string; readonly issueTitle: string };
}

function Tool(props: { readonly t: LauncherTool }): JSX.Element {
  return (
    <button
      type="button"
      data-kit={props.t.text === undefined ? 'icon-btn' : 'tog-btn'}
      data-a={props.t.id}
      data-part={props.t.part}
      data-on={flag(props.t.on)}
      title={props.t.title}
      aria-label={props.t.label}
      aria-disabled={props.t.disabled ? 'true' : undefined}
      onClick={() => !props.t.disabled && props.t.onClick?.()}
    >
      <Icon name={props.t.icon} />
      <Show when={props.t.text}>
        <span data-text="control">{props.t.label}</span>
      </Show>
    </button>
  );
}

/** v1 #launcher: the prompt box on Home. */
export function Launcher(props: LauncherProps): JSX.Element {
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.onSend();
    }
  };
  return (
    <div data-kit="sh-launch">
      <section data-kit="launcher" data-part="launcher">
        <div data-kit="l-projects" data-part="launcher.projects">
          <span data-kit="l-in">{props.inLabel}</span>
          <span data-kit="lp-group">
            <button type="button" data-kit="lp-chip" data-on="" data-color={props.project.color} title={props.project.title}>
              <i data-kit="p-dot" />
              {props.project.name}
            </button>
            <button type="button" data-kit="lp-chip" data-none="" title={props.noFolderTitle}>
              <Icon name="text" />
              <span data-text="control">{props.noFolder}</span>
            </button>
            <button type="button" data-kit="lp-chip" data-add="" title={props.otherFolderTitle}>
              <Icon name="folder" />
              <span data-text="control">{props.otherFolder}</span>
            </button>
          </span>
        </div>
        <div data-kit="mn-wrap">
          <textarea data-kit="prompt" data-part="launcher.input" rows="2" placeholder={props.placeholder} value={props.value} ref={(el) => props.inputRef?.(el)} onInput={(e) => props.onInput(e.currentTarget.value)} onKeyDown={key} />
        </div>
        <div data-kit="l-bar">
          <For each={props.lead}>{(t) => <Tool t={t} />}</For>
          <button type="button" data-kit="mode-btn" data-part="launcher.mode" title={props.mode.title}>
            <Icon name="spark" />
            <span data-text="control">{props.mode.label}</span>
          </button>
          <div data-kit="runners">
            <button type="button" data-kit="runner-btn" data-part="launcher.harness" title={props.runner.title}>
              <span data-kit="rb-logo">
                <i data-kit="auto-mark"><Icon name="spark" /></i>
              </span>
              <span data-kit="rb-h" data-text="control">{props.runner.label}</span>
              <Icon name="chevron" />
            </button>
            <button type="button" data-kit="auto-pv" data-part="launcher.autoPreview" title={props.runner.pickTitle} aria-label={props.runner.pickTitle}>
              <span data-kit="rb-logo" data-small="">
                <Show when={props.runner.logo}>{(src) => <img src={src()} alt="" />}</Show>
              </span>
              <span data-kit="apv-l" data-text="control">{props.runner.pick}</span>
            </button>
            <button type="button" data-kit="vs-btn" data-part="launcher.compare" title={props.runner.compare} aria-label={props.runner.compare}>
              <Icon name="plus" />
            </button>
          </div>
          <For each={props.mid}>{(t) => <Tool t={t} />}</For>
          <span data-kit="grow" />
          <For each={props.tail}>{(t) => <Tool t={t} />}</For>
          <button type="button" data-kit="send" data-part="launcher.send" title={props.sendLabel} aria-label={props.sendLabel} onClick={() => props.onSend()}>
            <Icon name="enter" />
          </button>
        </div>
        <div data-kit="l-foot">
          <div data-kit="l-recipes" data-part="launcher.recipes">
            <div data-kit="lr-list">
              <span data-kit="l-in" data-icon="">
                <Icon name="bolt" />
                {props.recipes.label}
              </span>
              <span data-kit="lr-empty">{props.recipes.empty}</span>
              <button type="button" data-kit="lp-chip" data-add="" data-small="">
                <Icon name="plus" />
                {props.recipes.add}
              </button>
            </div>
            <button type="button" data-kit="lp-chip" data-small="" data-part="launcher.issue" title={props.recipes.issueTitle} aria-label={props.recipes.issueTitle}>
              <Icon name="issue" />
              <span data-text="control">{props.recipes.issue}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export interface NextRow {
  readonly id: string;
  readonly title: string;
  readonly color: string;
  readonly state?: string;
  readonly time: string;
  readonly timeTitle: string;
}

/** v1 .sh-next: what needs you, up to five, each opening its task. */
export function NextList(props: { readonly heading: string; readonly count: number; readonly rows: readonly NextRow[]; readonly onOpen: (id: string) => void }): JSX.Element {
  return (
    <div data-kit="sh-next" data-part="split.next">
      <h4>
        {props.heading}
        <span data-kit="sec-n">{props.count}</span>
      </h4>
      <For each={props.rows}>
        {(r) => (
          <button type="button" data-kit="sh-task" data-color={r.color} data-id={r.id} onClick={() => props.onOpen(r.id)}>
            <span data-kit="q-dot" />
            <span data-kit="sh-t" data-text="control" title={r.title}>{r.title}</span>
            <Show when={r.state}>
              <span data-kit="sh-s">{r.state}</span>
            </Show>
            <span data-kit="sh-time" title={r.timeTitle}>{r.time}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export interface SetupTip {
  readonly kind: 'tool' | 'grid';
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly cta: string;
  readonly onClick?: () => void;
}

export interface PlainTip {
  /** the text, split around its bold words */
  readonly before: string;
  readonly bold: string;
  readonly after: string;
  readonly href?: string;
}

/** v1 .sh-tips: setup cards, then one-line tips. */
export function Tips(props: { readonly heading: string; readonly more: string; readonly moreTitle: string; readonly setup: readonly SetupTip[]; readonly tips: readonly PlainTip[]; readonly onMore?: () => void }): JSX.Element {
  return (
    <div data-kit="sh-tips" data-part="tips">
      <h4>
        {props.heading}
        <button type="button" data-kit="tip-more" title={props.moreTitle} onClick={() => props.onMore?.()}>{props.more}</button>
      </h4>
      <For each={props.setup}>
        {(s) => (
          <button type="button" data-kit="sh-tip" data-setup="" data-part={s.kind === 'grid' ? 'tips.setup tips.grid' : 'tips.setup tips.tools'} onClick={() => s.onClick?.()}>
            <span data-kit="ts-badge"><Icon name={s.icon} /></span>
            <span data-kit="ts-text">
              <b>{s.title}</b>
              <small>{s.body}</small>
            </span>
            <span data-kit="ts-cta">
              {s.cta}
              <Icon name="arrow" />
            </span>
          </button>
        )}
      </For>
      <For each={props.tips}>
        {(t) => (
          <a data-kit="sh-tip" href={t.href ?? '#'} onClick={(e) => e.preventDefault()}>
            <Icon name="spark" />
            <span>
              {t.before}
              <b>{t.bold}</b>
              {t.after}
            </span>
            <Icon name="external" />
          </a>
        )}
      </For>
    </div>
  );
}

/** v1 .sh-keys: the list's keys, in a line under the tips (not on a phone). */
export function KeysHint(props: { readonly items: readonly { readonly keys: readonly string[]; readonly label: string }[] }): JSX.Element {
  return (
    <p data-kit="sh-keys">
      <For each={props.items}>
        {(it, i) => (
          <>
            <For each={it.keys}>{(k) => <kbd>{k}</kbd>}</For>
            {` ${it.label}${i() < props.items.length - 1 ? ' · ' : ''}`}
          </>
        )}
      </For>
    </p>
  );
}
