// The time menu (Send later, Start later, Change time…, Snooze…), v1 later.js timeMenu: one row per
// choice with the time it means in the time column, then Pick a time…, which turns into a field in
// its own row (the menu keeps its size and place). Its time shows where the others do, Enter takes
// it, Escape goes back to the row.

import { createSignal, For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { Inline, Input, Kbd, ListRow, Popover, Stack, Text, type MenuTrigger, type PartName, type Placement } from '@wisp/ui';
import { aheadLabel, timeChoices, whenTip } from '../format.ts';
import { t } from '../i18n.ts';
import { nowOf } from '../host.ts';
import { parseTime } from '../when.ts';

export interface TimeMenuProps {
  readonly client: PluginClient;
  readonly trigger: MenuTrigger;
  readonly onPick: (at: number) => void;
  readonly placement?: Placement;
  readonly part?: PartName;
  /** rows instead of the usual ones */
  readonly choices?: readonly [string, number][];
}

/** What the Pick a time… field means now, or null (empty, unreadable, or under a minute away). */
export function pickedTime(text: string, now: number): number | null {
  const at = parseTime(text, new Date(now));
  return at !== null && at >= now + 60_000 ? at : null;
}

function PickRow(props: { readonly now: number; readonly onPick: (at: number) => void; readonly onBack: () => void }): JSX.Element {
  const [text, setText] = createSignal('');
  const at = (): number | null => pickedTime(text(), props.now);
  return (
    <Inline gap="2" part="later.menu.pick">
      <Input
        value={text()}
        onInput={setText}
        placeholder={t('wisp.later.time.placeholder')}
        aria-label={t('wisp.later.time.when')}
        autocomplete="off"
        spellcheck={false}
        autofocus
        size="sm"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onBack();
          }
          const chosen = at();
          if (e.key === 'Enter' && chosen !== null) {
            e.preventDefault();
            props.onPick(chosen);
          }
        }}
      />
      <Show when={at()} fallback={<Show when={text().trim()}><Text tone="faint" size="sm" nowrap>{t('wisp.later.time.notYet')}</Text></Show>}>
        {(chosen) => (
          <Inline gap="1">
            <Text size="sm" numeric nowrap title={whenTip(chosen(), props.now)}>{aheadLabel(chosen(), props.now)}</Text>
            <Kbd keys={['↵']} />
          </Inline>
        )}
      </Show>
    </Inline>
  );
}

export function TimeMenu(props: TimeMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  const [now, setNow] = createSignal(nowOf(props.client));
  const choices = (): readonly [string, number][] => props.choices ?? timeChoices(now());
  const pick = (at: number): void => {
    setOpen(false);
    setPicking(false);
    props.onPick(at);
  };
  return (
    <Popover
      trigger={props.trigger}
      placement={props.placement ?? 'top-end'}
      part={props.part ?? 'later.menu'}
      open={open()}
      onOpenChange={(o) => {
        if (o) setNow(nowOf(props.client));
        else setPicking(false);
        setOpen(o);
      }}
    >
      <Stack gap="0" part="later.menu.list" role="menu">
        <For each={choices()}>
          {([label, at]) => <ListRow part="later.menu.item" title={label} time={<Text size="sm" numeric title={whenTip(at, now())}>{aheadLabel(at, now())}</Text>} onOpen={() => pick(at)} />}
        </For>
        <Show when={picking()} fallback={<ListRow part="later.menu.item" title={t('wisp.later.time.pick')} onOpen={() => setPicking(true)} />}>
          <PickRow now={now()} onPick={pick} onBack={() => setPicking(false)} />
        </Show>
      </Stack>
    </Popover>
  );
}
