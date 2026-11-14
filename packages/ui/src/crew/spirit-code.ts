// The crew's view of a spirit code. The code itself (parts, rolling, parsing) lives once in
// home/spirit-shape.ts; this adds the names crew's Face and Spirit read: a colour, a mood, the
// blink hash, and whether an avatar is an emoji rather than a code.
import { SPIRIT, hash, isSpirit, parseSpirit, type SpiritParts } from '../home/spirit-shape.ts';

export { SPIRIT, PARTS as SPIRIT_PARTS, isSpirit, parseSpirit, rollSpirit, spiritCode, type SpiritPart, type SpiritParts } from '../home/spirit-shape.ts';

export type SpiritColor = SpiritParts['color'];
/** idle breathes and blinks, live floats, asks hops, sleep closes its eyes (css/crew.css) */
export type SpiritMood = 'idle' | 'live' | 'asks' | 'sleep';

/** FNV-1a of a code or seed: staggers blinks so a crew doesn't blink together. */
export const spiritHash = (s: string): number => hash(s);

/** An avatar that is set and is not a spirit code is an emoji. */
export const isEmojiAvatar = (avatar: string | undefined): boolean => !!avatar && !isSpirit(avatar);

export const SPIRIT_COLORS: readonly SpiritColor[] = SPIRIT.color;
