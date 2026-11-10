// Review what the harnesses' own configs have (v1's import review): each found server with where it is and
// what it runs, ticked by default; Add takes the ticked ones, values and all.
import { createEffect, createSignal, For, type JSX } from 'solid-js';
import { Button, Checkbox, Dialog, Inline, SettingsRow, Stack, Text } from '@wisp/ui';
import { t } from '../i18n.ts';
import { foundLine } from '../lib.ts';
import type { FoundServer } from '../types.ts';

export interface ReviewProps {
  readonly open: boolean;
  readonly found: readonly FoundServer[];
  readonly onImport: (names: string[]) => void;
  readonly onClose: () => void;
}

export function Review(props: ReviewProps): JSX.Element {
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(() => {
    if (props.open) setPicked(new Set(props.found.map((f) => f.name)));
  });
  const flip = (n: string, on: boolean): void => {
    const s = new Set(picked());
    if (on) s.add(n);
    else s.delete(n);
    setPicked(s);
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title={t('connectors.review.title')}
      description={t('connectors.review.description')}
      part="connectors.review"
      footer={
        <Inline gap="3" justify="end">
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            {t('connectors.cancel')}
          </Button>
          <Button variant="primary" size="sm" part="connectors.review.add" disabled={picked().size === 0} onClick={() => props.onImport([...picked()])}>
            {t('connectors.review.add', { count: picked().size })}
          </Button>
        </Inline>
      }
    >
      <Stack gap="1">
        <For each={props.found}>
          {(f) => (
            <SettingsRow
              part="connectors.review.row"
              title={f.name}
              description={
                <Text tone="muted" truncate>
                  {`${foundLine(f)} · ${f.from.join(', ')}`}
                </Text>
              }
              control={<Checkbox aria-label={f.name} checked={picked().has(f.name)} onChange={(on) => flip(f.name, on === true)} />}
            />
          )}
        </For>
      </Stack>
    </Dialog>
  );
}
