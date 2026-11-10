// How this plugin reaches the shell's context: @wisp/shell's own useShell() and provider (toast, nav,
// platform, focus targets), the one the shell's render provides.
import type { ShellContext } from '@wisp/shell/contract';

export { ShellProvider, useShell } from '@wisp/shell';

/** The part of the shell this plugin uses. */
export type ShipShell = Pick<ShellContext, 'toast' | 'nav' | 'platform' | 'focusTargets'>;
