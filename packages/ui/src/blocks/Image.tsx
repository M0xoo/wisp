// The `image` and `video` blocks (v1 web/js/blocks.js R.image, R.video): a picture or a video the
// agent made, loaded through the host (ctx.media turns its path into a URL the page can load), with
// its caption. A click opens it full screen with the answer's other pictures and videos (Viewer.tsx); on hover,
// Copy, Download, Save to My Stuff and Show in folder; one that can't load says so in one calm line.
import { createSignal, Show, type JSX } from 'solid-js';
import { IconButton } from '../controls/Button.tsx';
import { Icon } from '../content/Icon.tsx';
import { createTimer } from './content-scope.ts';
import { KeepButton } from './keep-button.tsx';
import { mediaKeep } from './keep.ts';
import { copyImage, fileName } from './media-copy.ts';
import { MediaViewer, mediaSet, type ViewItem } from './Viewer.tsx';
import { useBlocks, useBlockT } from './context.tsx';
import { opt } from './read.ts';
import { CantShow, InlineMd } from './rich-ui.tsx';
import type { BlockProps } from './types.ts';

/** What the agent named (`path`, else `src`), and the URL the host gives for it. */
export function useMedia(props: BlockProps): { readonly name: () => string; readonly url: () => string | undefined } {
  const ctx = useBlocks();
  const name = (): string => opt(props.block['path']) ?? opt(props.block['src']) ?? '';
  return { name, url: () => (name() ? ctx.media?.(name()) : undefined) };
}

export function Caption(props: { readonly text: string | undefined; readonly part: `${string}.${string}` }): JSX.Element {
  return (
    <Show when={props.text}>
      {(c) => (
        <figcaption data-kit="rb-media-caption" data-part={props.part}>
          <InlineMd source={c()} />
        </figcaption>
      )}
    </Show>
  );
}

/** The bar on a picture or video, top right on hover (v1 imageButtons, folderButton): Copy (pictures), Download, Show
 *  in folder (a file on the computer, not a link), and full screen. */
export function MediaTools(props: {
  readonly src: string;
  readonly name: string;
  readonly alt: string;
  readonly video?: boolean;
  readonly part: `${string}.${string}`;
  readonly onFull: () => void;
  /** the block, for Save to My Stuff (v1 ctx.keep on R.image, R.video) */
  readonly block?: BlockProps['block'];
}): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const timer = createTimer();
  const [copied, setCopied] = createSignal(false);
  const copy = (): void =>
    void copyImage(props.src).then((ok) => {
      if (!ok) return;
      setCopied(true);
      timer.after(COPIED_MS, () => setCopied(false));
    });
  const folder = (): boolean => !!ctx.revealFile && !!props.name && !/^(https?:|data:|blob:)/.test(props.name);
  return (
    <div data-kit="rb-media-tools" data-part={props.part}>
      <Show when={props.video}>
        <IconButton icon="expand" size="sm" label={t('block.viewer.full')} onClick={props.onFull} part={`${props.part}.full`} />
      </Show>
      <Show when={!props.video}>
        <IconButton
          icon={copied() ? 'check' : 'copy'}
          tone={copied() ? 'good' : undefined}
          size="sm"
          label={copied() ? t('block.copied') : t('block.image.copy')}
          onClick={copy}
          part={`${props.part}.copy`}
        />
      </Show>
      <a
        data-kit="rb-media-btn"
        data-part={`${props.part}.download`}
        href={props.src}
        download={fileName(props.src, props.alt)}
        title={t('block.image.download')}
        aria-label={t('block.image.download')}
      >
        <Icon name="download" />
      </a>
      <KeepButton keep={props.block && mediaKeep(props.block, props.video ? 'video' : 'image')} size="sm" part={`${props.part}.keep`} />
      <Show when={folder()}>
        <IconButton icon="folder" size="sm" label={t('block.doc.reveal')} onClick={() => ctx.revealFile?.(props.name)} part={`${props.part}.folder`} />
      </Show>
    </div>
  );
}

const COPIED_MS = 1400;

export function ImageBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const media = useMedia(props);
  const [broken, setBroken] = createSignal(false);
  const [view, setView] = createSignal<{ list: readonly ViewItem[]; at: number } | undefined>();
  const caption = (): string | undefined => opt(props.block['caption']);
  let img: HTMLImageElement | undefined;
  const open = (): void => {
    if (img) setView(mediaSet(img));
  };
  return (
    <figure data-kit="rb-media" data-card="" data-part="block.image" data-broken={broken() || !media.url() ? '' : undefined}>
      <Show when={!broken() && media.url()} fallback={<CantShow part="block.image.missing">{t('block.image.missing')}</CantShow>}>
        {(src) => (
          <div data-kit="rb-media-box">
            <img ref={img} data-kit="rb-image" data-zoom="" src={src()} alt={caption() ?? media.name()} loading="lazy" decoding="async" onClick={open} onError={() => setBroken(true)} />
            <MediaTools src={src()} name={opt(props.block['source']) ?? media.name()} alt={caption() ?? media.name()} part="image.tools" onFull={open} block={props.block} />
          </div>
        )}
      </Show>
      <Caption text={caption()} part="block.image.caption" />
      <Show when={view()}>{(v) => <MediaViewer list={v().list} at={v().at} onClose={() => setView(undefined)} />}</Show>
    </figure>
  );
}
