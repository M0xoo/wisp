// A member's face in the second half's screens: the kit's Avatar in the member's colour. The rail's
// spirit (crew-core's kit addition) replaces it once it's exported from @wisp/ui.
import type { JSX } from 'solid-js';
import { Avatar, type AvatarProps } from '@wisp/ui';

type ProjectColor = NonNullable<AvatarProps['color']>;

const COLORS = new Set(['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo', 'slate']);

export const colorOf = (c: string | undefined): ProjectColor => `pc-${c && COLORS.has(c) ? c : 'violet'}` as ProjectColor;

export function Face(props: { readonly m: { name: string; color?: string; paused?: boolean }; readonly size?: 'sm' | 'md' | 'lg' }): JSX.Element {
  return <Avatar part="crew.avatar" name={props.m.name} color={colorOf(props.m.color)} size={props.size ?? 'sm'} {...(props.m.paused ? { status: 'neutral' as const } : {})} />;
}
