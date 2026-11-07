// A crew member's face (v1 crew.js avatarHtml): its spirit, or the emoji it was given, on a disc of
// its colour, with the dot that says it asks you (amber) or has a report you haven't read (accent).
import { Show, type JSX } from 'solid-js';
import type { KitProps } from '../core/props.ts';
import { Spirit } from './Spirit.tsx';
import { isSpirit, parseSpirit, type SpiritColor, type SpiritMood } from './spirit-code.ts';

export type FaceSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface FaceProps extends KitProps {
  /** a spirit code, an emoji, or '' (rolled from `name`) */
  readonly avatar: string;
  readonly name: string;
  /** the member's colour when its avatar is an emoji (a spirit carries its own) */
  readonly color?: string;
  readonly mood?: SpiritMood;
  /** xs 20 · sm 24 · md 32 · lg 44 · xl 64 */
  readonly size?: FaceSize;
  readonly dot?: 'asks' | 'unread';
  /** paused: dimmed */
  readonly dim?: boolean;
  /** an accessible name; without one the face is decoration (the row names it) */
  readonly label?: string;
}

const COLORS = new Set<string>(['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo']);

/** The colour a member's face glows in. */
export function faceColor(avatar: string, name: string, color?: string): SpiritColor {
  if (isSpirit(avatar)) return parseSpirit(avatar).color;
  return color && COLORS.has(color) ? (color as SpiritColor) : parseSpirit('', name).color;
}

export function Face(props: FaceProps): JSX.Element {
  const emoji = (): boolean => !!props.avatar && !isSpirit(props.avatar);
  return (
    <span
      id={props.id}
      data-kit="face"
      data-part={props.part ?? 'crew.face'}
      data-size={props.size ?? 'md'}
      data-color={faceColor(props.avatar, props.name, props.color)}
      data-dim={props.dim ? '' : undefined}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <Show when={emoji()} fallback={<Spirit code={props.avatar} seed={props.name} mood={props.mood ?? 'idle'} small={props.size === 'xs'} />}>
        <span data-kit="face-emoji">{props.avatar}</span>
      </Show>
      <Show when={props.dot}>{(d) => <span data-kit="face-dot" data-tone={d()} />}</Show>
    </span>
  );
}
