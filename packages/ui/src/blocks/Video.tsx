// The `video` block (v1 web/js/blocks.js R.video): a video the agent made or recorded, played in
// place with the browser's own controls, loaded through the host (ctx.media).
import { createSignal, Show, type JSX } from 'solid-js';
import { IconButton } from '../controls/Button.tsx';
import { useBlocks, useBlockT } from './context.tsx';
import { Caption, useMedia } from './Image.tsx';
import { opt } from './read.ts';
import { CantShow } from './rich-ui.tsx';
import type { BlockProps } from './types.ts';

export function VideoBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const media = useMedia(props);
  const [broken, setBroken] = createSignal(false);
  const caption = (): string | undefined => opt(props.block['caption']);
  let video: HTMLVideoElement | undefined;
  const open = (): void => {
    const u = media.url();
    if (!u) return;
    video?.pause();
    ctx.openUrl?.(u);
  };
  return (
    <figure data-kit="rb-media" data-card="" data-part="block.video" data-video="" data-broken={broken() || !media.url() ? '' : undefined}>
      <Show when={!broken() && media.url()} fallback={<CantShow part="block.video.missing">{t('block.video.missing')}</CantShow>}>
        {(src) => (
          <div data-kit="rb-media-box">
            <video
              ref={video}
              data-kit="rb-video"
              src={src()}
              controls
              playsinline
              preload="metadata"
              aria-label={caption() ?? (media.name() || t('block.video.name'))}
              onError={() => setBroken(true)}
            />
            <Show when={ctx.openUrl}>
              <div data-kit="rb-media-tools" data-part="video.tools">
                <IconButton icon="expand" size="sm" label={t('block.video.open')} onClick={open} />
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Caption text={caption()} part="block.video.caption" />
    </figure>
  );
}
