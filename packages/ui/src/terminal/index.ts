// The terminal: a DOM-free VT screen (Screen), the keys a terminal sends (keyBytes and friends),
// and <Terminal>, which paints a Screen and sends input back.
export { Screen, SCROLLBACK, type Modes, type ScreenOptions } from './screen.ts';
export { BOLD, BLINK, DIM, HIDDEN, INVERSE, ITALIC, PLAIN, STRIKE, UNDER, charWidth, rowText, type Color, type Pen, type Row } from './cells.ts';
export { FOCUS_IN, FOCUS_OUT, KEY_ROW, compose, keyBytes, mouseDrag, mousePress, mouseRelease, pasted, rowKeyBytes, wheelBytes, type KeyLike, type RowKey } from './keys.ts';
export { ANSI, Painter, color256, colorOf, edgeBg, rowHtml, type PaintStats } from './paint.ts';
export { Terminal, SYNC_MS, type TerminalHandle, type TerminalLabels, type TerminalProps } from './Terminal.tsx';
