// The open task as v1 draws it in the main pane (web/css/split.css .split-head, panel.css .it-body,
// .it-bar, .it-actions, transcript.css .turn/.ask/.trail, ship.css .overlap-strip, composer.css):
// its head, then its turns with the details column beside them, and the reply box docked at the foot.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface TaskHeadProps {
  readonly title: string;
  readonly color: string;
  readonly renameLabel: string;
  readonly panelLabel: string;
  readonly closeLabel: string;
  /** stack only: back to the list */
  readonly backLabel?: string;
  readonly onBack?: () => void;
  readonly onPanel?: () => void;
  readonly onClose?: () => void;
}

/** v1 #splitHead: the dot, the title, the side panel and close buttons (back on a phone). */
export function TaskHead(props: TaskHeadProps): JSX.Element {
  return (
    <header data-kit="split-head" data-part="split.head" data-color={props.color}>
      <div data-kit="sh-row">
        <Show when={props.onBack} fallback={<span data-kit="q-dot" />}>
          <button type="button" data-kit="sh-back" data-part="split.back" aria-label={props.backLabel} title={props.backLabel} onClick={() => props.onBack?.()}>
            <Icon name="back" />
          </button>
        </Show>
        <h2 data-kit="sh-title" data-part="split.title" title={props.renameLabel}>{props.title}</h2>
        <span data-kit="sh-acts">
          <Show when={!props.onBack}>
            <button type="button" data-kit="head-btn" aria-label={props.panelLabel} title={props.panelLabel} onClick={() => props.onPanel?.()}>
              <Icon name="panel" />
            </button>
            <button type="button" data-kit="head-btn" aria-label={props.closeLabel} title={props.closeLabel} onClick={() => props.onClose?.()}>
              <Icon name="x" />
            </button>
          </Show>
        </span>
      </div>
    </header>
  );
}

export interface TaskAction {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly title: string;
  readonly part?: string;
  readonly tone?: 'good';
  /** its key, shown at the row's end */
  readonly key?: string;
  /** desktop only: on a phone it sits in More */
  readonly deskOnly?: boolean;
  readonly onClick?: () => void;
}

export interface TaskDetailsProps {
  readonly harness: string;
  readonly logo?: string;
  readonly project: string;
  readonly color: string;
  /** the state, shown on a phone (the list says it beside the task on a desktop) */
  readonly status?: { readonly label: string; readonly tone: string };
  readonly branch?: { readonly head: string; readonly tail: string; readonly title: string };
  readonly actions: readonly TaskAction[];
}

