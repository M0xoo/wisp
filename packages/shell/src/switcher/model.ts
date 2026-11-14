// ⌃Tab (v1 web/js/features/switcher.js), pure: back to the task you had open before, like
// switching apps. A tap jumps there; with Ctrl held each Tab steps through the tasks, latest
// first, and letting go opens the one picked. Nothing is drawn for a tap (it's over in 130 ms).

export const SWITCHER_MAX = 20;
export const SHOW_AFTER_MS = 130;

export interface SwitchState {
  readonly ids: readonly string[];
  readonly sel: number;
  readonly from: string | undefined;
}

/** Starts a switch from the open task over the recent ones; undefined when there's nowhere to go. */
export function startSwitch(open: string | undefined, recent: readonly string[], fits: (id: string) => boolean, back: boolean): SwitchState | undefined {
  const ids = [...new Set([...(open === undefined ? [] : [open]), ...recent])].filter(fits).slice(0, SWITCHER_MAX);
  const at = open !== undefined && ids[0] === open ? 0 : -1;
  if (ids.length === 0 || (ids.length === 1 && at === 0)) return undefined;
  const n = ids.length;
  return { ids, from: open, sel: back ? (at < 0 ? n - 1 : (at - 1 + n) % n) : (at + 1) % n };
}

export function step(s: SwitchState, by: number): SwitchState {
  const n = s.ids.length;
  return { ...s, sel: (s.sel + by + n) % n };
}

/** Where letting go goes: the picked task, unless it's the one already open. */
export function pick(s: SwitchState): string | undefined {
  const id = s.ids[s.sel];
  return id === s.from ? undefined : id;
}
