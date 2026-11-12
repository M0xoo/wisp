// Home as v1 draws it (web/css/split.css .split-home, launcher.css, composer.css, auto.css, tips):
// the greeting, the prompt box (where it runs, the prompt, its toolbar, Recipes), what needs you,
// then the tips. On a phone it's its own page with a back button in its head.
import { For, Index, Match, Show, Switch, createSignal, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { useOpenWithin } from '../core/open-within.ts';
import { reorderable, type OnReorder } from '../core/reorder.ts';
import { Icon } from '../content/Icon.tsx';
import { PromptSuggestList, dropHandlers, suggestKeyDown, type PromptSuggest } from '../composer/PromptSuggest.tsx';
import type { IconName } from '../content/icons.ts';
import { ActIcon, WithAct, actAttrs, type Act } from './act.tsx';

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
          <h2 data-kit="sh-hello" data-part="split.greeting">
            {props.greeting}
          </h2>
        </div>
      </Show>
      <Show when={!props.onBack}>
        <h2 data-kit="sh-hello" data-part="split.greeting">
          {props.greeting}
        </h2>
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
  readonly act?: Act;
}

export interface LauncherChip {
  readonly id: string;
  /** a project (its colour's dot and name), No folder (its icon), or Other folder… (a dashed chip) */
  readonly kind: 'project' | 'none' | 'pick';
  readonly name: string;
  readonly title: string;
  readonly color?: string;
  readonly on?: boolean;
  readonly act?: Act;
}

export interface LauncherProps {
  readonly inLabel: string;
  readonly chips: readonly LauncherChip[];
  /** drag a project chip (or Alt+←/→) into your own order (v1 #772) */
  readonly onReorder?: OnReorder;
  readonly placeholder: string;
  readonly value: string;
  readonly onInput: (v: string) => void;
  readonly onSend: () => void;
  /** the @ and / menus (under the box) */
  readonly suggest?: PromptSuggest | undefined;
  /** a paste into the box (files): the host may take it */
  readonly onPaste?: (e: ClipboardEvent) => void;
  /** files dropped on the box; it lights up while they're over it */
  readonly onFiles?: (files: File[]) => void;
  readonly inputRef?: (el: HTMLTextAreaElement) => void;
  readonly mode: { readonly label: string; readonly title: string; readonly icon?: IconName; readonly act?: Act };
  readonly runner: {
    readonly label: string;
    readonly title: string;
    readonly pick: string;
    readonly pickTitle: string;
    readonly logo?: string;
    readonly compare: string;
    readonly act?: Act;
    readonly pickAct?: Act;
    /** what the pick opens is open (the Auto popover): the launcher stays lit while it is */
    readonly pickOpen?: boolean;
    readonly compareAct?: Act;
  };
  /** before the runner: attach, where */
  readonly lead: readonly LauncherTool[];
  /** after the runner: try two ways, delegate */
  readonly mid: readonly LauncherTool[];
  /** after the gap: goal, worktree, later */
  readonly tail: readonly LauncherTool[];
  readonly sendLabel: string;
  readonly sendAct?: Act;
  /** Goal on: its condition, under the prompt (v1 .l-goal) */
  readonly goal?: { readonly label: string; readonly placeholder: string; readonly value: string; readonly onInput: (v: string) => void; readonly ref?: (el: HTMLInputElement) => void };
  /** files attached, and when it starts if not now: chips under the prompt */
  readonly extras?: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly removeLabel: string; readonly onRemove: () => void }[];
  readonly recipes: { readonly label: string; readonly empty: string; readonly add: string; readonly issue: string; readonly issueTitle: string; readonly addAct?: Act; readonly issueAct?: Act };
}

function Tool(props: { readonly t: LauncherTool }): JSX.Element {
  return (
    <WithAct
      act={props.t.disabled ? undefined : props.t.act}
      render={(trigger) => (
        <button
          type="button"
          {...trigger()}
          data-kit={props.t.text === undefined ? 'icon-btn' : 'tog-btn'}
          data-a={props.t.id}
          data-part={props.t.part}
          data-on={flag(props.t.on)}
          title={props.t.title}
          aria-label={props.t.label}
          aria-pressed={props.t.on === undefined ? undefined : props.t.on}
          aria-disabled={props.t.disabled ? 'true' : undefined}
        >
          <ActIcon act={props.t.act}>
            <Icon name={props.t.icon} />
          </ActIcon>
          <Show when={props.t.text}>
            <span data-text="control">{props.t.label}</span>
          </Show>
        </button>
      )}
    />
  );
}

