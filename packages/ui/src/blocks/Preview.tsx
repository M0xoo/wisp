// The `preview` block (v1 preview-frame.js): a live web page in the answer, framed as the phone, tablet or browser
// window the agent picked and scaled down to fit. The page runs in a sandboxed frame on its own origin (it can't
// reach wisp, navigate it or open dialogs over it). Phone · Tablet · Desktop (and the agent's own size), Rotate,
// Reload, Open in a new tab; the size and the scale under it. The host maps a URL to one this page can load
// (BlockContext.previewUrl: a proxied localhost, the grid's preview); a loopback URL it can't map says it may not load.
import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Wrap } from '../layout/Stack.tsx';
import type { IconName } from '../content/icons.ts';
import { InlineMd } from './content-parts.tsx';
import { useBlockT, useBlocks } from './context.tsx';
import { opt } from './read.ts';
import {
  DEVICES,
  DEVICE_IDS,
  BEZEL,
  deviceOf,
  fitScale,
  isLoopback,
  pageUrl,
  previewProblem,
  previewSandbox,
  previewSize,
  shortUrl,
  type PreviewDevice,
  type PreviewSize,
} from './rich-preview-spec.ts';
import { CantShow, OutLink } from './rich-ui.tsx';
import type { BlockProps } from './types.ts';

const ICON: Readonly<Record<PreviewDevice, IconName>> = {
  mobile: 'phone',
  tablet: 'tablet',
  desktop: 'laptop',
  custom: 'expand',
};
const MAX_H = 640;
const here = (): string => {
  try {
    return new URL(document.baseURI).origin;
  } catch {
    return '';
  }
};

export function PreviewBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const problem = previewProblem(props.block);
  const title = opt(props.block['title']);
  if (problem)
    return (
      <CantShow part="block.preview.cant">{`${t('block.preview.cant', { title: title ?? t('block.preview.name') })} ${t(problem === 'noUrl' ? 'block.preview.noUrl' : 'block.preview.badUrl')}`}</CantShow>
    );
  const url = pageUrl(props.block['url']) ?? '';
  const asked = previewSize(props.block);
  const mapped = ctx.previewUrl?.(url);
  const src = mapped ?? url;
  const local = !mapped && isLoopback(url) && !isLoopback(here());
  const [size, setSize] = createSignal<PreviewSize>(asked);
  const [scale, setScale] = createSignal(1);
  const [loaded, setLoaded] = createSignal(false);
  const [n, setN] = createSignal(0); // Reload remounts the frame
  let stage: HTMLDivElement | undefined;
  const fit = (): void => {
    if (!stage || !stage.clientWidth) return; // folded, or not on the page yet
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const maxH = Math.min(parseFloat(cs.maxHeight) || MAX_H, globalThis.innerHeight * 0.85);
    setScale(fitScale(size(), stage.clientWidth - padX, maxH - padY));
  };
  onMount(() => {
    const ro = new ResizeObserver(fit);
    if (stage) ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });
  const pick = (s: PreviewSize): void => {
    setSize(s);
    fit();
  };
  const devices = (): {
    id: PreviewDevice;
    w: number;
    h: number;
    label: string;
  }[] => [
    ...DEVICE_IDS.map((id) => ({
      id: id as PreviewDevice,
      ...DEVICES[id],
      label: t(`block.preview.${id}`),
    })),
    ...(asked.device === 'custom'
      ? [
          {
            id: 'custom' as PreviewDevice,
            w: asked.w,
            h: asked.h,
            label: `${asked.w}×${asked.h}`,
          },
        ]
      : []),
  ];
  const on = (): PreviewDevice | undefined => deviceOf(size(), asked);
  return (
    <figure data-kit="rb-preview" data-card="" data-part="block.preview">
      <div data-kit="rb-pv-head">
        <span data-kit="rb-pv-addr" title={url}>
          <Icon name={src.startsWith('https:') ? 'lock' : 'web'} size="sm" />
          <span>{shortUrl(url)}</span>
        </span>
        <div data-kit="rb-pv-seg" role="group" aria-label={t('block.preview.sizes')}>
          <For each={devices()}>
            {(d) => (
              <button
                type="button"
                data-on={on() === d.id ? '' : undefined}
                title={`${d.label} · ${d.w} × ${d.h}`}
                aria-label={d.label}
                aria-pressed={on() === d.id}
                onClick={() => pick({ device: d.id, w: d.w, h: d.h })}
              >
                <Icon name={ICON[d.id]} size="sm" />
                <span data-text="control">{d.label}</span>
              </button>
            )}
          </For>
        </div>
        <div data-kit="rb-pv-tools">
          <button type="button" data-kit="rb-pv-btn" title={t('block.preview.rotate')} aria-label={t('block.preview.rotate')} onClick={() => pick({ ...size(), w: size().h, h: size().w })}>
            <Icon name="rotate" size="sm" />
          </button>
          <button type="button" data-kit="rb-pv-btn" title={t('block.preview.reload')} aria-label={t('block.preview.reload')} onClick={() => (setLoaded(false), setN(n() + 1))}>
            <Icon name="rerun" size="sm" />
          </button>
          <OutLink href={src} part="block.preview.open" label={t('block.preview.open')} iconOnly />
        </div>
      </div>
      <div data-kit="rb-pv-stage" ref={(el) => (stage = el)}>
        <div
          data-kit="rb-pv-device"
          data-device={size().device}
          data-land={size().w > size().h ? '' : undefined}
          style={{
            '--k-pv-bx': `${BEZEL[size().device][0]}px`,
            '--k-pv-by': `${BEZEL[size().device][1]}px`,
          }}
        >
          <div
            data-kit="rb-pv-screen"
            data-loaded={loaded() ? '' : undefined}
            style={{
              '--k-pv-w': `${Math.floor(size().w * scale())}px`,
              '--k-pv-h': `${Math.floor(size().h * scale())}px`,
            }}
          >
            <Show when={String(n())} keyed>
              {(_k) => (
                <iframe
                  src={src}
                  title={title ?? shortUrl(url)}
                  sandbox={previewSandbox(src, here())}
                  referrerpolicy="no-referrer"
                  loading="lazy"
                  onLoad={() => setLoaded(true)}
                  style={{
                    '--k-pv-fw': `${size().w}px`,
                    '--k-pv-fh': `${size().h}px`,
                    '--k-pv-s': String(scale()),
                  }}
                />
              )}
            </Show>
          </div>
        </div>
      </div>
      <figcaption data-kit="rb-pv-foot">
        <Wrap gap="3" align="center" part="block.preview.foot">
          <Show when={title || opt(props.block['caption'])}>
            <span data-kit="rb-pv-cap">
              <Show when={title}>
                <b>{title}</b>
              </Show>
              <Show when={opt(props.block['caption'])}>{(c) => <InlineMd source={c()} part="block.preview.caption" />}</Show>
            </span>
          </Show>
          <span data-kit="rb-pv-meta">
            <span>{`${size().w} × ${size().h}${scale() < 0.995 ? ` · ${Math.round(scale() * 100)}%` : ''}`}</span>
            <span data-kit="rb-pv-tag" title={t('block.preview.sandboxTip')}>
              <Icon name="lock" size="sm" />
              {t('block.preview.sandboxed')}
            </span>
          </span>
          <Show when={local}>
            <span data-kit="rb-pv-note">
              <Icon name="info" size="sm" />
              {t('block.preview.local')}
            </span>
          </Show>
        </Wrap>
      </figcaption>
    </figure>
  );
}
