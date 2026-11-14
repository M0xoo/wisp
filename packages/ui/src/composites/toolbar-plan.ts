// How a bar runs out of room (design/layout.md §2): items step down lowest priority first, a label
// to its icon before anything moves into More, and pinned items never step down. Pure, so it is
// tested without a browser; Toolbar feeds it measured widths.

export type ItemForm = 'full' | 'icon' | 'overflow';
export type Priority = 'pin' | number;

export interface PlanItem {
  readonly id: string;
  readonly priority: Priority;
  /** Measured width with icon and label. */
  readonly full: number;
  /** Measured width as an icon button. */
  readonly icon: number;
}

export interface PlanInput {
  readonly items: readonly PlanItem[];
  /** The bar's inner width. */
  readonly available: number;
  readonly gap: number;
  /** The More button's width, added once anything overflows. */
  readonly more: number;
}

interface Step {
  readonly id: string;
  readonly to: 'icon' | 'overflow';
}

/** Collapse steps in order: every collapsible item to its icon (lowest priority first; on a tie the
 * later item goes first), then the same order into More. */
export function collapseSteps(items: readonly PlanItem[]): Step[] {
  const order = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.priority !== 'pin')
    .sort((a, b) => (a.item.priority as number) - (b.item.priority as number) || b.index - a.index)
    .map(({ item }) => item.id);
  return [...order.map((id) => ({ id, to: 'icon' as const })), ...order.map((id) => ({ id, to: 'overflow' as const }))];
}

/** The form of each item after the first `level` steps. */
export function formsAt(items: readonly PlanItem[], level: number): Map<string, ItemForm> {
  const forms = new Map<string, ItemForm>(items.map((i) => [i.id, 'full']));
  for (const step of collapseSteps(items).slice(0, level)) forms.set(step.id, step.to);
  return forms;
}

/** The row's width with these forms, gaps and (if needed) the More button included. */
export function widthAt(input: PlanInput, forms: ReadonlyMap<string, ItemForm>): number {
  let width = 0;
  let shown = 0;
  let overflow = false;
  for (const item of input.items) {
    const form = forms.get(item.id) ?? 'full';
    if (form === 'overflow') {
      overflow = true;
      continue;
    }
    width += form === 'full' ? item.full : item.icon;
    shown++;
  }
  if (overflow) {
    width += input.more;
    shown++;
  }
  return width + Math.max(0, shown - 1) * input.gap;
}

/** The fewest steps that make the row fit (all of them if nothing does: pins never collapse). */
export function levelFor(input: PlanInput, available: number = input.available): number {
  const max = collapseSteps(input.items).length;
  for (let level = 0; level <= max; level++) {
    if (widthAt(input, formsAt(input.items, level)) <= available) return level;
  }
  return max;
}

/**
 * The next level given the last one. Collapsing happens as soon as the row doesn't fit; expanding
 * waits until it fits with `hysteresis` px to spare, so an item at the edge doesn't flap.
 */
export function nextLevel(input: PlanInput, previous: number, hysteresis: number): number {
  const target = levelFor(input);
  if (target >= previous) return target;
  return Math.min(previous, levelFor(input, input.available - hysteresis));
}
