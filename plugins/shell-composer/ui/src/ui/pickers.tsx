// The bar's pickers as kit Toolbar items: each has an icon, a label and a priority, and draws the
// form the Toolbar gives it (icon and label, or the icon alone with its label in the tooltip). In
// More, choosing one does the next thing (the next mode) or opens it as a dialog.
//
// Items are made once per box and read their state through getters: the Toolbar keys items by id,
// and a new object for the same id would draw its menu again (Zag rebuilds it and it closes).
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import { Button, Dialog, Input, Menu, Stack, Text, type IconName, type MenuEntry, type ToolbarItem } from '@wisp/ui';
import type { Env } from '../env.ts';
import { nextMode } from '../model/launch.ts';
import { aheadLabel, laterPresets, parseTime } from '../model/when.ts';
import { MODES, type Mode } from '../types.ts';

export const MODE_ICON: Readonly<Record<Mode, IconName>> = { plan: 'plan', edits: 'pen', auto: 'bolt' };
const K = 'shell-composer';

/** A bar item whose label, icon and state follow signals while the object stays the same. */
export function liveItem(o: {
  readonly id: string;
  readonly priority: number | 'pin';
  readonly label: () => string;
  readonly icon: () => IconName;
  readonly pressed?: () => boolean | undefined;
  readonly disabled?: () => boolean | undefined;
  readonly variant?: () => 'ghost' | 'secondary' | 'primary';
  readonly onSelect: () => void;
  readonly render?: (form: 'full' | 'icon') => JSX.Element;
}): ToolbarItem {
  const item = {
    id: o.id,
    priority: o.priority,
    onSelect: o.onSelect,
    get label() {
      return o.label();
    },
    get icon() {
      return o.icon();
    },
    get pressed() {
      return o.pressed?.();
    },
    get disabled() {
      return o.disabled?.();
    },
    get variant() {
      return o.variant?.() ?? 'ghost';
    },
    ...(o.render && { render: o.render }),
  };
  return item as ToolbarItem;
}

/** Plan / Edits / Full auto. Shift+Tab in the box cycles it too. */
export function modeItem(o: {
  readonly env: Env;
  readonly mode: () => Mode;
  /** this follow-up switches the task from `from` */
  readonly from?: () => Mode | undefined;
  readonly priority: number;
  readonly onPick: (m: Mode) => void;
}): ToolbarItem {
  const t = o.env.t;
  const label = (): string => t(`${K}.mode.${o.mode()}`);
  const changed = (): boolean => o.from?.() !== undefined && o.from?.() !== o.mode();
  const title = (): string => {
    const from = o.from?.();
    return changed() && from ? t(`${K}.mode.title-changed`, { label: label(), from: t(`${K}.mode.${from}`) }) : t(`${K}.mode.title`, { label: label() });
  };
  const items = (): MenuEntry[] => MODES.map((m) => ({ value: m, label: t(`${K}.mode.${m}`), hint: t(`${K}.mode.${m}.hint`), icon: MODE_ICON[m], ...(m === o.mode() && { checked: true }) }));
  const variant = (): 'ghost' | 'secondary' => (changed() ? 'secondary' : 'ghost');
  return liveItem({
    id: 'mode',
    priority: o.priority,
    label,
    icon: () => MODE_ICON[o.mode()],
    onSelect: () => o.onPick(nextMode(o.mode())),
    render: (form) => (
      <Menu
        part="composer.mode"
        items={items()}
        onSelect={(v) => o.onPick(v as Mode)}
        placement="top-start"
        trigger={form === 'full' ? { label: label(), icon: MODE_ICON[o.mode()], size: 'sm', variant: variant() } : { icon: MODE_ICON[o.mode()], 'aria-label': title(), size: 'sm', variant: variant() }}
      />
    ),
  });
}

/** Start later (New task) / Send later (a task): presets, or a time typed in words. */
export function laterItem(o: {
  readonly env: Env;
  readonly kind: 'start' | 'send';
  readonly priority: number;
  readonly onPick: (at: number) => void;
  /** a time already set: the clock shows it's on */
  readonly armed?: () => number | undefined;
}): { item: ToolbarItem; dialog: () => JSX.Element } {
  const t = o.env.t;
  const [asking, setAsking] = createSignal(false);
  const label = (): string => (o.armed?.() !== undefined ? t(`${K}.later.change`) : t(`${K}.later.${o.kind}`));
  const entries = (): MenuEntry[] => {
    const now = new Date();
    return [
      ...laterPresets(now).map((p) => ({ value: String(p.at), label: t(`${K}.later.${p.id}`), hint: aheadLabel(p.at, now), icon: 'clock' as const })),
      { kind: 'separator' as const },
      { value: 'pick', label: t(`${K}.later.pick`), icon: 'pen' as const },
    ];
  };
  const pick = (v: string): void => {
    if (v === 'pick') setAsking(true);
    else o.onPick(Number(v));
  };
  return {
    item: liveItem({
      id: 'later',
      priority: o.priority,
      label,
      icon: () => 'clock',
      pressed: () => (o.armed?.() !== undefined ? true : undefined),
      onSelect: () => setAsking(true),
      render: (form) => (
        <Menu part="composer.later" items={entries()} onSelect={pick} placement="top-end" trigger={form === 'full' ? { label: label(), icon: 'clock', size: 'sm' } : { icon: 'clock', 'aria-label': label(), size: 'sm' }} />
      ),
    }),
    dialog: () => <TimeDialog env={o.env} open={asking()} onClose={() => setAsking(false)} onPick={(at) => {
          setAsking(false);
          o.onPick(at);
        }} />,
  };
}

/** "Pick a time…": tomorrow 10, Fri 9, 14:30, in 2 h. Enter takes it once it reads as a time. */
function TimeDialog(p: { readonly env: Env; readonly open: boolean; readonly onClose: () => void; readonly onPick: (at: number) => void }): JSX.Element {
  const t = p.env.t;
  const [text, setText] = createSignal('');
  const at = createMemo(() => parseTime(text(), new Date()));
  const take = (): void => {
    const v = at();
    if (v !== null) p.onPick(v);
  };
  return (
    <Dialog
      open={p.open}
      onOpenChange={(open) => !open && p.onClose()}
      title={t(`${K}.later.pick-title`)}
      size="sm"
      footer={
        <Button variant="primary" disabled={at() === null} onClick={take}>
          {t(`${K}.later.take`)}
        </Button>
      }
    >
      <Stack gap="3">
        <Input value={text()} onInput={setText} placeholder={t(`${K}.later.field`)} autofocus onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            take();
          }} />
        <Text size="sm" tone="muted">
          <Show when={at()} fallback={t(`${K}.later.not-yet`)}>
            {(v) => t(`${K}.later.at`, { time: aheadLabel(v(), new Date()) })}
          </Show>
        </Text>
      </Stack>
    </Dialog>
  );
}