/** v1 .it-bar: the harness and project, the branch, then the task's actions. */
export function TaskDetails(props: TaskDetailsProps): JSX.Element {
  return (
    <div data-kit="it-bar" data-part="split.details">
      <div data-kit="it-props">
        <Show when={props.status}>
          {(st) => (
            <span data-kit="it-state" data-tone={st().tone}>
              <i />
              {st().label}
            </span>
          )}
        </Show>
        <span data-kit="model-logo" role="img" aria-label={props.harness}>
          <Show when={props.logo}>{(src) => <img src={src()} alt="" />}</Show>
          <span data-kit="ml-name">{props.harness}</span>
        </span>
        <span data-kit="q-proj" data-color={props.color}>{props.project}</span>
      </div>
      <Show when={props.branch}>
        {(b) => (
          <div data-kit="it-meta" title={b().title}>
            <span data-kit="m-branch">
              <Icon name="branch" />
              <span data-kit="b-h">{b().head}</span>
              <span data-kit="b-t">{b().tail}</span>
            </span>
          </div>
        )}
      </Show>
      <div data-kit="it-actions" data-part="split.actions">
        <For each={props.actions}>
          {(a) => (
            <button type="button" data-kit="ghost-xs" data-a={a.id} data-part={a.part} data-tone={a.tone} data-key={a.key} data-desk={flag(a.deskOnly)} title={a.title} onClick={() => a.onClick?.()}>
              <Icon name={a.icon} />
              <span data-text="control">{a.label}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

export interface TrailItem {
  readonly icon?: IconName;
  readonly text: string;
  readonly title?: string;
}

export interface TurnViewProps {
  readonly prompt: string;
  readonly logo?: string;
  readonly harness: string;
  readonly time: string;
  readonly timeTitle: string;
  readonly sha?: { readonly short: string; readonly title: string };
  readonly hero?: { readonly title: string; readonly summary: string };
  readonly acts: readonly TrailItem[];
  readonly actsTitle: string;
  readonly stats: readonly TrailItem[];
  readonly receipt?: TrailItem;
  readonly files?: { readonly label: string; readonly plus: string; readonly minus: string };
  readonly tools: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly part?: string }[];
}

/** v1 .turn: the ask, the answer's brief, and the trail under it. */
export function TurnView(props: TurnViewProps): JSX.Element {
  return (
    <article data-kit="turn">
      <div data-kit="ask">
        <div data-kit="ask-text">{props.prompt}</div>
        <div data-kit="ask-foot">
          <span data-kit="model-logo" role="img" aria-label={props.harness}>
            <Show when={props.logo}>{(src) => <img src={src()} alt="" />}</Show>
          </span>
          <time title={props.timeTitle}>{props.time}</time>
          <Show when={props.sha}>
            {(s) => (
              <span data-kit="cp-sha" title={s().title}>
                <Icon name="branch" />
                {s().short}
              </span>
            )}
          </Show>
        </div>
      </div>
      <Show when={props.hero}>
        {(h) => (
          <div data-kit="presentation">
            <div data-kit="b-hero">
              <h2>{h().title}</h2>
              <p>{h().summary}</p>
            </div>
          </div>
        )}
      </Show>
      <div data-kit="trail">
        <div data-kit="trail-bar">
          <button type="button" data-kit="tb-acts" title={props.actsTitle}>
            <For each={props.acts}>
              {(a) => (
                <span data-kit="tb" title={a.title}>
                  <Show when={a.icon}>{(i) => <Icon name={i()} />}</Show>
                  {a.text}
                </span>
              )}
            </For>
          </button>
          <For each={props.stats}>{(s) => <span data-kit="tb">{s.text}</span>}</For>
          <Show when={props.receipt}>
            {(r) => (
              <span data-kit="tb" data-part="turn.receipt" title={r().title}>
                <span>{r().text}</span>
              </span>
            )}
          </Show>
          <span data-kit="grow" />
          <Show when={props.files}>
            {(f) => (
              <button type="button" data-kit="link-xs">
                {f().label} <span data-kit="plus">{f().plus}</span> <span data-kit="minus">{f().minus}</span>
              </button>
            )}
          </Show>
          <span data-kit="tb-tools">
            <For each={props.tools}>
              {(t) => (
                <button type="button" data-kit="tb-btn" data-a={t.id} data-part={t.part} aria-label={t.label} title={t.label}>
                  <Icon name={t.icon} />
                </button>
              )}
            </For>
          </span>
        </div>
      </div>
    </article>
  );
}

export interface OverlapNoteProps {
  readonly head: string;
  readonly files: string;
  readonly more?: string;
  readonly moreTitle: string;
  readonly open: string;
  readonly openTitle: string;
  readonly onOpen?: () => void;
}

/** v1 .overlap-strip: the first task changing the same files, above the reply box. */
export function OverlapNote(props: OverlapNoteProps): JSX.Element {
  return (
    <div data-kit="overlap-strip" data-part="card.overlapNote">
      <div data-kit="ov-row">
        <Icon name="merge" />
        <span data-kit="ov-text">
          <b>{props.head}</b> <span>{props.files}</span>
        </span>
        <Show when={props.more}>
          <button type="button" data-kit="ov-more" title={props.moreTitle}>{props.more}</button>
        </Show>
        <button type="button" data-kit="ghost-xs" data-compact="" title={props.openTitle} onClick={() => props.onOpen?.()}>{props.open}</button>
      </div>
    </div>
  );
}

export interface ReplyBoxProps {
  readonly placeholder: string;
  readonly value: string;
  readonly onInput: (v: string) => void;
  readonly onSend: () => void;
  readonly inputRef?: (el: HTMLTextAreaElement) => void;
  readonly attach: string;
  readonly mode: { readonly label: string; readonly title: string };
  readonly runner: { readonly title: string; readonly logo?: string };
  readonly team: string;
  readonly goal: string;
  readonly later: string;
  readonly send: string;
}

/** v1 .composer: the reply box under a task. It wakes (its toolbar shows) when the caret goes in, and
 * folds back to one line on a press outside it (composer.js), not when the keyboard moves on. */
export function ReplyBox(props: ReplyBoxProps): JSX.Element {
  const [awake, setAwake] = createSignal(false);
  let box: HTMLDivElement | undefined;
  const outside = (e: PointerEvent): void => {
    if (box && !box.contains(e.target as Node)) setAwake(false);
  };
  onMount(() => document.addEventListener('pointerdown', outside, true));
  onCleanup(() => document.removeEventListener('pointerdown', outside, true));
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.onSend();
    }
  };
  return (
    <div data-kit="reply-box" data-part="composer" data-awake={flag(awake())} ref={(el) => (box = el)} onFocusIn={(e) => (e.target as HTMLElement).dataset['kit'] === 'reply' && setAwake(true)}>
      <div data-kit="mn-wrap">
        <textarea data-kit="reply" data-part="composer.input" rows="1" placeholder={props.placeholder} value={props.value} ref={(el) => props.inputRef?.(el)} onInput={(e) => props.onInput(e.currentTarget.value)} onKeyDown={key} />
      </div>
      <div data-kit="c-bar">
        <button type="button" data-kit="icon-btn" data-part="composer.attach" title={props.attach} aria-label={props.attach}>
          <Icon name="clip" />
        </button>
        <button type="button" data-kit="mode-btn" data-part="composer.mode" data-reply="" title={props.mode.title} aria-label={props.mode.label}>
          <Icon name="spark" />
          <span data-text="control">{props.mode.label}</span>
        </button>
        <button type="button" data-kit="c-runner" data-part="composer.harness" title={props.runner.title} aria-label={props.runner.title}>
          <span data-kit="rb-logo" data-bare="">
            <Show when={props.runner.logo}>{(src) => <img src={src()} alt="" />}</Show>
          </span>
        </button>
        <button type="button" data-kit="c-team" data-part="composer.team" title={props.team} aria-label={props.team}>
          <Icon name="agent" />
        </button>
        <button type="button" data-kit="icon-btn" data-part="composer.goal" title={props.goal} aria-label={props.goal}>
          <Icon name="target" />
        </button>
        <span data-kit="grow" />
        <button type="button" data-kit="icon-btn" data-part="composer.sendLater" title={props.later} aria-label={props.later}>
          <Icon name="clock" />
        </button>
        <button type="button" data-kit="send" data-part="composer.send" title={props.send} aria-label={props.send} onClick={() => props.onSend()}>
          <Icon name="enter" />
        </button>
      </div>
    </div>
  );
}

/** v1 .it-body: the task's page under its head: the details column, the turns, the dock. */
export function TaskBody(props: { readonly details?: JSX.Element; readonly turns: JSX.Element; readonly dock: JSX.Element; readonly wide?: boolean }): JSX.Element {
  return (
    <div data-kit="it-body" data-part="split.body card.body" data-details={flag(props.details !== undefined)}>
      {props.details}
      <div data-kit="turns">{props.turns}</div>
      <div data-kit="it-dock">{props.dock}</div>
    </div>
  );
}
