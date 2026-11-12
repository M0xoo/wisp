// The `video` block (v1 web/js/blocks.js R.video): a video the agent made or recorded, played in
// place with the browser's own controls, loaded through the host (ctx.media); full screen goes to the viewer with the
// answer's other pictures and videos, and Download and Show in folder sit top right like a picture's.
import { createSignal, Show, type JSX } from 'solid-js';
import { useBlockT } from './context.tsx';
import { Caption, MediaTools, useMedia } from './Image.tsx';
import { MediaViewer, mediaSet, type ViewItem } from './Viewer.tsx';
import { opt } from './read.ts';
import { CantShow } from './rich-ui.tsx';
import type { BlockProps } from './types.ts';

export function VideoBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const media = useMedia(props);
  const [broken, setBroken] = createSignal(false);
  const caption = (): string | undefined => opt(props.block['caption']);
  let video: HTMLVideoElement | undefined;
  const [view, setView] = createSignal<{ list: readonly ViewItem[]; at: number } | undefined>();
  // full screen is wisp's viewer, with the answer's other pictures and videos: the button, or the player's own
  // full screen, which hands over to it (v1 handOver)
  const open = (): void => {
    if (!video) return;
    video.pause();
    setView(mediaSet(video));
  };
  const handOver = (): void => {
    if (document.fullscreenElement !== video) return;
    void document.exitFullscreen().catch(() => undefined);
    open();
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
              onFullscreenChange={handOver}
            />
            <MediaTools src={src()} name={opt(props.block['source']) ?? media.name()} alt={caption() ?? media.name()} video part="video.tools" onFull={open} />
          </div>
        )}
      </Show>
      <Caption text={caption()} part="block.video.caption" />
      <Show when={view()}>{(v) => <MediaViewer list={v().list} at={v().at} onClose={() => setView(undefined)} />}</Show>
    </figure>
  );
}