function Chip(props: { readonly c: LauncherChip; readonly ids: () => readonly string[]; readonly onReorder?: OnReorder | undefined }): JSX.Element {
  return (
    <WithAct
      act={props.c.act}
      render={(trigger) => (
        <button
          type="button"
          {...reorderable('launcher.projects', props.c.id, props.ids, props.c.kind === 'project' ? props.onReorder : undefined)}
          {...trigger()}
          data-kit="lp-chip"
          data-on={flag(props.c.on)}
          data-none={flag(props.c.kind === 'none')}
          data-add={flag(props.c.kind === 'pick')}
          data-color={props.c.color}
          aria-current={props.c.on ? 'true' : undefined}
          title={props.c.title}
        >
          <Switch>
            <Match when={props.c.kind === 'project'}>
              <i data-kit="p-dot" />
              {props.c.name}
            </Match>
            <Match when={props.c.kind === 'none'}>
              <Icon name="text" />
              <span data-text="control">{props.c.name}</span>
            </Match>
            <Match when={props.c.kind === 'pick'}>
              <Icon name="folder" />
              <span data-text="control">{props.c.name}</span>
            </Match>
          </Switch>
        </button>
      )}
    />
  );
}

/** v1 #launcher: the prompt box on Home. */
export function Launcher(props: LauncherProps): JSX.Element {
  const projectIds = (): string[] => props.chips.filter((c) => c.kind === 'project').map((c) => c.id);
  const key = (e: KeyboardEvent): void => {
    if (suggestKeyDown(props.suggest, e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.onSend();
    }
  };
  const empty = (): boolean => props.value.trim() === '';
  // Send with nothing written: the prompt takes the caret and its placeholder lights up until you type
  const [nudge, setNudge] = createSignal(false);
  const [over, setOver] = createSignal(false);
  let input: HTMLTextAreaElement | undefined;
  const send = (): void => {
    if (props.sendAct?.pending) return;
    if (!empty()) return props.onSend();
    input?.focus();
    setNudge(true); // until the next key or the caret leaves
  };
  // a menu of its bar open (they live in a portal): it looks as it does with the caret in it (v1 :has(.open))
  const within = useOpenWithin();
  return (
    <div data-kit="sh-launch">
      <section
        data-kit="launcher"
        data-part="launcher"
        ref={within.ref}
        data-open={flag(within.open())}
        data-nudge={flag(nudge())}
        data-drop={flag(over())}
        {...dropHandlers(() => props.onFiles, setOver)}
      >
        <div data-kit="l-projects" data-part="launcher.projects">
          <span data-kit="l-in">{props.inLabel}</span>
          <span data-kit="lp-group">
            <For each={props.chips}>{(c) => <Chip c={c} ids={projectIds} onReorder={props.onReorder} />}</For>
          </span>
        </div>
        <div data-kit="mn-wrap">
          <textarea
            data-kit="prompt"
            data-part="launcher.input"
            rows="2"
            placeholder={props.placeholder}
            value={props.value}
            ref={(el) => ((input = el), props.inputRef?.(el))}
            onBlur={() => setNudge(false)}
            onInput={(e) => (setNudge(false), props.onInput(e.currentTarget.value))}
            onKeyDown={key}
            onPaste={(e) => props.onPaste?.(e)}
          />
          <PromptSuggestList suggest={props.suggest} place="below" />
        </div>
        <Show when={props.goal}>
          {(g) => (
            <div data-kit="l-goal" data-part="launcher.goalLine">
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
        <div data-kit="l-bar">
          <Index each={props.lead}>{(t) => <Tool t={t()} />}</Index>
          <WithAct
            act={props.mode.act}
            render={(trigger) => (
              <button type="button" {...trigger()} data-kit="mode-btn" data-part="launcher.mode" title={props.mode.title}>
                <Icon name={props.mode.icon ?? 'spark'} />
                <span data-text="control">{props.mode.label}</span>
              </button>
            )}
          />
          <div data-kit="runners">
            <WithAct
              act={props.runner.act}
              render={(trigger) => (
                <button type="button" {...trigger()} data-kit="runner-btn" data-part="launcher.harness" title={props.runner.title}>
                  <span data-kit="rb-logo">
                    <i data-kit="auto-mark">
                      <Icon name="spark" />
                    </i>
                  </span>
                  <span data-kit="rb-h" data-text="control">
                    {props.runner.label}
                  </span>
                  <Icon name="chevron" />
                </button>
              )}
            />
            <WithAct
              act={props.runner.pickAct}
              render={(trigger) => (
                <button
                  type="button"
                  {...trigger()}
                  data-kit="auto-pv"
                  data-part="launcher.autoPreview"
                  aria-expanded={props.runner.pickOpen === undefined ? undefined : props.runner.pickOpen ? 'true' : 'false'}
                  title={props.runner.pickTitle}
                  aria-label={props.runner.pickTitle}
                >
                  <span data-kit="rb-logo" data-small="">
                    <Show when={props.runner.logo}>{(src) => <img src={src()} alt="" />}</Show>
                  </span>
                  <span data-kit="apv-l" data-text="control">
                    {props.runner.pick}
                  </span>
                </button>
              )}
            />
            <WithAct
              act={props.runner.compareAct}
              render={(trigger) => (
                <button type="button" {...trigger()} data-kit="vs-btn" data-part="launcher.compare" title={props.runner.compare} aria-label={props.runner.compare}>
                  <Icon name="plus" />
                </button>
              )}
            />
          </div>
          <Index each={props.mid}>{(t) => <Tool t={t()} />}</Index>
          <span data-kit="grow" />
          <Index each={props.tail}>{(t) => <Tool t={t()} />}</Index>
          <button type="button" {...actAttrs(props.sendAct)} data-kit="send" data-part="launcher.send" title={props.sendLabel} aria-label={props.sendLabel} onClick={send}>
            <ActIcon act={props.sendAct}>
              <Icon name="enter" />
            </ActIcon>
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
              <WithAct
                act={props.recipes.addAct}
                render={(trigger) => (
                  <button type="button" {...trigger()} data-kit="lp-chip" data-add="" data-small="">
                    <Icon name="plus" />
                    {props.recipes.add}
                  </button>
                )}
              />
            </div>
            <WithAct
              act={props.recipes.issueAct}
              render={(trigger) => (
                <button type="button" {...trigger()} data-kit="lp-chip" data-small="" data-part="launcher.issue" title={props.recipes.issueTitle} aria-label={props.recipes.issueTitle}>
                  <Icon name="issue" />
                  <span data-text="control">{props.recipes.issue}</span>
                </button>
              )}
            />
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
            <span data-kit="sh-t" data-text="control" title={r.title}>
              {r.title}
            </span>
            <Show when={r.state}>
              <span data-kit="sh-s">{r.state}</span>
            </Show>
            <span data-kit="sh-time" title={r.timeTitle}>
              {r.time}
            </span>
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
export function Tips(props: {
  readonly heading: string;
  readonly more: string;
  readonly moreTitle: string;
  readonly setup: readonly SetupTip[];
  readonly tips: readonly PlainTip[];
  readonly onMore?: () => void;
  readonly onOpen?: (href: string) => void;
}): JSX.Element {
  return (
    <div data-kit="sh-tips" data-part="tips">
      <h4>
        {props.heading}
        <button type="button" data-kit="tip-more" title={props.moreTitle} onClick={() => props.onMore?.()}>
          {props.more}
        </button>
      </h4>
      <For each={props.setup}>
        {(s) => (
          <button type="button" data-kit="sh-tip" data-setup="" data-part={s.kind === 'grid' ? 'tips.setup tips.grid' : 'tips.setup tips.tools'} onClick={() => s.onClick?.()}>
            <span data-kit="ts-badge">
              <Icon name={s.icon} />
            </span>
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
          <a
            data-kit="sh-tip"
            href={t.href}
            target="_blank"
            rel="noopener"
            onClick={(e) => {
              if (!props.onOpen || !t.href) return;
              e.preventDefault();
              props.onOpen(t.href);
            }}
          >
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
