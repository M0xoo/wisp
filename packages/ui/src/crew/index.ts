// The crew's kit pieces (plugins/crew/ui, design/crew.md): faces and the rail. The spirit code and
// the `Spirit` component are exported once, from home/ (crew/Spirit.tsx draws Face's spirit by mood).
export { Face, faceColor, type FaceProps, type FaceSize } from './Face.tsx';
export { Rail, RailTile, RailCard, type RailProps, type RailTileProps, type RailCardProps } from './Rail.tsx';
export { isEmojiAvatar, spiritHash, type SpiritColor, type SpiritMood } from './spirit-code.ts';
