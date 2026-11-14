// What Auto will run, opened from the launcher's Auto pick (v1 auto-preview.js openPop, auto.css .auto-pop): the
// pick, why, its odds, cost and time, a better model worth a try, up to four others, then Never pick this model for
// this kind of task and How Auto picks. A row runs that pick instead. 340px wide under its anchor (above it when it
// doesn't fit), on the page itself; the first row has the focus, ↑↓ go round, Escape or a click outside closes.
import { For, Show, onCleanup, onMount, createSignal, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { styleOf } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export interface AutoPopRow {
  readonly key: string;
  /** the harness's logo (an image URL) */
  readonly logo?: string | undefined;
  readonly title: string;
  readonly sub: string;
  /** "89%" */
  readonly chance: string;
  /** "~$0.28", or '' */
  readonly usd: string;
}

export interface AutoPopProps {
  /** where it opens from: the launcher's Auto pick */
  readonly anchor: () => Element | null | undefined;
  readonly label: string;
  /** the pick; none: Nothing to run, and why */
  readonly head: { readonly logo?: string | undefined; readonly title: string; readonly sub: string } | { readonly nothing: string; readonly why: string };
  readonly why?: string | undefined;
  /** "83% likely to work" (the number bold), "~$0.11", "~1 min" */
  readonly facts?: readonly { readonly strong?: string; readonly text: string }[];
  readonly suggest?: { readonly heading: string; readonly row: AutoPopRow } | undefined;
  readonly others?: { readonly heading: string; readonly rows: readonly AutoPopRow[] } | undefined;
  readonly never?: string | undefined;
  readonly how: string;
  readonly onPick: (key: string) => void;
  readonly onNever: () => void;
  readonly onHow: () => void;
  readonly onClose: () => void;
}

const GAP = 6;
const EDGE = 8;

export function AutoPop(props: AutoPopProps): JSX.Element {
  let box: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ x: EDGE, y: EDGE });
  const place = (): void => {
    const a = props.anchor()?.getBoundingClientRect();
    if (!a || !box) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    setPos({ x: Math.max(EDGE, Math.min(a.left, innerWidth - w - EDGE)), y: a.bottom + GAP + h < innerHeight - EDGE ? a.bottom + GAP : Math.max(EDGE, a.top - GAP - h) });
  };
  const buttons = (): HTMLButtonElement[] => [...(box?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };
  const onDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (box?.contains(t) || props.anchor()?.contains(t)) return;
    props.onClose();
  };
  onMount(() => {
    place();
    buttons()[0]?.focus();
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onDown, true);
    addEventListener('resize', place);
  });
  onCleanup(() => {
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('resize', place);
  });
  const row = (r: AutoPopRow, sug: boolean): JSX.Element => (
    <button type="button" data-kit="menu-item" data-part={sug ? 'autoPreview.suggest' : 'autoPreview.alternatives'} data-ap={sug ? 'sug' : 'alt'} onClick={() => props.onPick(r.key)}>
      <span data-kit="rb-logo">
        <Show when={r.logo}>{(src) => <img src={src()} alt="" />}</Show>
      </span>
      <span data-kit="ap-text">
        <b>{r.title}</b>
        <small>{r.sub}</small>
      </span>
      <Show when={r.chance}>
        <span data-kit="ap-n">{r.chance}</span>
      </Show>
      <Show when={r.usd}>
        <span data-kit="ap-n">{r.usd}</span>
      </Show>
    </button>
  );
  return (
    <Portal>
      <div
        ref={(el) => (box = el)}
        data-kit="menu"
        data-part="autoPreview.panel"
        data-auto-pop=""
        role="dialog"
        aria-label={props.label}
        style={styleOf({ '--k-x': `${pos().x}px`, '--k-y': `${pos().y}px` })}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const list = buttons();
          const i = list.indexOf(document.activeElement as HTMLButtonElement);
          list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
        }}
      >
        <div data-kit="ap-head">
          <span data-kit="rb-logo">{'nothing' in props.head ? <Icon name="warn" /> : <Show when={props.head.logo}>{(src) => <img src={src()} alt="" />}</Show>}</span>
          <div data-kit="ap-title">
            <b>{'nothing' in props.head ? props.head.nothing : props.head.title}</b>
            <small>{'nothing' in props.head ? props.head.why : props.head.sub}</small>
          </div>
        </div>
        <Show when={props.why}>
          <p data-kit="ap-why">{props.why}</p>
        </Show>
        <Show when={(props.facts?.length ?? 0) > 0}>
          <div data-kit="ap-facts">
            <For each={props.facts}>
              {(f) => (
                <span>
                  <Show when={f.strong}>
                    <b>{f.strong}</b>{' '}
                  </Show>
                  {f.text}
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.suggest}>
          {(s) => (
            <>
              <div data-kit="ap-h">{s().heading}</div>
              {row(s().row, true)}
            </>
          )}
        </Show>
        <Show when={props.others && props.others.rows.length > 0 && props.others}>
          {(o) => (
            <>
              <div data-kit="ap-h">{o().heading}</div>
              <For each={o().rows}>{(r) => row(r, false)}</For>
            </>
          )}
        </Show>
        <div data-kit="menu-separator" />
        <Show when={props.never}>
          <button type="button" data-kit="menu-item" data-part="autoPreview.never" onClick={() => props.onNever()}>
            <Icon name="x" />
            <span>{props.never}</span>
          </button>
        </Show>
        <button type="button" data-kit="menu-item" data-part="autoPreview.how" onClick={() => props.onHow()}>
          <Icon name="settings" />
          <span>{props.how}</span>
        </button>
      </div>
    </Portal>
  );
}
