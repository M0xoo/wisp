// Framed things: a page wisp doesn't trust in a sandboxed iframe (AppFrame), the theme it gets as
// CSS variables, and a preview box of fixed proportions (Thumb).
export { AppFrame, type AppFrameController, type AppFrameProps, type AppFramePage } from './AppFrame.tsx';
export { Thumb, type ThumbProps } from './Thumb.tsx';
export { FRAME_TOKENS, currentScheme, lockDoc, readTheme, themeCss, watchTheme, type FrameScheme, type FrameTheme } from './theme.ts';
