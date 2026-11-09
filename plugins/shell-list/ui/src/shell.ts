// How this plugin reaches the shell's context (ShellContext in @wisp/shell's contract: t, nav,
// navigate, toast, platform, selection, sidebar, palette, extensions): @wisp/shell's own useShell()
// and provider, the one the shell's render provides (and the tests use).

export { ShellProvider, useShell } from '@wisp/shell';
