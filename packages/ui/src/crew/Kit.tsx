// A crew member's kit (v1 crew-kit.js, crew.css .cv-kit / .ck-row / .ki-row / .cv-offer): the files on its page,
// each a button that opens it and a switch; a list of files to pick (from this computer, or a job's proposal);
// and a proposal under the job that made it. The caller owns the kit and every write.
import { For, Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { Switch } from '../controls/Switch.tsx';

export interface CrewKitRow {
  readonly id: string;
  readonly kind: 'skill' | 'rules';
  readonly name: string;
  /** a skill's When, or an instructions file's "Every job · 1.2k characters" */
  readonly note: string;
  readonly on: boolean;
  /** the open button's title (Edit this skill) */
  readonly title: string;
  /** the switch's accessible name (Use release-notes) */
  readonly toggle: string;
}

/** v1 .ck-row: the files on a member's page; locked (a spell's), they read but don't change. */
export function CrewKitList(props: { readonly rows: readonly CrewKitRow[]; readonly locked?: boolean; readonly onOpen: (id: string) => void; readonly onToggle: (id: string, on: boolean) => void }): JSX.Element {
  return (
    <For each={props.rows}>
      {(k) => (
        <div data-kit="ck-row" data-off={flag(!k.on)} data-part="crew.kit.row">
          <button type="button" data-kit="ck-open" title={k.title} disabled={props.locked === true} onClick={() => props.onOpen(k.id)}>
            <Icon name={k.kind === 'skill' ? 'spark' : 'file'} size="sm" />
            <span data-kit="ck-text" data-one="">
              <b>{k.name}</b>
              <small title={k.note}>{k.note}</small>
            </span>
          </button>
          <Switch part="crew.kit.switch" checked={k.on} disabled={props.locked === true} aria-label={k.toggle} onChange={(on) => props.onToggle(k.id, on)} />
        </div>
      )}
    </For>
  );
}

export interface CrewPickRow {
  readonly key: string;
  readonly kind: 'skill' | 'rules';
  readonly name: string;
  readonly description?: string | undefined;
  /** where it was found (~/.claude/skills/release-notes) */
  readonly from?: string | undefined;
  readonly picked: boolean;
  /** in the kit already: ticked and greyed, with its pill */
  readonly added?: boolean;
  /** Added, Same as yours, Replaces yours */
  readonly pill?: string | undefined;
}

/** v1 .ki-row: files to pick, a checkbox each; `onOpen` (an offer's files) makes the name a button that opens it. */
export function CrewPickList(props: {
  readonly rows: readonly CrewPickRow[];
  readonly onPick: (key: string, on: boolean) => void;
  readonly onOpen?: (key: string) => void;
  /** the name button's title, with onOpen */
  readonly open?: string;
  /** a group's heading (Skills, Instructions) */
  readonly title?: string;
  /** what shows when there are no rows (or while loading: placeholder rows with `loading`) */
  readonly empty?: string;
  readonly loading?: boolean;
}): JSX.Element {
  const text = (r: CrewPickRow): JSX.Element => (
    <>
      <Icon name={r.kind === 'skill' ? 'spark' : 'file'} size="sm" />
      <span data-kit="ki-text">
        <b>{r.name}</b>
        <Show when={r.description}>{(d) => <small>{d()}</small>}</Show>
        <Show when={r.from}>{(f) => <code>{f()}</code>}</Show>
      </span>
    </>
  );
  return (
    <div data-kit="ki-list" data-part="crew.kit.picks">
      <Show when={props.title}>{(h) => <h5>{h()}</h5>}</Show>
      <Show when={props.loading}>
        <For each={[0, 1, 2]}>{() => <div data-kit="ki-row" data-ph=""><i /><span data-kit="ki-text"><b /><small /></span></div>}</For>
      </Show>
      <Show when={!props.loading && !props.rows.length && props.empty}>{(e) => <p data-kit="cv-none">{e()}</p>}</Show>
    <For each={props.rows}>
      {(r) => (
        <div data-kit="ki-row" data-added={flag(r.added === true)} data-part="crew.kit.pick">
          <input type="checkbox" checked={r.picked || r.added === true} disabled={r.added === true} aria-label={r.name} onChange={(e) => props.onPick(r.key, e.currentTarget.checked)} />
          <Show when={props.onOpen} fallback={<span data-kit="ki-label">{text(r)}</span>}>
            {(open) => (
              <button type="button" data-kit="ki-label" title={props.open} onClick={() => open()(r.key)}>
                {text(r)}
              </button>
            )}
          </Show>
          <Show when={r.pill}>{(p) => <span data-kit="ki-pill">{p()}</span>}</Show>
        </div>
      )}
    </For>
    </div>
  );
}

/** v1 .cv-offer: files a job proposed, under it in the thread; settled, one line says what became of it. */
export function CrewOffer(props: {
  readonly title: string;
  readonly hint: string;
  readonly children?: JSX.Element;
  readonly add?: { readonly label: string; readonly disabled: boolean; readonly onClick: () => void };
  readonly dismiss?: { readonly label: string; readonly onClick: () => void };
  /** a settled offer: what was added (names) or that it was dismissed */
  readonly settled?: { readonly taken: boolean; readonly text: string; readonly names: readonly string[] } | undefined;
}): JSX.Element {
  return (
    <Show
      when={!props.settled}
      fallback={
        <div data-kit="cv-offer" data-settled="" data-part="crew.offer">
          <Icon name={props.settled?.taken ? 'check' : 'x'} size="sm" />
          <span>
            {props.settled?.text}
            <For each={props.settled?.names ?? []}>{(n, i) => <>{i() ? ', ' : ' '}<code>{n}</code></>}</For>
          </span>
        </div>
      }
    >
      <div data-kit="cv-offer" data-part="crew.offer">
        <p data-kit="co-head" data-layout="wrap">
          <Icon name="wizard" size="sm" />
          <b>{props.title}</b>
          <small>{props.hint}</small>
        </p>
        {props.children}
        <div data-kit="co-acts">
          <Show when={props.add}>
            {(a) => (
              <button type="button" data-kit="button" data-variant="primary" data-size="sm" disabled={a().disabled} onClick={() => a().onClick()}>
                {a().label}
              </button>
            )}
          </Show>
          <Show when={props.dismiss}>
            {(d) => (
              <button type="button" data-kit="button" data-variant="ghost" data-size="sm" onClick={() => d().onClick()}>
                {d().label}
              </button>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}
