// Setting rows bound to a source: a switch, a select or a choice (a segmented control), each with
// its title as the control's name. A setting another plugin locked shows its value, can't be
// changed, and says who set it (the caller words that note: the kit has no copy of its own).
import { Show, type JSX } from 'solid-js';
import { useSignal, type Readable } from '../core/signal.ts';
import type { KitProps } from '../core/props.ts';
import type { IconName } from '../content/icons.ts';
import { SettingsRow } from '../composites/Section.tsx';
import { Switch } from '../controls/Switch.tsx';
import { Select, type SelectOption } from '../controls/Select.tsx';
import { Tabs } from '../controls/Tabs.tsx';

/** One setting as a row reads it: @wisp/client's TypedSettings `get(key)` / `lockedBy(key)` / `set`. */
export interface SettingSource<V> {
  readonly value: Readable<V>;
  /** The plugin that locked it, if one did. */
  readonly lockedBy?: Readable<string | undefined>;
  readonly set: (value: V) => unknown;
}

interface BoundRowProps<V> extends KitProps {
  readonly title: string;
  readonly description?: JSX.Element;
  readonly source: SettingSource<V>;
  /** The note under a locked setting: "Set by the plugin Focus · Plugins". */
  readonly locked?: (by: string) => JSX.Element;
  readonly disabled?: boolean;
  /** a mark before the title (a harness's logo: Usage's per-harness stop lines) */
  readonly logo?: string | undefined;
}

const none: Readable<undefined> = () => undefined;

function useLock<V>(p: BoundRowProps<V>): () => string | undefined {
  return useSignal(p.source.lockedBy ?? none);
}

function Description<V>(props: { readonly row: BoundRowProps<V>; readonly by: string | undefined }): JSX.Element {
  return (
    <>
      {props.row.description}
      <Show when={props.by}>
        {(by) => (
          <span data-kit="setting-locked" data-part="settings.locked">
            {props.row.locked?.(by())}
          </span>
        )}
      </Show>
    </>
  );
}

export function SwitchSetting(props: BoundRowProps<boolean>): JSX.Element {
  const value = useSignal(props.source.value);
  const by = useLock(props);
  return (
    <SettingsRow
      part={props.part ?? 'settings.row'}
      title={props.title}
      description={<Description row={props} by={by()} />}
      control={<Switch checked={value() === true} onChange={(v) => props.source.set(v)} disabled={props.disabled === true || by() !== undefined} aria-label={props.title} />}
    />
  );
}

export interface SelectSettingProps extends BoundRowProps<string> {
  readonly items: readonly SelectOption[];
  readonly mono?: boolean;
}

export function SelectSetting(props: SelectSettingProps): JSX.Element {
  const value = useSignal(props.source.value);
  const by = useLock(props);
  return (
    <SettingsRow
      part={props.part ?? 'settings.row'}
      title={props.title}
      wideControl
      description={<Description row={props} by={by()} />}
      control={
        <Select
          aria-label={props.title}
          items={props.items}
          value={value()}
          onChange={(v) => props.source.set(v)}
          disabled={props.disabled === true || by() !== undefined}
          mono={props.mono === true}
        />
      }
    />
  );
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
}

export interface ChoiceSettingProps extends BoundRowProps<string> {
  readonly items: readonly ChoiceOption[];
}

/** A few choices side by side (v1 .pk-seg): Theme, Automations stop at, Scout first. */
export function ChoiceSetting(props: ChoiceSettingProps): JSX.Element {
  const value = useSignal(props.source.value);
  const by = useLock(props);
  const locked = (): boolean => props.disabled === true || by() !== undefined;
  return (
    <SettingsRow
      part={props.part ?? 'settings.row'}
      title={props.title}
      {...(props.logo && { logo: props.logo })}
      wideControl
      description={<Description row={props} by={by()} />}
      control={
        <Tabs
          variant="seg"
          aria-label={props.title}
          value={value()}
          onChange={(v) => {
            if (!locked() && v !== value()) props.source.set(v);
          }}
          items={props.items.map((o) => ({ value: o.value, label: o.label, ...(o.icon && { icon: o.icon }), disabled: locked() && o.value !== value() }))}
        />
      }
    />
  );
}
