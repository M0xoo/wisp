// <Terminal>: a Screen (screen.ts) painted into a box, with the keys, the mouse, a phone's
// composing and the key row going back to the program through `onData`. Painting happens once per
// animation frame and only for rows that changed (paint.ts); a synchronized frame (mode 2026) waits
// up to SYNC_MS so a frame split across two chunks of output never shows half drawn. The box's
// cell grid is measured with one ResizeObserver; a new grid resizes the screen and is reported
// through `onResize` (the caller debounces telling the program). No timers: frames and idle
// callbacks only, all cancelled on unmount.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { flag, type KitProps } from '../core/props.ts';
import { KEY_ROW, type RowKey } from './keys.ts';
import { rowKey, wireKeys, wireMouse, wireScroll, type InputHost } from './input.ts';
import { Painter } from './paint.ts';
import type { Screen } from './screen.ts';

export const SYNC_MS = 150;

const KEY_CAPS: Readonly<Record<Exclude<RowKey, 'paste'>, string>> = { esc: 'Esc', ctrlc: '^C', tab: 'Tab', stab: '⇧Tab', ctrl: 'Ctrl', left: '←', up: '↑', down: '↓', right: '→' };

export interface TerminalLabels {
  /** the hidden input's accessible name ("Terminal input") */
  readonly input: string;
  /** the key row's ("Keys") */
  readonly keys: string;
  /** the key row's Paste button */
  readonly paste: string;
}

export interface TerminalHandle {
  focus(): void;
  blur(): void;
  /** the grid the box holds now, or null while it has no size (hidden) */
  size(): { cols: number; rows: number } | null;
}

export interface TerminalProps extends KitProps {
  readonly screen: Screen;
  /** bytes for the program: keys, pastes, mouse and focus reports (the screen's own replies are the caller's) */
  readonly onData: (data: string) => void;
  /** the box's grid changed; the screen is already resized */
  readonly onResize?: (cols: number, rows: number) => void;
  /** the program has exited: no cursor, and a key or click calls onEndedKey */
  readonly ended?: boolean;
  readonly onEndedKey?: () => void;
  /** shown over the screen until the program draws something ("Opening the session in Claude Code…") */
  readonly waiting?: string;
  readonly labels: TerminalLabels;
  /** the phone's key row; default: on a coarse pointer */
  readonly keyRow?: boolean;
  /** Option types characters instead of sending Meta; default: from the platform */
  readonly mac?: boolean;
  /** the Paste key couldn't read the clipboard: the caller says how to paste instead */
  readonly onPasteFailed?: () => void;
  readonly ref?: (h: TerminalHandle) => void;
  /** a fixed height of this many rows (a block, the gallery); default: fill the parent */
  readonly lines?: number;
  /** smallest grid sent to a program, however small the box */
  readonly min?: { readonly cols: number; readonly rows: number };
}

interface Cell {
  font: string;
  w: number;
  h: number;
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** false inside a display:none ancestor (a hidden pane); engines without checkVisibility paint anyway */
const visible = (el: HTMLElement): boolean => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);
const coarse = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

