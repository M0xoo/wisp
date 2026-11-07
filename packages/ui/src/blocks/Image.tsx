// The `image` and `video` blocks (v1 web/js/blocks.js R.image, R.video): a picture or a video the
// agent made, loaded through the host (ctx.media turns its path into a URL the page can load), with
// its caption. A click opens it full size; one that can't load says so in one calm line.
import { createSignal, Show, type JSX } from 'solid-js';
import { IconButton } from '../controls/Button.tsx';
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

export function ImageBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const media = useMedia(props);
  const [broken, setBroken] = createSignal(false);
  const caption = (): string | undefined => opt(props.block['caption']);
  const open = (): void => {
    const u = media.url();
    if (u) ctx.openUrl?.(u);
  };
  return (
    <figure data-kit="rb-media" data-card="" data-part="block.image" data-broken={broken() || !media.url() ? '' : undefined}>
      <Show when={!broken() && media.url()} fallback={<CantShow part="block.image.missing">{t('block.image.missing')}</CantShow>}>
        {(src) => (
          <div data-kit="rb-media-box">
            <img
              data-kit="rb-image"
              data-zoom={ctx.openUrl ? '' : undefined}
              src={src()}
              alt={caption() ?? media.name()}
              loading="lazy"
              decoding="async"
              onClick={open}
              onError={() => setBroken(true)}
            />
            <Show when={ctx.openUrl}>
              <div data-kit="rb-media-tools" data-part="image.tools">
                <IconButton icon="expand" size="sm" label={t('block.image.open')} onClick={open} />
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Caption text={caption()} part="block.image.caption" />
    </figure>
  );
}
