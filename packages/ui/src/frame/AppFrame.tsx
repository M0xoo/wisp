// AppFrame: a page wisp doesn't trust, in a sandboxed iframe (an app launched in wisp, a pinned
// pane, a preview of a dev server, an answer's interactive block). It keeps its box while it loads
// (a placeholder in the frame's place, never an empty hole), and a new address never flashes: the
// frame showing stays until the next one has loaded on top of it (v1 features/panes.js appFrame).
//
// Messages: only from the frame it made (`event.source`), and only from `origin` when one is given;
// replies and `post` go to that origin (or '*' for a srcdoc's opaque origin). `lock` puts the page in
// a script-less wrapper whose CSP pins where it may navigate (v1 paneWrapperDoc): the page's
// `parent` is then the wrapper, so its messages arrive on the wrapper's window, and ours reach it
// from its parent's parent. `onTheme` hears wisp's tokens after each load and when the theme changes,
// for the owner to post: a page on another origin can't read our styles.
import { createEffect, createSignal, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { flag, styleOf, sub, type KitProps, type PartName, type WithVars } from '../core/props.ts';
import { useT } from '../core/i18n.tsx';
import { Skeleton } from '../content/Skeleton.tsx';
import { lockDoc, readTheme, watchTheme, type FrameTheme } from './theme.ts';

export interface AppFrameController {
  /** loads the page again (the same address, or the same srcdoc) */
  reload(): void;
  /** posts to the newest frame: calls go to a new version from the start */
  post(message: unknown): void;
  focus(): void;
}

/** A fixed page size in CSS px, shown scaled by `scale` (a phone-sized preview in a narrow column). */
export interface AppFramePage {
  readonly w: number;
  readonly h: number;
}

export interface AppFrameProps extends KitProps, WithVars {
  /** The frame's accessible name: what the page is. */
  readonly title: string;
  readonly src?: string;
  readonly srcdoc?: string;
  /** The sandbox tokens ('' turns everything off). Required: a frame here is never unsandboxed. */
  readonly sandbox: string;
  readonly allow?: string;
  readonly referrerPolicy?: 'no-referrer' | 'origin' | 'same-origin' | 'strict-origin-when-cross-origin';
  /** The wrapper's CSP (see above); a change writes the wrapper again. */
  readonly lock?: string;
  /** The page's origin: messages from anywhere else are dropped, and ours go only there. */
  readonly origin?: string;
  readonly page?: AppFramePage;
  readonly scale?: number;
  readonly lazy?: boolean;
  /** What the placeholder says to a screen reader (default: the kit's "Loading"). */
  readonly loadingLabel?: string;
  readonly onMessage?: (data: unknown, reply: (message: unknown) => void) => void;
  /** after every load of the page, its own navigations included */
  readonly onLoad?: () => void;
  readonly onTheme?: (theme: FrameTheme) => void;
  readonly controller?: (c: AppFrameController) => void;
}

interface Frames {
  shown: HTMLIFrameElement | null;
  pending: HTMLIFrameElement | null;
  wrapper: HTMLIFrameElement | null;
  wrapped: boolean; // the wrapper has loaded and can take a page
  stop: () => void;
}

// size-ok: the frame's lifecycle is one set of closures over the frames it made
export function AppFrame(props: AppFrameProps): JSX.Element {
  const t = useT();
  const part = (): PartName => props.part ?? 'ui.app-frame';
  const [ready, setReady] = createSignal(false);
  const f: Frames = { shown: null, pending: null, wrapper: null, wrapped: false, stop: () => {} };
  let stage: HTMLDivElement | undefined;
  const target = (): string => props.origin ?? '*';
  const newest = (): HTMLIFrameElement | null => f.pending ?? f.shown;

  const onMessage = (e: MessageEvent): void => {
    const win = newest()?.contentWindow;
    if (!win || e.source !== win || (props.origin !== undefined && e.origin !== props.origin)) return;
    props.onMessage?.(e.data, (m) => win.postMessage(m, target()));
  };
  const listenOn = (w: Window): void => {
    f.stop();
    w.addEventListener('message', onMessage);
    f.stop = () => w.removeEventListener('message', onMessage);
  };

  const make = (doc: Document): HTMLIFrameElement => {
    const el = doc.createElement('iframe');
    el.setAttribute('title', props.title);
    el.setAttribute('sandbox', props.sandbox);
    if (props.allow) el.setAttribute('allow', props.allow);
    if (props.referrerPolicy) el.setAttribute('referrerpolicy', props.referrerPolicy);
    if (props.lazy) el.setAttribute('loading', 'lazy');
    return el;
  };

  const load = (doc: Document, into: HTMLElement): void => {
    if (props.src === undefined && props.srcdoc === undefined) return;
    f.pending?.remove();
    const el = make(doc);
    let over = f.shown;
    if (over) el.setAttribute('data-pending', '');
    el.addEventListener('load', () => {
      over?.remove();
      over = null;
      el.removeAttribute('data-pending');
      if (f.pending === el) f.pending = null;
      f.shown = el;
      setReady(true);
      props.onLoad?.();
      props.onTheme?.(readTheme());
    });
    if (props.srcdoc !== undefined) el.srcdoc = props.srcdoc;
    else if (props.src !== undefined) el.src = props.src;
    f.pending = el;
    into.append(el);
  };

  const lockWith = (csp: string): void => {
    f.wrapper?.remove();
    f.shown = f.pending = null;
    f.wrapped = false;
    setReady(false);
    const w = document.createElement('iframe');
    w.setAttribute('title', props.title);
    // a frame only gets what the frame around it has (clipboard-write)
    if (props.allow) w.setAttribute('allow', props.allow);
    w.srcdoc = lockDoc(csp);
    // Every load (moving the node reloads it) is a new, empty window: listen and fill it again.
    w.addEventListener('load', () => {
      const win = w.contentWindow;
      const doc = w.contentDocument;
      if (!win || !doc?.body) return;
      f.shown = f.pending = null;
      f.wrapped = true;
      listenOn(win);
      load(doc, doc.body);
    });
    f.wrapper = w;
    stage?.append(w);
  };

  const navigate = (): void => {
    if (props.lock === undefined) {
      if (stage) load(document, stage);
      return;
    }
    const doc = f.wrapper?.contentDocument;
    if (f.wrapped && doc?.body) load(doc, doc.body);
  };

  onMount(() => {
    if (props.lock === undefined) listenOn(window);
    createEffect(on(() => props.lock, (csp) => csp !== undefined && lockWith(csp)));
    createEffect(on(() => [props.src, props.srcdoc] as const, navigate));
    const stopTheme = watchTheme((th) => ready() && props.onTheme?.(th));
    onCleanup(() => {
      stopTheme();
      f.stop();
    });
  });

  props.controller?.({
    reload: () => {
      const el = newest();
      if (props.srcdoc !== undefined || !el) return navigate();
      el.src = props.src ?? el.src;
    },
    post: (m) => newest()?.contentWindow?.postMessage(m, target()),
    focus: () => newest()?.focus(),
  });

  return (
    <div
      id={props.id}
      data-kit="app-frame"
      data-part={part()}
      data-ready={flag(ready())}
      data-page={flag(props.page !== undefined)}
      style={styleOf({ '--k-af-w': props.page?.w, '--k-af-h': props.page?.h, '--k-af-scale': props.scale ?? 1 }, props.vars)}
    >
      <div data-kit="app-frame-stage" data-part={sub(part(), 'stage')} ref={(el) => (stage = el)} />
      <Show when={!ready()}>
        <div data-kit="app-frame-wait" data-part={sub(part(), 'wait')} role="status" aria-label={props.loadingLabel ?? t('loading')}>
          <Skeleton shape="line" width="1/3" />
          <Skeleton shape="block" width="full" />
          <Skeleton shape="line" width="2/3" />
        </div>
      </Show>
    </div>
  );
}
