// v1 crew.js crewEditor's form (design/crew.md): Start from (the ready-made members, Import…), who they are (the
// face with its dice, Name and Role inline, the @handle line), Their job, Checks in (cadence chips, Custom… opens a
// line typed in words), Also starts when (event chips), the bar (where, project, harness, delegates, mode, how many at
// once), and the foot (First check-in now, Cancel, the action). The caller owns the draft; this draws it.
import { For, Show, type JSX } from 'solid-js';
import { flag, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { WithAct, ActIcon, type Act } from '../app/act.tsx';
import { Face } from './Face.tsx';
import { Spirit } from './Spirit.tsx';

export interface CrewEditorTemplate {
  readonly key: string;
  readonly label: string;
  readonly avatar: string;
}

export interface CrewEditorChip {
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
}

export interface CrewEditorBarItem {
  readonly id: string;
  /** tog: a plain toggle (where, project, delegates); runner: harness and model; mode: what they may do */
  readonly kind: 'tog' | 'runner' | 'mode';
  readonly icon: IconName;
  readonly label: string;
  /** the runner's second word (Default) */
  readonly note?: string;
  readonly title?: string;
  /** the mode's glyph in warn (Full auto) or accent (Plan) */
  readonly tone?: 'warn' | 'accent' | undefined;
  readonly act: Act;
}

export interface CrewEditorFormProps {
  readonly start?: { readonly label: string; readonly templates: readonly CrewEditorTemplate[]; readonly picked: string | undefined; readonly onPick: (key: string) => void; readonly import?: { readonly label: string; readonly title: string; readonly onClick: () => void } | undefined } | undefined;
  readonly face: { readonly avatar: string; readonly name: string; readonly color?: string; readonly title: string; readonly onRoll: () => void };
  readonly name: { readonly label: string; readonly value: string; readonly placeholder: string; readonly onInput: (v: string) => void };
  readonly role: { readonly label: string; readonly value: string; readonly placeholder: string; readonly onInput: (v: string) => void };
  /** under the names: how to reach them, or what's wrong with the name */
  readonly handle: { readonly text: string; readonly code?: string; readonly after?: string; readonly bad?: boolean };
  readonly job: { readonly label: string; readonly hint: string; readonly value: string; readonly placeholder: string; readonly onInput: (v: string) => void };
  readonly cadence: { readonly label: string; readonly hint: string; readonly chips: readonly CrewEditorChip[]; readonly value: string; readonly onPick: (v: string) => void; readonly custom: { readonly value: string; readonly placeholder: string; readonly read: string; readonly bad: boolean; readonly onInput: (v: string) => void } | undefined };
  readonly events: { readonly label: string; readonly hint: string; readonly chips: readonly CrewEditorChip[]; readonly on: readonly string[]; readonly onToggle: (v: string) => void };
  readonly bar: readonly CrewEditorBarItem[];
  readonly parallel: { readonly label: string; readonly title: string; readonly value: number; readonly less: string; readonly more: string; readonly onStep: (by: number) => void };
  readonly checkin?: { readonly label: string; readonly on: boolean; readonly onToggle: (on: boolean) => void } | undefined;
  readonly cancel: { readonly label: string; readonly onClick: () => void };
  readonly submit: { readonly label: string; readonly onClick: () => void };
  readonly part?: PartName;
}

function Chips(props: { readonly chips: readonly CrewEditorChip[]; readonly on: (v: string) => boolean; readonly onPick: (v: string) => void; readonly pressed?: boolean }): JSX.Element {
  return (
    <For each={props.chips}>
      {(c) => (
        <button type="button" data-kit="lp-chip" data-on={flag(props.on(c.value))} aria-pressed={props.pressed ? props.on(c.value) : undefined} onClick={() => props.onPick(c.value)}>
          <Show when={c.icon}>{(i) => <Icon name={i()} size="sm" />}</Show>
          {c.label}
        </button>
      )}
    </For>
  );
}

// size-ok: one form, v1's sections in order
export function CrewEditorForm(props: CrewEditorFormProps): JSX.Element {
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    props.submit.onClick();
  };
  return (
    <div data-kit="ce" data-part={props.part ?? 'crew.editor'}>
      <Show when={props.start}>
        {(s) => (
          <div data-kit="ce-templates" data-layout="wrap" data-part="crew.editor.templates">
            <span data-kit="ce-lbl">{s().label}</span>
            <For each={s().templates}>
              {(tp) => (
                <button type="button" data-kit="lp-chip" data-on={flag(s().picked === tp.key)} onClick={() => s().onPick(tp.key)}>
                  <span data-kit="ce-tav">
                    <Spirit code={tp.avatar} small />
                  </span>
                  {tp.label}
                </button>
              )}
            </For>
            <Show when={s().import}>
              {(im) => (
                <button type="button" data-kit="lp-chip" title={im().title} onClick={() => im().onClick()}>
                  <Icon name="download" size="sm" />
                  {im().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>
      <form data-kit="ce-form" onSubmit={submit}>
        <div data-kit="ce-who">
          <button type="button" data-kit="ce-face" title={props.face.title} aria-label={props.face.title} onClick={() => props.face.onRoll()}>
            <Face avatar={props.face.avatar} name={props.face.name} {...(props.face.color !== undefined && { color: props.face.color })} size="xl" />
            <span data-kit="ce-dice">
              <Icon name="rerun" size="sm" />
            </span>
          </button>
          <div data-kit="ce-names">
            <label data-kit="ce-field" data-part="crew.editor.name">
              <span>{props.name.label}</span>
              <input name="name" maxlength="24" value={props.name.value} placeholder={props.name.placeholder} spellcheck={false} autocomplete="off" required onInput={(e) => props.name.onInput(e.currentTarget.value)} />
            </label>
            <label data-kit="ce-field" data-part="crew.editor.role">
              <span>{props.role.label}</span>
              <input name="role" maxlength="60" value={props.role.value} placeholder={props.role.placeholder} spellcheck={false} autocomplete="off" onInput={(e) => props.role.onInput(e.currentTarget.value)} />
            </label>
            <p data-kit="ce-handle" data-bad={flag(props.handle.bad === true)} aria-live="polite">
              {props.handle.text}
              <Show when={props.handle.code}>{(c) => <code>{c()}</code>}</Show>
              {props.handle.after}
            </p>
          </div>
        </div>
        <label data-kit="ce-stack" data-part="crew.editor.brief">
          <span>
            {props.job.label} <small>{props.job.hint}</small>
          </span>
          <textarea data-kit="ce-textarea" name="brief" rows="4" maxlength="4000" value={props.job.value} placeholder={props.job.placeholder} onInput={(e) => props.job.onInput(e.currentTarget.value)} />
        </label>
        <div data-kit="ce-stack" data-part="crew.editor.cron">
          <span>
            {props.cadence.label} <small>{props.cadence.hint}</small>
          </span>
          <div data-kit="ce-cadence" data-layout="wrap">
            <Chips chips={props.cadence.chips} on={(v) => v === props.cadence.value} onPick={(v) => props.cadence.onPick(v)} />
          </div>
          <Show when={props.cadence.custom}>
            {(c) => (
              <div data-kit="ce-cron" data-layout="wrap">
                <input data-kit="ce-input" name="cron" value={c().value} placeholder={c().placeholder} spellcheck={false} autocomplete="off" onInput={(e) => c().onInput(e.currentTarget.value)} />
                <span data-kit="ce-cron-read" data-bad={flag(c().bad)} aria-live="polite">
                  {c().read}
                </span>
              </div>
            )}
          </Show>
        </div>
        <div data-kit="ce-stack" data-part="crew.editor.events">
          <span>
            {props.events.label} <small>{props.events.hint}</small>
          </span>
          <div data-kit="ce-cadence" data-layout="wrap" data-on-chips="">
            <Chips chips={props.events.chips} on={(v) => props.events.on.includes(v)} onPick={(v) => props.events.onToggle(v)} pressed />
          </div>
        </div>
        <div data-kit="ce-bar" data-layout="wrap" data-part="crew.editor.bar">
          <For each={props.bar}>
            {(b) => (
              <WithAct
                act={b.act}
                render={(trigger) => (
                  <button type="button" data-kit={b.kind === 'mode' ? 'ce-mode' : b.kind === 'runner' ? 'ce-runner' : 'ce-tog'} data-tone={b.tone} data-a={b.id} title={b.title} {...trigger()}>
                    <ActIcon act={b.act}>
                      <Icon name={b.icon} size="sm" />
                    </ActIcon>
                    <span>{b.label}</span>
                    <Show when={b.note}>{(n) => <small>{n()}</small>}</Show>
                    <Show when={b.kind === 'runner'}>
                      <Icon name="chevron" size="sm" />
                    </Show>
                  </button>
                )}
              />
            )}
          </For>
          <span data-kit="ce-par" title={props.parallel.title}>
            <button type="button" aria-label={props.parallel.less} disabled={props.parallel.value <= 1} onClick={() => props.parallel.onStep(-1)}>
              <Icon name="minus" size="sm" />
            </button>
            <b>{props.parallel.label}</b>
            <button type="button" aria-label={props.parallel.more} disabled={props.parallel.value >= 5} onClick={() => props.parallel.onStep(1)}>
              <Icon name="plus" size="sm" />
            </button>
          </span>
        </div>
        <footer data-kit="ce-foot" data-part="crew.editor.foot">
          <Show when={props.checkin}>
            {(c) => (
              <label data-kit="ce-check">
                <input type="checkbox" name="checkin" checked={c().on} onChange={(e) => c().onToggle(e.currentTarget.checked)} /> {c().label}
              </label>
            )}
          </Show>
          <span data-kit="ce-grow" />
          <button type="button" data-kit="button" data-variant="ghost" data-size="sm" onClick={() => props.cancel.onClick()}>
            {props.cancel.label}
          </button>
          <button type="submit" data-kit="button" data-variant="primary" data-size="sm">
            {props.submit.label}
          </button>
        </footer>
      </form>
    </div>
  );
}
