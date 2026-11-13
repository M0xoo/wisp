// The spirit maker's choices (v1 crew.js paintMaker), as plain data so tests need no DOM.
import { SPIRIT, isSpirit, parseSpirit, spiritCode, type SpiritPart } from '../home/spirit-shape.ts';

export interface MakerOption {
  readonly value: string;
  /** the avatar with this part swapped in */
  readonly code: string;
  /** this is the avatar's part now (never for an emoji avatar: it has no parts) */
  readonly on: boolean;
}

/** The choices of one part: each is the current spirit with that part swapped (v1's data-code). */
export function makerOptions(avatar: string, seed: string, part: SpiritPart): readonly MakerOption[] {
  const mine = isSpirit(avatar);
  const p = parseSpirit(mine ? avatar : '', seed || 'wisp');
  return (SPIRIT[part] as readonly string[]).map((value) => ({ value, code: spiritCode({ ...p, [part]: value }), on: mine && p[part] === value }));
}
