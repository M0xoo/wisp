// Thumb: a preview of a thing in a box of fixed proportions (My Stuff's cards, a stuff block): a
// picture, a video's first frame (played muted while a mouse is over it, like a file browser), or
// whatever the caller draws inside. The box never changes size, so loading never moves a grid.
// Corner slots hold small controls over it (a star, Launch); they sit above the media.
import { createSignal, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';

export interface ThumbProps extends KitProps, WithChildren {
  /** a picture */
  readonly src?: string;
  /** a video (wins over src) */
  readonly video?: string;
  /** 'card' 16:10 (default), 'square', or 'fill': the parent's height */
  readonly ratio?: 'card' | 'square' | 'fill';
  readonly fit?: 'cover' | 'contain';
  readonly topStart?: JSX.Element;
  readonly topEnd?: JSX.Element;
  readonly bottomStart?: JSX.Element;
  readonly bottomEnd?: JSX.Element;
  /** a quiet mark while what it shows is still on its way */
  readonly busy?: boolean;
}

export function Thumb(props: ThumbProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.thumb';
  const [failed, setFailed] = createSignal(false);
  let video: HTMLVideoElement | undefined;
  const media = (): boolean => !failed() && (props.video !== undefined || props.src !== undefined);
  return (
    <div
      id={props.id}
      data-kit="thumb"
      data-part={part()}
      data-ratio={props.ratio ?? 'card'}
      data-fit={props.fit ?? 'cover'}
      data-busy={props.busy ? '' : undefined}
      onPointerEnter={(e) => e.pointerType === 'mouse' && video?.play().catch(() => undefined)}
      onPointerLeave={() => video?.pause()}
    >
      <Show when={media()} fallback={<div data-kit="thumb-body" data-part={sub(part(), 'body')}>{props.children}</div>}>
        <Show
          when={props.video}
          fallback={<img data-kit="thumb-media" src={props.src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />}
        >
          {(v) => <video data-kit="thumb-media" ref={(el) => (video = el)} src={`${v()}#t=0.1`} preload="metadata" muted playsinline loop onError={() => setFailed(true)} />}
        </Show>
      </Show>
      <Show when={props.topStart}>
        <div data-kit="thumb-corner" data-at="top-start" data-part={sub(part(), 'top-start')}>{props.topStart}</div>
      </Show>
      <Show when={props.topEnd}>
        <div data-kit="thumb-corner" data-at="top-end" data-part={sub(part(), 'top-end')}>{props.topEnd}</div>
      </Show>
      <Show when={props.bottomStart}>
        <div data-kit="thumb-corner" data-at="bottom-start" data-part={sub(part(), 'bottom-start')}>{props.bottomStart}</div>
      </Show>
      <Show when={props.bottomEnd}>
        <div data-kit="thumb-corner" data-at="bottom-end" data-part={sub(part(), 'bottom-end')}>{props.bottomEnd}</div>
      </Show>
    </div>
  );
}
