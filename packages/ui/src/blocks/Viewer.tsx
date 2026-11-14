// The media viewer (v1 ui/viewer.js, blocks.js zoomInSet): a picture or video from an answer, full screen. Given the
// answer's other pictures and videos, in order, the arrows, ← / → and the count go through them. A click on a
// picture zooms in there and out again; Escape, × or a click beside it closes. Copy (also ⌘C / Ctrl+C) and
// Download take a picture elsewhere; a video plays with its own controls and has no zoom or copy.
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from '../content/Icon.tsx';
import { useBlockT } from './context.tsx';
import { copyImage, fileName } from './media-copy.ts';

export interface ViewItem {
  readonly src: string;
  readonly alt: string;
  readonly video?: boolean;
}

/** The answer's pictures and videos that loaded, in order, and where `from` is among them (v1 zoomInSet). */
export function mediaSet(from: Element): { readonly list: readonly ViewItem[]; readonly at: number } {
  const root = from.closest("[data-kit='answer']") ?? from.parentElement;
  const all = [...(root?.querySelectorAll("[data-kit='rb-media']:not([data-broken]) [data-kit='rb-image'], [data-kit='rb-media']:not([data-broken]) [data-kit='rb-video']") ?? [])];
  const list = all.map((m) => ({ src: m.getAttribute('src') ?? '', alt: (m.tagName === 'VIDEO' ? m.getAttribute('aria-label') : m.getAttribute('alt')) ?? '', video: m.tagName === 'VIDEO' }));
  const at = all.indexOf(from);
  return at < 0 ? { list: [{ src: from.getAttribute('src') ?? '', alt: from.getAttribute('alt') ?? '', video: from.tagName === 'VIDEO' }], at: 0 } : { list, at };
}

const ZOOM = 2.5;

export function MediaViewer(props: { readonly list: readonly ViewItem[]; readonly at: number; readonly onClose: () => void }): JSX.Element {
  const t = useBlockT();
  const [at, setAt] = createSignal(Math.max(0, Math.min(props.list.length - 1, props.at)));
  const [zoom, setZoom] = createSignal<{ x: number; y: number } | undefined>();
  const [copied, setCopied] = createSignal(false);
  const item = (): ViewItem => props.list[at()] ?? { src: '', alt: '' };
  const many = (): boolean => props.list.length > 1;
  const go = (d: number): void => {
    const n = at() + d;
    if (n < 0 || n >= props.list.length) return;
    setZoom(undefined);
    setCopied(false);
    setAt(n);
  };
  const copy = (): void => {
    void copyImage(item().src).then((ok) => setCopied(ok));
  };
  let node: HTMLDivElement | undefined;
  // the page's own keys stand down while it's open: what it handles goes no further
  const onKey = (e: KeyboardEvent): void => {
    const own = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') return (own(), props.onClose());
    const vid = item().video;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(vid && e.target instanceof HTMLVideoElement)) return (own(), go(e.key === 'ArrowLeft' ? -1 : 1));
    if (!vid && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'c') return (own(), copy());
  };
  onMount(() => {
    addEventListener('keydown', onKey, true);
    node?.focus();
  });
  onCleanup(() => removeEventListener('keydown', onKey, true));
  const onPic = (e: MouseEvent): void => {
    e.stopPropagation();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setZoom(zoom() ? undefined : { x: ((e.clientX - box.left) / Math.max(1, box.width)) * 100, y: ((e.clientY - box.top) / Math.max(1, box.height)) * 100 });
  };
  return (
    <Portal>
      <div
        ref={node}
        data-kit="viewer"
        data-part="block.viewer"
        role="dialog"
        aria-modal="true"
        aria-label={item().alt || t('block.viewer.name')}
        tabIndex={-1}
        data-set={many() ? '' : undefined}
        data-video={item().video ? '' : undefined}
        data-zoomed={zoom() ? '' : undefined}
        onClick={() => props.onClose()}
      >
        <Show
          when={item().video}
          fallback={
            <img
              data-kit="viewer-img"
              src={item().src}
              alt={item().alt}
              draggable={false}
              style={zoom() ? { '--vw-zoom': String(ZOOM), '--vw-x': `${zoom()?.x ?? 50}%`, '--vw-y': `${zoom()?.y ?? 50}%` } : {}}
              onClick={onPic}
            />
          }
        >
          <video data-kit="viewer-vid" src={item().src} controls playsinline autoplay aria-label={item().alt || t('block.video.name')} onClick={(e) => e.stopPropagation()} />
        </Show>
        <Show when={many()}>
          <button
            type="button"
            data-kit="viewer-nav"
            data-side="prev"
            data-part="block.viewer.prev"
            aria-label={t('block.viewer.prev')}
            title={t('block.viewer.prevTip')}
            disabled={at() === 0}
            onClick={(e) => (e.stopPropagation(), go(-1))}
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            data-kit="viewer-nav"
            data-side="next"
            data-part="block.viewer.next"
            aria-label={t('block.viewer.next')}
            title={t('block.viewer.nextTip')}
            disabled={at() === props.list.length - 1}
            onClick={(e) => (e.stopPropagation(), go(1))}
          >
            <Icon name="chevron" />
          </button>
        </Show>
        <div data-kit="viewer-bar" data-part="block.viewer.bar" onClick={(e) => e.stopPropagation()}>
          <Show when={many()}>
            <span data-kit="viewer-count" aria-live="polite">
              {t('block.viewer.count', { n: at() + 1, of: props.list.length })}
            </span>
            <span data-kit="viewer-sep" />
          </Show>
          <Show when={!item().video}>
            <button
              type="button"
              data-kit="viewer-btn"
              data-part="block.viewer.copy"
              data-done={copied() ? '' : undefined}
              aria-label={t('block.image.copy')}
              title={t('block.image.copyTip')}
              onClick={copy}
            >
              <Icon name={copied() ? 'check' : 'copy'} />
            </button>
          </Show>
          <a
            data-kit="viewer-btn"
            data-part="block.viewer.download"
            href={item().src}
            download={fileName(item().src, item().alt)}
            aria-label={t('block.image.download')}
            title={t('block.image.download')}
          >
            <Icon name="download" />
          </a>
          <a data-kit="viewer-btn" data-part="block.viewer.open" href={item().src} target="_blank" rel="noopener" aria-label={t('block.viewer.original')} title={t('block.viewer.original')}>
            <Icon name="external" />
          </a>
          <button type="button" data-kit="viewer-btn" data-part="block.viewer.close" aria-label={t('block.viewer.close')} title={t('block.viewer.close')} onClick={() => props.onClose()}>
            <Icon name="x" />
          </button>
        </div>
      </div>
    </Portal>
  );
}
