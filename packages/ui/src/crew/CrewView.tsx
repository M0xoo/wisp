// A crew member's page, as v1 draws it (web/js/features/crew.js buildView, jobHtml, quietHtml; crew.css
// .crew-view): the head (face, name, role, state, its buttons), the thread of jobs in the reading column,
// what the member is and how it works beside it on a wide pane (folded above the thread otherwise, by the
// page's own width), and the box that gives it a job. Data and words come from the crew plugin.
import { createSignal, For, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { WithAct, type Act } from '../app/act.tsx';

export interface CrewViewProps {
  readonly face: JSX.Element;
  readonly name: string;
  readonly role?: string | undefined;
  readonly state: { readonly text: string; readonly tone: 'asks' | 'live' | 'report' | '' };
  /** the head's buttons (Pause, More, Close), the plugin's kit controls */
  readonly actions: JSX.Element;
  /** stack: back to the list, before the face */
  readonly back?: { readonly label: string; readonly onClick: () => void } | undefined;
  /** the jobs (CrewJob, CrewQuiet, CrewEmpty) */
  readonly thread: JSX.Element;
  readonly earlier?: { readonly label: string; readonly onClick: () => void } | undefined;
  /** what it is and how it works (CrewFacts, CrewSideActions, CrewSection) */
  readonly side: JSX.Element;
  /** the folded side's summary on a narrow page: "About Ada", and how it works */
  readonly about: { readonly label: string; readonly hint: string };
  readonly dock: {
    readonly placeholder: string;
    readonly value: string;
    readonly onInput: (v: string) => void;
    readonly onSend: () => void;
    readonly send: string;
    readonly checkIn: { readonly label: string; readonly title: string; readonly act: Act };
    readonly inputRef?: (el: HTMLTextAreaElement) => void;
  };
}

/** v1 .crew-view: head, scroll (columns, then the dock). */
export function CrewView(props: CrewViewProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.dock.onSend();
    }
  };
  return (
    <section data-kit="crew-view" data-part="crew.page">
      <header data-kit="cv-top" data-part="crew.page.head">
        <Show when={props.back}>
          {(b) => (
            <button type="button" data-kit="head-btn" data-part="crew.page.back" title={b().label} aria-label={b().label} onClick={() => b().onClick()}>
              <Icon name="back" />
            </button>
          )}
        </Show>
        {props.face}
        <div data-kit="cv-who">
          <h2 data-kit="sh-title" data-text="control">
            {props.name}
          </h2>
          <Show when={props.role}>
            <span data-kit="cv-role" data-text="control">
              {props.role}
            </span>
          </Show>
        </div>
        <span data-kit="cv-state" data-tone={props.state.tone || undefined} data-text="control" title={props.state.text}>
          {props.state.text}
        </span>
        <span data-kit="sh-acts">{props.actions}</span>
      </header>
      <div data-kit="cv-scroll">
        <div data-kit="cv-cols">
          <div data-kit="cv-main">
            <Show when={props.earlier}>
              {(e) => (
                <button type="button" data-kit="link" data-part="crew.page.earlier" data-cv="earlier" onClick={() => e().onClick()}>
                  {e().label}
                </button>
              )}
            </Show>
            <div data-kit="cv-thread" data-part="crew.thread">
              {props.thread}
            </div>
          </div>
          <div data-kit="cv-about" data-part="crew.details" data-open={flag(open())}>
            <button type="button" data-kit="cv-summary" aria-expanded={open()} onClick={() => setOpen(!open())}>
              <Icon name="info" />
              <b data-text="control">{props.about.label}</b>
              <span data-text="control">{props.about.hint}</span>
              <Icon name="chevron" />
            </button>
            <div data-kit="cv-side" data-part="crew.side">
              {props.side}
            </div>
          </div>
        </div>
        <div data-kit="cv-dock" data-part="crew.dock crew.compose">
          <div data-kit="cv-box">
            <textarea
              data-kit="cv-input"
              data-part="crew.dock.input"
              rows="1"
              spellcheck={false}
              placeholder={props.dock.placeholder}
              value={props.dock.value}
              ref={(el) => props.dock.inputRef?.(el)}
              onInput={(e) => props.dock.onInput(e.currentTarget.value)}
              onKeyDown={key}
            />
            <div data-kit="cv-bar">
              <WithAct
                act={props.dock.checkIn.act}
                render={(trigger) => (
                  <button type="button" {...trigger()} data-kit="cv-ghost" data-part="crew.dock.checkin" title={props.dock.checkIn.title}>
                    <Icon name="clock" />
                    <span data-text="control">{props.dock.checkIn.label}</span>
                  </button>
                )}
              />
              <span data-kit="grow" />
              <button type="button" data-kit="send" data-part="crew.dock.send" title={props.dock.send} aria-label={props.dock.send} onClick={() => props.dock.onSend()}>
                <Icon name="enter" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export interface CrewJobProps {
  readonly id: string;
  /** where it came from: v1 .cv-kind ("You", "Check-in", "Tagged in …") */
  readonly kind: { readonly icon: IconName; readonly label: string; readonly you?: boolean };
  readonly time: string;
  readonly timeTitle?: string;
  /** what it was asked */
  readonly prompt?: string | undefined;
  readonly face: JSX.Element;
  readonly pill?: { readonly label: string; readonly tone: string } | undefined;
  /** working: its live line; else its title and summary */
  readonly live?: string | undefined;
  readonly title?: string;
  readonly summary?: string | undefined;
  /** asking you: the question */
  readonly question?: string | undefined;
  readonly unread?: boolean;
  readonly state: string;
  /** Open job, Follow up, Save for later */
  readonly actions: readonly { readonly icon: IconName; readonly label: string; readonly on?: boolean; readonly onClick: () => void }[];
  /** under its actions: what the job proposed for the kit (v1 .cv-offer) */
  readonly extra?: JSX.Element;
}

/** v1 .cv-job: the request (where from, when, what was asked), then the member's answer. */
export function CrewJob(props: CrewJobProps): JSX.Element {
  return (
    <article data-kit="cv-job" data-part="crew.job" data-state={props.state} data-unread={flag(props.unread)}>
      <div data-kit="cv-req">
        <span data-kit="cv-kind" data-you={flag(props.kind.you)}>
          <Icon name={props.kind.icon} />
          <span data-text="control">{props.kind.label}</span>
        </span>
        <time data-kit="cv-time" title={props.timeTitle}>
          {props.time}
        </time>
        <Show when={props.prompt}>
          <div data-kit="cv-prompt">{props.prompt}</div>
        </Show>
      </div>
      <div data-kit="cv-res">
        {props.face}
        <div data-kit="cv-say">
          <Show when={props.pill}>
            {(p) => (
              <div data-kit="cv-head">
                <span data-kit="it-pill" data-tone={p().tone}>
                  <i />
                  {p().label}
                </span>
              </div>
            )}
          </Show>
          <Show
            when={props.question}
            fallback={
              <Show
                when={props.live}
                fallback={
                  <>
                    <p data-kit="cv-title">{props.title}</p>
                    <Show when={props.summary}>
                      <p data-kit="cv-sum">{props.summary}</p>
                    </Show>
                  </>
                }
              >
                <p data-kit="cv-live">{props.live}</p>
              </Show>
            }
          >
            <div data-kit="cv-asks">
              <p data-kit="cv-q">{props.question}</p>
            </div>
          </Show>
          <div data-kit="cv-acts">
            <For each={props.actions}>
              {(a) => (
                <button type="button" data-kit="cv-ghost" data-on={flag(a.on)} aria-pressed={a.on === undefined ? undefined : a.on} onClick={() => a.onClick()}>
                  <Icon name={a.icon} />
                  <span data-text="control">{a.label}</span>
                </button>
              )}
            </For>
          </div>
          {props.extra}
        </div>
      </div>
    </article>
  );
}

/** v1 .cv-quiet: check-ins that found nothing, one faint line. */
export function CrewQuiet(props: { readonly label: string; readonly time: string }): JSX.Element {
  return (
    <div data-kit="cv-quiet" data-part="crew.quiet">
      <Icon name="clock" />
      <span>{props.label}</span>
      <time>{props.time}</time>
    </div>
  );
}

/** v1 .cv-empty: nothing done yet. `lines` are the two sentences; `code` the @handle in the second. */
export function CrewEmpty(props: { readonly face: JSX.Element; readonly name: string; readonly first: string; readonly second: readonly [string, string, string] }): JSX.Element {
  return (
    <div data-kit="cv-empty" data-part="crew.empty">
      {props.face}
      <p>
        <b>{props.name}</b> {props.first}
      </p>
      <p>
        {props.second[0]}
        <code>{props.second[1]}</code>
        {props.second[2]}
      </p>
    </div>
  );
}

/** v1 .cv-facts: how it works, one line each. */
export function CrewFacts(props: { readonly items: readonly { readonly icon: IconName; readonly text: string; readonly logo?: string | undefined; readonly onClick?: (() => void) | undefined }[] }): JSX.Element {
  return (
    <div data-kit="cv-facts" data-part="crew.facts">
      <For each={props.items}>
        {(m) => {
          const inner = (): JSX.Element => (
            <>
              <Show when={m.logo} fallback={<Icon name={m.icon} />}>
                {(src) => (
                  <i data-kit="cv-logo">
                    <img src={src()} alt="" />
                  </i>
                )}
              </Show>
              <span title={m.text}>{m.text}</span>
            </>
          );
          return (
            <Show when={m.onClick} fallback={<div data-kit="cv-fact">{inner()}</div>}>
              {(go) => (
                <button type="button" data-kit="cv-fact" data-go="" onClick={() => go()()}>
                  {inner()}
                  <Icon name="chevron" />
                </button>
              )}
            </Show>
          );
        }}
      </For>
    </div>
  );
}

/** v1 .cv-actions: Check in now, Edit…, and Remove as its icon at the end. */
export function CrewSideActions(props: { readonly items: readonly { readonly icon: IconName; readonly label: string; readonly danger?: boolean; readonly act: Act }[] }): JSX.Element {
  return (
    <div data-kit="cv-actions" data-part="crew.actions">
      <For each={props.items}>
        {(a) => (
          <WithAct
            act={a.act}
            render={(trigger) => (
              <button type="button" {...trigger()} data-kit="cv-ghost" data-danger={flag(a.danger)} title={a.label} aria-label={a.label}>
                <Icon name={a.icon} />
                <Show when={!a.danger}>
                  <span data-text="control">{a.label}</span>
                </Show>
              </button>
            )}
          />
        )}
      </For>
    </div>
  );
}

/** v1 .cv-sec: Notebook, Brief, Skills and instructions; a link on the right of its heading. */
export function CrewSection(props: {
  readonly part: string;
  readonly title: string;
  readonly link?: { readonly label: string; readonly onClick: () => void } | undefined;
  /** how many it holds, beside the title (v1 h5 small) */
  readonly count?: number | undefined;
  /** a control at the title's end in place of the link (the kit's Add menu) */
  readonly tool?: JSX.Element;
  /** files dropped on the section (the kit's .md files, v1 .cv-kit.drop): it lights up while they're over it */
  readonly onFiles?: (files: File[]) => void;
  readonly children: JSX.Element;
}): JSX.Element {
  const [over, setOver] = createSignal(false);
  const files = (e: DragEvent): boolean => !!props.onFiles && !!e.dataTransfer?.types.includes('Files');
  return (
    <div
      data-kit="cv-sec"
      data-part={props.part}
      data-drop={flag(over())}
      onDragOver={(e) => {
        if (!files(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        if (!files(e)) return;
        e.preventDefault();
        setOver(false);
        props.onFiles?.([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      <h5>
        {props.title}
        <Show when={props.count}>{(n) => <small>{n()}</small>}</Show>
        <Show when={props.tool}>
          <span data-kit="cv-sec-tool">{props.tool}</span>
        </Show>
        <Show when={props.link}>
          {(l) => (
            <button type="button" data-kit="link" data-tone="accent" onClick={() => l().onClick()}>
              {l().label}
            </button>
          )}
        </Show>
      </h5>
      {props.children}
    </div>
  );
}

/** v1 .cv-none / .cv-text: a section's words. */
export function CrewText(props: { readonly text: string; readonly empty?: boolean; readonly dashed?: boolean; readonly onClick?: () => void }): JSX.Element {
  return (
    <Show when={props.dashed && props.onClick} fallback={<p data-kit={props.empty ? 'cv-none' : 'cv-text'}>{props.text}</p>}>
      <button type="button" data-kit="cv-nb-empty" onClick={() => props.onClick?.()}>
        {props.text}
      </button>
    </Show>
  );
}