// size-ok: the component's frame loop, fit and wiring share its element refs and local state
export function Terminal(props: TerminalProps): JSX.Element {
  let root!: HTMLDivElement;
  let box!: HTMLDivElement;
  let rows!: HTMLDivElement;
  let back!: HTMLDivElement;
  let live!: HTMLDivElement;
  let input!: HTMLTextAreaElement;
  const [focused, setFocused] = createSignal(false);
  const [ctrl, setCtrl] = createSignal(false);
  const [drawn, setDrawn] = createSignal(false);
  const touch = (): boolean => props.keyRow ?? coarse();
  let cell: Cell | null = null;
  let stick = true; // the view follows new output until you scroll up
  let lastTop = 0;
  let frame = 0;
  let idle = 0;
  let painter: Painter | null = null;
  const ctl = new AbortController();

  const shown = (): boolean => box.isConnected && visible(box);

  const measure = (): { w: number; h: number } => {
    const font = getComputedStyle(rows).font;
    if (cell?.font === font && cell.w) return cell;
    const probe = rows.ownerDocument.createElement('span');
    probe.setAttribute('data-kit', 'term-probe');
    probe.textContent = 'W'.repeat(40);
    rows.append(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    const lh = Number.parseFloat(getComputedStyle(rows).lineHeight) || r.height;
    cell = { font, w: r.width / 40 || 8, h: Math.ceil(lh) || 17 };
    return cell;
  };

  const size = (): { cols: number; rows: number } | null => {
    const st = getComputedStyle(box);
    const w = box.clientWidth - Number.parseFloat(st.paddingLeft || '0') - Number.parseFloat(st.paddingRight || '0');
    const h = box.clientHeight - Number.parseFloat(st.paddingTop || '0') - Number.parseFloat(st.paddingBottom || '0');
    if (!(w > 0) || !(h > 0)) return null;
    const m = measure();
    const min = props.min ?? { cols: 20, rows: 5 };
    return { cols: Math.max(min.cols, Math.floor(w / m.w)), rows: Math.max(min.rows, Math.floor(h / m.h)) };
  };

  const fit = (): void => {
    const s = size();
    if (!s || !cell) return;
    root.style.setProperty('--k-term-lh', `${cell.h}px`);
    root.style.setProperty('--k-term-cw', `${cell.w}px`);
    const sc = props.screen;
    if (sc.cols === s.cols && sc.rows === s.rows) return;
    sc.resize(s.cols, s.rows); // the screen's watcher schedules the paint
    props.onResize?.(s.cols, s.rows);
  };

  const fillBack = (): void => {
    if (idle || !painter || painter.from <= 0) return;
    const ric = globalThis.requestIdleCallback ?? ((f: () => void): number => requestAnimationFrame(f));
    const step = (): void => {
      idle = 0;
      if (!painter || ctl.signal.aborted) return;
      const h = box.scrollHeight;
      const more = painter.fillChunk(props.screen);
      if (stick || props.screen.alt) box.scrollTop = box.scrollHeight;
      else box.scrollTop += box.scrollHeight - h; // older rows come in above without moving what you read
      lastTop = box.scrollTop;
      if (more) idle = ric(step);
    };
    idle = ric(step);
  };

  const paint = (): void => {
    frame = 0;
    const sc = props.screen;
    if (!painter || !shown()) return; // painted when it's shown: the next resize schedules it
    if (sc.modes.sync && sc.now() - sc.syncAt < SYNC_MS) return void (frame = requestAnimationFrame(paint));
    painter.paint(sc, sc.modes.cursor && !props.ended);
    const edge = painter.edge(sc);
    if (edge.changed) {
      if (edge.color) box.style.setProperty('--k-term-edge', edge.color);
      else box.style.removeProperty('--k-term-edge');
    }
    if (stick || sc.alt) box.scrollTop = box.scrollHeight;
    lastTop = box.scrollTop;
    if (!drawn() && (sc.back.length > 0 || sc.screen.some((r) => r.c.some((c) => c !== ' ')))) setDrawn(true);
    if (cell) {
      input.style.setProperty('--k-term-x', `${Math.min(sc.x, sc.cols - 1) * cell.w}px`);
      input.style.setProperty('--k-term-y', `${sc.y * cell.h}px`);
    }
    fillBack();
  };

  const schedule = (): void => {
    if (!frame && !ctl.signal.aborted) frame = requestAnimationFrame(paint);
  };

  const host: InputHost = {
    box,
    live,
    input,
    signal: ctl.signal,
    screen: () => props.screen,
    ended: () => props.ended === true,
    mac: () => props.mac ?? isMac(),
    touch,
    type: (data) => {
      stick = true;
      box.scrollTop = box.scrollHeight;
      props.onData(data);
    },
    send: (data) => props.onData(data),
    endedKey: () => props.onEndedKey?.(),
    cell: () => cell ?? measure(),
    focus: () => {
      if (!props.ended) input.focus({ preventScroll: true });
    },
    setFocused,
    ctrlOnce: ctrl,
    setCtrlOnce: setCtrl,
    pasteFailed: () => props.onPasteFailed?.(),
    // Scrolled up, the view stays put while output comes in; back at the bottom, it follows again.
    // Only a move up counts: new output and trimmed scrollback move it too.
    scrolled: () => {
      if (box.scrollTop < lastTop - 1) stick = false;
      else if (box.scrollHeight - box.scrollTop - box.clientHeight < (cell?.h ?? 17)) stick = true;
      lastTop = box.scrollTop;
    },
  };

  onMount(() => {
    Object.assign(host, { box, live, input });
    painter = new Painter(back, live);
    wireKeys(host);
    wireMouse(host);
    wireScroll(host);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        fit();
        schedule();
      });
      ro.observe(box);
      ctl.signal.addEventListener('abort', () => ro.disconnect());
    }
    fit();
    props.ref?.({ focus: host.focus, blur: () => input.blur(), size });
  });

  // Another screen shown here is painted afresh; a write, resize or reset of this one schedules a frame.
  createEffect(
    on(
      () => props.screen,
      (sc) => {
        painter?.forget();
        stick = true;
        lastTop = 0;
        setDrawn(false);
        const stop = sc.watch(schedule);
        onCleanup(stop);
        if (painter) fit();
        schedule();
      },
    ),
  );
  createEffect(on(() => props.ended, schedule, { defer: true })); // the cursor goes when it ends

  onCleanup(() => {
    ctl.abort();
    if (frame) cancelAnimationFrame(frame);
    if (idle) (globalThis.cancelIdleCallback ?? cancelAnimationFrame)(idle);
  });

  const part = (): `${string}.${string}` => props.part ?? 'ui.terminal';
  return (
    <div ref={root} id={props.id} data-kit="term" data-part={part()} data-focused={flag(focused())} data-touch={flag(touch())} data-ended={flag(props.ended)} data-fixed={flag(props.lines !== undefined)} style={props.lines === undefined ? undefined : { '--k-term-lines': String(props.lines) }}>
      <div ref={box} data-kit="term-screen" data-part={`${part()}.screen`}>
        <Show when={props.waiting !== undefined && !drawn() && !props.ended}>
          <div data-kit="term-wait" aria-live="polite">
            <span data-text="control">{props.waiting}</span>
            <i />
            <i />
            <i />
            <i />
          </div>
        </Show>
        <div ref={rows} data-kit="term-rows">
          <div ref={back} data-kit="term-back" />
          <div data-kit="term-live-box">
            <div ref={live} data-kit="term-live" />
            <textarea ref={input} data-kit="term-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false} aria-label={props.labels.input} />
          </div>
        </div>
      </div>
      <Show when={touch()}>
        <div data-kit="term-keys" data-part={`${part()}.keys`} role="toolbar" aria-label={props.labels.keys} onPointerDown={(e) => e.preventDefault()}>
          <For each={KEY_ROW}>
            {(k) => (
              <button type="button" data-kit="term-key" data-on={flag(k === 'ctrl' && ctrl())} aria-pressed={k === 'ctrl' ? ctrl() : undefined} onClick={() => void rowKey(host, k, () => navigator.clipboard.readText())}>
                <span data-text="control">{k === 'paste' ? props.labels.paste : KEY_CAPS[k]}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
