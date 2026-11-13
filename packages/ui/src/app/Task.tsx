// The open task as v1 draws it in the main pane (web/css/split.css .split-head, panel.css .it-body,
// .it-bar, .it-actions, transcript.css .turn/.ask/.trail, ship.css .overlap-strip, composer.css):
// its head, then its turns with the details column beside them, and the reply box docked at the foot.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { ActIcon, WithAct, type Act } from './act.tsx';
import { holdMedia } from './hold-view.ts';
import { Icon } from '../content/Icon.tsx';
import { PromptSuggestList, dropHandlers } from '../composer/PromptSuggest.tsx';
import { suggestKeyDown, type PromptSuggest } from '../composer/suggest-keys.ts';
import type { IconName } from '../content/icons.ts';
import { TaskUsage, type TaskUsageProps } from './TaskUsage.tsx';

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
  /** the side panel is open */
  readonly panelOn?: boolean;
  /** what plugins put in the head (v1 SLOTS split.head), before its own buttons */
  readonly actions?: JSX.Element;
  /** rename in place (v1 split.js): a click on the title edits it; Enter keeps, Escape or an empty title cancels */
  readonly onRename?: (title: string) => void;
}

/** v1 #splitHead: the dot, the title, the side panel and close buttons (back on a phone). */
export function TaskHead(props: TaskHeadProps): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  return (
    <header data-kit="split-head" data-part="split.head" data-color={props.color} data-drag="">
      <div data-kit="sh-row">
        <Show when={props.onBack} fallback={<span data-kit="q-dot" />}>
          <button type="button" data-kit="sh-back" data-part="split.back" aria-label={props.backLabel} title={props.backLabel} onClick={() => props.onBack?.()}>
            <Icon name="back" />
          </button>
        </Show>
        <h2
          data-kit="sh-title"
          data-part="split.title"
          title={props.renameLabel}
          data-no-drag=""
          contentEditable={editing() ? 'plaintext-only' : undefined}
          aria-label={editing() ? props.renameLabel : undefined}
          onClick={(e) => {
            if (!props.onRename || editing()) return;
            setEditing(true);
            const el = e.currentTarget;
            queueMicrotask(() => {
              el.focus();
              const r = document.createRange();
              r.selectNodeContents(el);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(r);
            });
          }}
          onKeyDown={(e) => {
            if (!editing()) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.currentTarget.textContent = props.title;
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            if (!editing()) return;
            setEditing(false);
            const next = (e.currentTarget.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (next && next !== props.title) props.onRename?.(next);
            else e.currentTarget.textContent = props.title;
          }}
        >
          {props.title}
        </h2>
        <span data-kit="sh-acts">
          {props.actions}
          <Show when={!props.onBack}>
            <button type="button" data-kit="head-btn" aria-label={props.panelLabel} title={props.panelLabel} aria-pressed={props.panelOn === true} onClick={() => props.onPanel?.()}>
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
  readonly act?: Act;
  /** what it shows is open (v1 .ghost.tx-toggle.on: the Transcript action while the transcript shows). Additive. */
  readonly on?: boolean;
}

export interface TaskDetailsProps {
  readonly harness: string;
  readonly logo?: string;
  readonly project: string;
  readonly color: string;
  /** the state, shown on a phone (the list says it beside the task on a desktop) */
  readonly status?: { readonly label: string; readonly tone: string };
  /** a plan's when (v1 plan-view .pv-when): Starts in 2h, At 3pm, Draft, After “x”; first in the column */
  readonly when?: { readonly icon: IconName; readonly label: string; readonly title?: string };
  readonly branch?: { readonly head: string; readonly tail: string; readonly title: string };
  /** its usage, its subagents' in, and how full its context is (v1 #785): the wide pane's lines. Additive. */
  readonly usage?: TaskUsageProps;
  readonly actions: readonly TaskAction[];
}

/** v1 .it-bar: the harness and project, the branch, then the task's actions. */
export function TaskDetails(props: TaskDetailsProps): JSX.Element {
  return (
    <div data-kit="it-bar" data-part="split.details">
      <div data-kit="it-props">
        <Show when={props.when}>
          {(w) => (
            <span data-kit="it-when" data-part="split.when" title={w().title}>
              <Icon name={w().icon} />
              <span>{w().label}</span>
            </span>
          )}
        </Show>
        <Show when={props.status}>
          {(st) => (
            <span data-kit="it-state" data-tone={st().tone}>
              <i />
              {st().label}
            </span>
          )}
        </Show>
        <Show when={props.usage}>{(u) => <TaskUsage {...u()} />}</Show>
        <span data-kit="model-logo" role="img" aria-label={props.harness}>
          <Show when={props.logo}>{(src) => <img src={src()} alt="" />}</Show>
          <span data-kit="ml-name">{props.harness}</span>
        </span>
        <span data-kit="q-proj" data-color={props.color}>
          {props.project}
        </span>
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
            <WithAct
              act={a.act}
              render={(trigger) => (
                <button
                  type="button"
                  {...trigger()}
                  data-kit="ghost-xs"
                  data-a={a.id}
                  data-part={a.part}
                  data-tone={a.tone}
                  data-key={a.key}
                  data-desk={flag(a.deskOnly)}
                  data-on={flag(a.on)}
                  aria-pressed={a.on === undefined ? undefined : a.on}
                  title={a.title}
                >
                  <ActIcon act={a.act}>
                    <Icon name={a.icon} />
                  </ActIcon>
                  <span data-text="control">{a.label}</span>
                </button>
              )}
            />
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
  /** the turn's id (`data-turn`): a task's kept place is held by the turn at the top (v1 split.js). Additive (2026-11-12). */
  readonly id?: string;
  readonly prompt: string;
  /** the comments the prompt went out with, as cards over its words (v1 comments.js sentComments). Additive (2026-11-12). */
  readonly askNotes?: readonly { readonly n: number; readonly on: string; readonly removed?: boolean; readonly removedLabel?: string; readonly say: string }[];
  readonly logo?: string;
  readonly harness: string;
  readonly time: string;
  readonly timeTitle: string;
  readonly sha?: { readonly short: string; readonly title: string };
  readonly hero?: { readonly title: string; readonly summary: string };
  /** the answer's blocks as a whole (an <Answer>): shown in the hero's place, the hero among them */
  readonly answer?: JSX.Element;
  readonly acts: readonly TrailItem[];
  readonly actsTitle: string;
  readonly stats: readonly TrailItem[];
  readonly receipt?: TrailItem;
  readonly files?: { readonly label: string; readonly plus: string; readonly minus: string; readonly act?: Act };
  readonly tools: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly part?: string; readonly act?: Act; readonly on?: boolean }[];
  /** the steps it took, shown under the brief (the trail's counts open them) */
  /** the turn's steps; a step with `out` (its output, an error's text) folds open to it (v1 transcript.js) */
  readonly activity?: {
    readonly items: readonly { readonly icon: IconName; readonly text: string; readonly detail?: string; readonly out?: string; readonly bad?: boolean }[];
    readonly open: boolean;
    readonly onToggle: () => void;
  };
  /** the agent's notes, shown under the brief */
  readonly notes?: string;
  /** still running: what it's doing, in place of the trail */
  readonly live?: string;
  /** still running: v1's working panel (status, last steps, Stop), in place of the live line. Additive (2026-11-12). */
  readonly working?: JSX.Element;
  /** 👍 / 👎 at the trail's end (a RateButtons). Additive (2026-11-12). */
  readonly rate?: JSX.Element;
  /** under the trail bar: what a trail button opened (after 👎, the WhyForm). Additive (2026-11-12). */
  readonly trailBody?: JSX.Element;
}

/** v1 .turn: the ask, the answer's brief, and the trail under it. */
export function TurnView(props: TurnViewProps): JSX.Element {
  return (
    <article data-kit="turn" data-turn={props.id} data-live={flag(props.live !== undefined || props.working !== undefined)}>
      <div data-kit="ask">
        <Show when={(props.askNotes ?? []).length > 0}>
          <ol data-kit="ask-notes" data-part="turn.notes">
            <For each={props.askNotes}>
              {(c) => (
                <li data-kit="ask-note">
                  <span data-kit="cmt-n">{c.n}</span>
                  <div data-kit="an-body">
                    <span data-kit="an-on">
                      <span data-kit="cmt-file">{c.on}</span>
                      <Show when={c.removed}>
                        {' '}
                        <i>{c.removedLabel}</i>
                      </Show>
                    </span>
                    <Show when={c.say}>
                      <span data-kit="an-say">{c.say}</span>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ol>
        </Show>
        <Show when={props.prompt}>
          <div data-kit="ask-text">{props.prompt}</div>
        </Show>
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
      <Show when={props.answer}>
        <div data-kit="presentation">{props.answer}</div>
      </Show>
      <Show when={!props.answer && props.hero}>
        {(h) => (
          <div data-kit="presentation">
            <div data-kit="b-hero">
              <h2>{h().title}</h2>
              <p>{h().summary}</p>
            </div>
          </div>
        )}
      </Show>
      <Show when={props.notes}>{(n) => <p data-kit="turn-notes">{n()}</p>}</Show>
      <Show when={props.activity?.open && props.activity}>
        {(a) => (
          <ul data-kit="turn-acts">
            <For each={a().items}>
              {(it) => {
                const [open, setOpen] = createSignal(false);
                return (
                  <li data-bad={flag(it.bad)} data-fold={flag(!!it.out)}>
                    <Show
                      when={it.out}
                      fallback={
                        <>
                          <Icon name={it.icon} />
                          <span>{it.text}</span>
                          <Show when={it.detail}>{(d) => <code data-kit="turn-act-detail">{d()}</code>}</Show>
                        </>
                      }
                    >
                      <button type="button" data-kit="turn-act-fold" aria-expanded={open()} onClick={() => setOpen(!open())}>
                        <Icon name={it.icon} />
                        <span>{it.text}</span>
                        <Show when={it.detail}>{(d) => <code data-kit="turn-act-detail">{d()}</code>}</Show>
                        <Icon name="chevron" />
                      </button>
                      <Show when={open()}>
                        <pre data-kit="turn-act-out">{it.out}</pre>
                      </Show>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        )}
      </Show>
      <Show when={props.working} fallback={<Show when={props.live}>{(l) => <p data-kit="turn-live">{l()}</p>}</Show>}>
        <div data-kit="turn-working">{props.working}</div>
      </Show>
      <div data-kit="trail" hidden={props.live !== undefined || props.working !== undefined}>
        <div data-kit="trail-bar">
          <button type="button" data-kit="tb-acts" title={props.actsTitle} aria-expanded={props.activity?.open ?? false} onClick={() => props.activity?.onToggle()}>
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
              <WithAct
                act={f().act}
                render={(trigger) => (
                  <button type="button" {...trigger()} data-kit="link-xs">
                    {f().label} <span data-kit="plus">{f().plus}</span> <span data-kit="minus">{f().minus}</span>
                  </button>
                )}
              />
            )}
          </Show>
          <span data-kit="tb-tools">
            <For each={props.tools}>
              {(t) => (
                <WithAct
                  act={t.act}
                  render={(trigger) => (
                    <button type="button" {...trigger()} data-kit="tb-btn" data-a={t.id} data-part={t.part} data-on={flag(t.on)} aria-label={t.label} title={t.label}>
                      <ActIcon act={t.act}>
                        <Icon name={t.icon} />
                      </ActIcon>
                    </button>
                  )}
                />
              )}
            </For>
            {props.rate}
          </span>
        </div>
        <Show when={props.trailBody}>
          <div data-kit="trail-body">{props.trailBody}</div>
        </Show>
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
  readonly moreAct?: Act;
  /** v1 #787 .ov-x: the note's ×, last on the row (the host keeps it closed until something changes) */
  readonly dismiss?: { readonly label: string; readonly title: string; readonly onDismiss: () => void };
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
          <WithAct
            act={props.moreAct}
            render={(trigger) => (
              <button type="button" {...trigger()} data-kit="ov-more" title={props.moreTitle}>
                {props.more}
              </button>
            )}
          />
        </Show>
        <button type="button" data-kit="ghost-xs" data-compact="" title={props.openTitle} onClick={() => props.onOpen?.()}>
          {props.open}
        </button>
        <Show when={props.dismiss}>
          {(d) => (
            <button type="button" data-kit="ov-x" data-part="card.overlapClose" aria-label={d().label} title={d().title} onClick={() => d().onDismiss()}>
              <Icon name="x" />
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}

export interface ReplyBoxProps {
  readonly placeholder: string;
  readonly value: string;
  readonly onInput: (v: string) => void;
  readonly onSend: () => void;
  /** the box's own keys after its menus (↑ history, Shift+Tab mode): true when taken */
  readonly onKey?: (e: KeyboardEvent) => boolean;
  /** the @ and / menus: what the host offers for what's typed (over the box) */
  readonly suggest?: PromptSuggest | undefined;
  /** a paste into the box (files, a pasted task link): the host may take it */
  readonly onPaste?: (e: ClipboardEvent) => void;
  /** files dropped on the box (v1: anywhere on it); it lights up while they're over it */
  readonly onFiles?: (files: File[]) => void;
  readonly inputRef?: (el: HTMLTextAreaElement) => void;
  readonly attach: string;
  readonly attachAct?: Act;
  /** the phone app's mic (v1 .c-mic): listening shows it on, in the accent. Absent: no mic. Additive (2026-11-13). */
  readonly mic?: { readonly label: string; readonly on: boolean; readonly act: Act } | undefined;
  readonly mode: { readonly label: string; readonly title: string; readonly icon?: IconName; readonly act?: Act };
  readonly runner: { readonly title: string; readonly logo?: string; readonly act?: Act };
  readonly team: string;
  readonly teamAct?: Act;
  readonly goal: string;
  readonly goalOn?: boolean;
  readonly goalAct?: Act;
  /** Goal on: its condition, over the box */
  readonly goalLine?: { readonly label: string; readonly placeholder: string; readonly value: string; readonly onInput: (v: string) => void; readonly ref?: (el: HTMLInputElement) => void };
  readonly later: string;
  readonly laterAct?: Act;
  /** v1 .c-queue: while the task works, follow-ups queue (on) or interrupt it (off); its own switch look */
  readonly queue?: { readonly label: string; readonly title: string; readonly on: boolean; readonly act: Act } | undefined;
  readonly send: string;
  readonly sendAct?: Act;
  /** what's attached and when it goes: chips over the bar */
  readonly extras?: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly removeLabel: string; readonly onRemove: () => void }[];
  /** the bar's quiet line (v1 .c-hint): the cold cache's words, with a short form for a narrow bar, and an optional link (Compact now) */
  readonly hint?: { readonly long: string; readonly short: string; readonly title?: string; readonly link?: { readonly label: string; readonly title?: string; readonly act: Act } } | undefined;
}

/** v1 .composer: the reply box under a task. It wakes (its toolbar shows) when the caret goes in, and
 * folds back to one line on a press outside it (composer.js), not when the keyboard moves on. It folds once the
 * press is let go: folding on the press itself moved what's over the box (a follow-up's ×, Send now) out from under
 * the finger before its click, so on a phone the first tap after sending did nothing. */
export function ReplyBox(props: ReplyBoxProps): JSX.Element {
  const [awake, setAwake] = createSignal(false);
  let box: HTMLDivElement | undefined;
  // on the click the release makes (after the pressed control's own handler: Solid's sit on document first), or
  // when the press turns into a scroll
  const fold = (): void => {
    disarm();
    setAwake(false);
  };
  const disarm = (): void => {
    document.removeEventListener('click', fold);
    document.removeEventListener('pointercancel', fold);
  };
  // a primary press only (a right-click or a scrollbar makes no click, and the next click inside would fold it)
  const outside = (e: PointerEvent): void => {
    disarm();
    if (!box || box.contains(e.target as Node) || !awake() || e.button !== 0) return;
    document.addEventListener('click', fold);
    document.addEventListener('pointercancel', fold);
  };
  onMount(() => document.addEventListener('pointerdown', outside, true));
  onCleanup(() => {
    document.removeEventListener('pointerdown', outside, true);
    disarm();
  });
  const key = (e: KeyboardEvent): void => {
    if (suggestKeyDown(props.suggest, e)) return;
    if (props.onKey?.(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.onSend();
    }
  };
  // Send with nothing written: the box takes the caret and its placeholder lights up until you type
  const [nudge, setNudge] = createSignal(false);
  const [over, setOver] = createSignal(false);
  let input: HTMLTextAreaElement | undefined;
  const send = (): void => {
    if (props.sendAct?.pending) return;
    if (props.value.trim()) return props.onSend();
    input?.focus();
    setNudge(true); // until the next key or the caret leaves
  };
  return (
    <div
      data-nudge={flag(nudge())}
      data-kit="reply-box"
      data-part="composer"
      data-awake={flag(awake())}
      data-drop={flag(over())}
      ref={(el) => (box = el)}
      onFocusIn={(e) => (e.target as HTMLElement).dataset['kit'] === 'reply' && setAwake(true)}
      {...dropHandlers(() => props.onFiles, setOver)}
    >
      <div data-kit="mn-wrap">
        <PromptSuggestList suggest={props.suggest} place="above" />
        <textarea
          data-kit="reply"
          data-part="composer.input"
          rows="1"
          placeholder={props.placeholder}
          value={props.value}
          ref={(el) => ((input = el), props.inputRef?.(el))}
          onBlur={() => setNudge(false)}
          onInput={(e) => (setNudge(false), props.onInput(e.currentTarget.value))}
          onKeyDown={key}
          onPaste={(e) => props.onPaste?.(e)}
          aria-activedescendant={props.suggest && props.suggest.items.length > 0 ? `${props.suggest.id}-o${props.suggest.active}` : undefined}
        />
      </div>
      <Show when={props.goalLine}>
        {(g) => (
          <div data-kit="l-goal" data-in="reply">
            <Icon name="target" />
            <input data-kit="l-goal-input" ref={(el) => g().ref?.(el)} aria-label={g().label} placeholder={g().placeholder} value={g().value} onInput={(e) => g().onInput(e.currentTarget.value)} />
          </div>
        )}
      </Show>
      <Show when={(props.extras?.length ?? 0) > 0}>
        <div data-kit="l-extras">
          <For each={props.extras}>
            {(x) => (
              <span data-kit="lp-chip" data-extra="">
                <Icon name={x.icon} />
                <span data-text="control">{x.label}</span>
                <button type="button" data-kit="chip-x" aria-label={x.removeLabel} title={x.removeLabel} onClick={() => x.onRemove()}>
                  <Icon name="x" />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div data-kit="c-bar">
        <WithAct
          act={props.attachAct}
          render={(trigger) => (
            <button type="button" {...trigger()} data-kit="icon-btn" data-part="composer.attach" title={props.attach} aria-label={props.attach}>
              <ActIcon act={props.attachAct}>
                <Icon name="clip" />
              </ActIcon>
            </button>
          )}
        />
        <Show when={props.mic}>
          {(m) => (
            <WithAct
              act={m().act}
              render={(trigger) => (
                <button type="button" {...trigger()} data-kit="icon-btn" data-part="composer.mic" data-on={flag(m().on)} aria-pressed={m().on} title={m().label} aria-label={m().label}>
                  <Icon name="mic" />
                </button>
              )}
            />
          )}
        </Show>
        <WithAct
          act={props.mode.act}
          render={(trigger) => (
            <button type="button" {...trigger()} data-kit="mode-btn" data-part="composer.mode" data-reply="" title={props.mode.title} aria-label={props.mode.label}>
              <Icon name={props.mode.icon ?? 'spark'} />
              <span data-text="control">{props.mode.label}</span>
            </button>
          )}
        />
        <WithAct
          act={props.runner.act}
          render={(trigger) => (
            <button type="button" {...trigger()} data-kit="c-runner" data-part="composer.harness" title={props.runner.title} aria-label={props.runner.title}>
              <span data-kit="rb-logo" data-bare="">
                <Show when={props.runner.logo}>{(src) => <img src={src()} alt="" />}</Show>
              </span>
            </button>
          )}
        />
        <WithAct
          act={props.teamAct}
          render={(trigger) => (
            <button type="button" {...trigger()} data-kit="c-team" data-part="composer.team" title={props.team} aria-label={props.team}>
              <Icon name="agent" />
            </button>
          )}
        />
        <WithAct
          act={props.goalAct}
          render={(trigger) => (
            <button
              type="button"
              {...trigger()}
              data-kit="icon-btn"
              data-part="composer.goal"
              data-on={flag(props.goalOn)}
              aria-pressed={props.goalOn === true}
              title={props.goal}
              aria-label={props.goal}
            >
              <Icon name="target" />
            </button>
          )}
        />
        <Show when={props.hint} fallback={<span data-kit="grow" />}>
          {(h) => (
            <span data-kit="c-hint" data-part="composer.hint">
              <span data-kit="c-cold-row">
                <span data-kit="c-cold" title={h().title ?? h().long}>
                  <span data-kit="cc-long">{h().long}</span>
                  <span data-kit="cc-short">{h().short}</span>
                </span>
                <Show when={h().link}>
                  {(l) => (
                    <WithAct
                      act={l().act}
                      render={(trigger) => (
                        <button type="button" {...trigger()} data-kit="link" data-part="composer.hint.link" title={l().title ?? l().label}>
                          {l().label}
                        </button>
                      )}
                    />
                  )}
                </Show>
              </span>
            </span>
          )}
        </Show>
        <Show when={props.queue}>
          {(q) => (
            <WithAct
              act={q().act}
              render={(trigger) => (
                <button type="button" {...trigger()} data-kit="c-queue" data-part="composer.queueSwitch" data-on={flag(q().on)} aria-pressed={q().on} title={q().title}>
                  <Icon name="queue" />
                  <span data-text="control">{q().label}</span>
                  <i data-kit="c-switch" />
                </button>
              )}
            />
          )}
        </Show>
        <WithAct
          act={props.laterAct}
          render={(trigger) => (
            <button type="button" {...trigger()} data-kit="icon-btn" data-part="composer.sendLater" title={props.later} aria-label={props.later}>
              <Icon name="clock" />
            </button>
          )}
        />
        <button type="button" data-kit="send" data-part="composer.send" title={props.send} aria-label={props.send} onClick={send} aria-busy={props.sendAct?.pending ? 'true' : undefined}>
          <ActIcon act={props.sendAct}>
            <Icon name="enter" />
          </ActIcon>
        </button>
      </div>
    </div>
  );
}

/** v1 .it-body: the task's page under its head: the details column, the turns, the dock. */
export function TaskBody(props: {
  readonly details?: JSX.Element;
  readonly turns: JSX.Element;
  readonly dock: JSX.Element;
  readonly wide?: boolean;
  /** the scroller (a task's kept place) */ readonly bodyRef?: (el: HTMLElement) => void;
}): JSX.Element {
  let stop: (() => void) | undefined;
  let body!: HTMLDivElement;
  onCleanup(() => stop?.());
  return (
    <div
      ref={(el) => {
        body = el;
        props.bodyRef?.(el);
      }}
      data-kit="it-body"
      data-part="split.body card.body"
      data-details={flag(props.details !== undefined)}
    >
      {props.details}
      <div data-kit="turns">{props.turns}</div>
      <div
        ref={(dock) => {
          // a child's ref runs after its parent's: the body is known here
          stop?.();
          stop = typeof ResizeObserver === 'undefined' ? undefined : holdMedia(body, dock);
        }}
        data-kit="it-dock"
      >
        {props.dock}
      </div>
    </div>
  );
}
