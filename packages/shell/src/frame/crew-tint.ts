// The crew tint (v1 crew.js paintCrewTint, panelTint, glowOf; #768), DOM-free: a member picked on the rail gives the
// list beside it and its top bar a very light wash of their colour, so a glance says whose jobs it holds. None when
// nothing is picked, the setting (`crew.tint`) is off, or their tint is none.
import { isSpirit, parseSpirit } from '@wisp/ui';

export interface TintMember {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly color?: string;
  /** the task panel's tint: '' their glow, 'none', or a crew colour (v1 `bg`, kept on the member) */
  readonly bg?: string;
}

/** The colour a member glows: its spirit's own, else the colour it was given, else one rolled from its name. */
export const glowOf = (m: TintMember): string => (m.avatar && isSpirit(m.avatar) ? parseSpirit(m.avatar).color : m.color || parseSpirit('', m.name).color);

/** The list's tint for the picked member, or undefined. */
export function crewTint(picked: TintMember | undefined, on: unknown): string | undefined {
  if (!picked || on === false || on === 'off' || picked.bg === 'none') return undefined;
  return picked.bg || glowOf(picked);
}
