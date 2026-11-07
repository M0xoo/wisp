// Every control in every state: buttons, fields, toggles, menus, overlays, tabs, toasts, split.
import { createSignal, For, type JSX } from 'solid-js';
import { Area, Specimen, State } from '../frame.tsx';
import {
  Button, Checkbox, Combobox, ContextMenu, createToaster, Dialog, Field, Grid, IconButton, Input, Menu, Popover,
  RadioGroup, Select, Sheet, Split, Stack, Switch, Tabs, Text, TextArea, Toasts, Tooltip, type ButtonVariant, type MenuEntry,
} from '../../src/index.ts';

const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
const HARNESSES = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'opencode', label: 'OpenCode', disabled: true },
];
const MORE: readonly MenuEntry[] = [
  { value: 'rerun', label: 'Rerun…', icon: 'rerun', keys: 'R' },
  { value: 'done', label: 'Mark done', icon: 'check', keys: 'E', checked: true },
  { value: 'later', label: 'Save for later', icon: 'bookmark', hint: 'Keep it in For later' },
  { kind: 'separator' },
  { value: 'archive', label: 'Archive', icon: 'archive', disabled: true },
  { value: 'delete', label: 'Delete task', icon: 'trash', danger: true },
];

function Buttons(): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  return (
    <Specimen title="Button" note="Loading keeps the width: the label stays in place, hidden, under the ring.">
      <For each={VARIANTS}>
        {(variant) => (
          <State label={variant}>
            <Button variant={variant} size="xs">Extra small</Button>
            <Button variant={variant} size="sm">Small</Button>
            <Button variant={variant}>Medium</Button>
            <Button variant={variant} size="lg">Large</Button>
            <Button variant={variant} icon="send">With icon</Button>
            <Button variant={variant} disabled>Disabled</Button>
            <Button variant={variant} loading>Loading</Button>
          </State>
        )}
      </For>
      <State label="tone, shortcut, pressed, end icon">
        <Button variant="ghost" tone="good" icon="check">Mark done</Button>
        <Button variant="ghost" tone="bad" icon="trash">Delete</Button>
        <Button variant="primary" kbd="⌘↵">Send</Button>
        <Button pressed>Transcript</Button>
        <Button iconEnd="chevron">Harness</Button>
      </State>
      <State label="click to toggle loading: nothing moves">
        <Button variant="primary" loading={busy()} onClick={() => setBusy(true)}>Ship it</Button>
        <Button variant="ghost" onClick={() => setBusy(false)}>Reset</Button>
      </State>
    </Specimen>
  );
}

function IconButtons(): JSX.Element {
  return (
    <Specimen title="IconButton">
      <State label="ghost · secondary · primary · sizes · states">
        <IconButton icon="settings" label="Settings" />
        <IconButton icon="search" label="Search" variant="secondary" />
        <IconButton icon="plus" label="New task" variant="primary" />
        <IconButton icon="x" label="Close" size="xs" />
        <IconButton icon="dots" label="More" size="sm" />
        <IconButton icon="split" label="Split view" size="lg" />
        <IconButton icon="eye" label="Watch" pressed />
        <IconButton icon="trash" label="Delete" tone="bad" />
        <IconButton icon="stop" label="Stop" disabled />
        <IconButton icon="rerun" label="Rerun" loading />
        <Tooltip content="Archive" hint="Moves it out of the list">
          <IconButton icon="archive" label="Archive" />
        </Tooltip>
      </State>
    </Specimen>
  );
}

function Menus(): JSX.Element {
  const [picked, setPicked] = createSignal('nothing yet');
  return (
    <Specimen title="Menu and ContextMenu" note="Arrow keys, typeahead, Escape back to the button.">
      <State label={`picked: ${picked()}`}>
        <Menu items={MORE} onSelect={setPicked} trigger={{ icon: 'dots', 'aria-label': 'More' }} />
        <Menu items={MORE} onSelect={setPicked} trigger={{ label: 'More', icon: 'menu' }} placement="bottom-end" />
        <ContextMenu items={MORE} onSelect={setPicked}>
          <Text tone="muted" size="sm">Right-click this line</Text>
        </ContextMenu>
      </State>
    </Specimen>
  );
}

function Fields(): JSX.Element {
  const [text, setText] = createSignal('');
  const [prompt, setPrompt] = createSignal('Grow me: press Enter a few times');
  return (
    <Specimen title="Input, TextArea, Field">
      <Grid min="dialog-sm" gap="7">
        <Stack gap="4">
          <Input size="sm" placeholder="Small" aria-label="Small" />
          <Input placeholder="Medium" value={text()} onInput={setText} aria-label="Medium" />
          <Input size="lg" placeholder="Large" aria-label="Large" />
          <Input icon="search" placeholder="With an icon" aria-label="Search" />
          <Input prefix="https://" placeholder="example.com" aria-label="Address" />
          <Input mono value="0 9 * * 1-5" aria-label="Cron" />
          <Input disabled value="Disabled" aria-label="Disabled" />
        </Stack>
        <Stack gap="6">
          <Field label="Branch" hint="Where this task's work goes">
            <Input mono value="wisp/kit-gallery" />
          </Field>
          <Field label="Name" error="A recipe with that name already exists" required requiredMark="*">
            <Input value="Daily triage" />
          </Field>
          <Field label="Prompt" hint="Autosize: 2 to 6 rows">
            <TextArea value={prompt()} onInput={setPrompt} minRows={2} maxRows={6} />
          </Field>
        </Stack>
      </Grid>
    </Specimen>
  );
}

function Pickers(): JSX.Element {
  const [harness, setHarness] = createSignal<string | undefined>('claude');
  const [combo, setCombo] = createSignal<string | undefined>(undefined);
  return (
    <Specimen title="Select and Combobox">
      <Grid min="dialog-sm" gap="7">
        <Field label="Harness" hint={`Picked: ${harness() ?? 'none'}`}>
          <Select items={HARNESSES} value={harness()} onChange={setHarness} />
        </Field>
        <Field label="Harness (type to filter)">
          <Combobox items={HARNESSES} value={combo()} onChange={setCombo} placeholder="Search harnesses" emptyText="No harness matches" />
        </Field>
        <Field label="Placeholder, small">
          <Select items={HARNESSES} value={undefined} onChange={() => {}} placeholder="Pick one" size="sm" />
        </Field>
        <Field label="Invalid" error="Pick a harness to continue">
          <Select items={HARNESSES} value={undefined} onChange={() => {}} placeholder="Pick one" />
        </Field>
      </Grid>
    </Specimen>
  );
}

function Toggles(): JSX.Element {
  const [on, setOn] = createSignal(true);
  const [checks, setChecks] = createSignal<Record<string, boolean>>({ a: true, b: false });
  const all = (): boolean | 'indeterminate' => {
    const v = Object.values(checks());
    return v.every(Boolean) ? true : v.some(Boolean) ? 'indeterminate' : false;
  };
  const [theme, setTheme] = createSignal('system');
  return (
    <Specimen title="Switch, Checkbox, RadioGroup">
      <State label="switch">
        <Switch checked={on()} onChange={setOn} label="Sounds" />
        <Switch checked={false} onChange={() => {}} label="Off" />
        <Switch checked onChange={() => {}} label="Disabled on" disabled />
        <Switch checked={false} onChange={() => {}} aria-label="No visible label" />
      </State>
      <State label="checkbox">
        <Checkbox checked={all()} onChange={(c) => setChecks({ a: c, b: c })} label="All (indeterminate when mixed)" />
        <Checkbox checked={checks()['a'] ?? false} onChange={(c) => setChecks({ ...checks(), a: c })} label="Changes" />
        <Checkbox checked={checks()['b'] ?? false} onChange={(c) => setChecks({ ...checks(), b: c })} label="PR" />
        <Checkbox checked={false} onChange={() => {}} label="Invalid" invalid />
        <Checkbox checked onChange={() => {}} label="Disabled" disabled />
      </State>
      <Grid min="dialog-sm" gap="7">
        <RadioGroup
          label="Theme"
          value={theme()}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System', hint: 'Follows the computer' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'sepia', label: 'Sepia', disabled: true },
          ]}
        />
        <RadioGroup label="Layout" orientation="horizontal" value="split" onChange={() => {}} options={[{ value: 'split', label: 'Side by side' }, { value: 'stack', label: 'Stacked' }]} />
      </Grid>
    </Specimen>
  );
}

function Overlays(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <Specimen title="Popover, Dialog, Sheet" note="Escape closes the newest and puts focus back on its button.">
      <State label="open on click">
        <Popover trigger={{ label: 'Popover', icon: 'info' }} title="Cache gone cold" vars={{ '--popover-w': '320px' }}>
          <Text size="md" tone="ink-2">The next reply rebuilds the prompt cache, so it costs more than usual.</Text>
        </Popover>
        <Dialog
          trigger={{ label: 'Dialog' }}
          title="Delete recipe"
          description="Daily triage"
          size="sm"
          role="alertdialog"
          footer={<><Button variant="ghost" size="sm">Cancel</Button><Button variant="danger" size="sm">Delete recipe</Button></>}
        >
          <Text as="p" tone="ink-2">This can't be undone. Tasks it started keep running.</Text>
        </Dialog>
        <Button onClick={() => setOpen(true)}>Controlled dialog</Button>
        <Dialog open={open()} onOpenChange={setOpen} title="Settings" size="md" footer={<Button variant="primary" size="sm" onClick={() => setOpen(false)}>Done</Button>}>
          <Stack gap="6">
            <Field label="Name"><Input value="Studio" /></Field>
            <Switch checked onChange={() => {}} label="Start with the computer" />
          </Stack>
        </Dialog>
        <Sheet trigger={{ label: 'Sheet' }} title="Pick a model" footer={<Button variant="primary" size="sm" fill>Use Opus</Button>}>
          <Text tone="ink-2">On a phone this rises from the bottom with a grab handle; wider, it's a card.</Text>
        </Sheet>
      </State>
    </Specimen>
  );
}

function TabsSpecimen(): JSX.Element {
  const panel = (text: string): JSX.Element => <Text tone="ink-2" size="md">{text}</Text>;
  const items = [
    { value: 'changes', label: 'Changes', icon: 'branch' as const, count: 12, content: panel('12 files changed') },
    { value: 'pr', label: 'PR', icon: 'merge' as const, content: panel('#128 is open') },
    { value: 'shell', label: 'Shell', icon: 'terminal' as const, content: panel('zsh in the task folder') },
    { value: 'off', label: 'Disabled', disabled: true, content: panel('never') },
  ];
  return (
    <Specimen title="Tabs" note="Arrow keys, Home and End; panels stay mounted.">
      <Tabs items={items} aria-label="Side panel" />
      <Tabs items={items.slice(0, 3)} variant="pill" aria-label="Segments" />
      <Tabs items={items.slice(0, 3)} variant="pill" fill aria-label="Phone segments" />
    </Specimen>
  );
}

function ToastSpecimen(): JSX.Element {
  const toaster = createToaster();
  const [n, setN] = createSignal(0);
  return (
    <Specimen title="Toast" note="The same text twice shows once; three at most; hover fans the stack and holds the timers.">
      <State label="show">
        <Button onClick={() => toaster.success('Marked done')}>Show toast</Button>
        <Button onClick={() => toaster.show('Archived', { action: { label: 'Undo', onClick: () => toaster.show('Unarchived') } })}>With Undo</Button>
        <Button variant="danger" onClick={() => toaster.error('Still working — stop it first or let it finish.', { action: { label: 'Undo', onClick: () => {} } })}>
          Error with Undo
        </Button>
        <Button
          onClick={() => {
            setN(n() + 1);
            toaster.show(`Brought in ${n()} worktrees`, { description: 'From Cursor and Codex' });
          }}
        >
          Another one
        </Button>
        <Button variant="ghost" onClick={() => toaster.clear()}>Clear all</Button>
      </State>
      <Toasts toaster={toaster} />
    </Specimen>
  );
}

function SplitSpecimen(): JSX.Element {
  const [width, setWidth] = createSignal(32);
  const pane = (title: string, body: string): JSX.Element => (
    <Stack gap="2" pad="6">
      <Text weight="semibold">{title}</Text>
      <Text tone="muted" size="sm">{body}</Text>
    </Stack>
  );
  return (
    <Specimen title="Split and Splitter" note={`Drag the line or focus it and use the arrow keys. Start panel: ${Math.round(width())}%`}>
      <Split start={pane('Tasks', 'The list')} end={pane('Open task', 'What you are reading')} startLabel="Tasks" onResizeEnd={setWidth} />
      <State label="stacked (under SPLIT_MIN_WIDTH)">
        <Split stacked start={pane('Tasks', 'The list')} end={pane('Open task', 'A page over it, with Back')} />
      </State>
    </Specimen>
  );
}

export function ControlsGallery(): JSX.Element {
  return (
    <Area id="controls" title="Controls">
      <Buttons />
      <IconButtons />
      <Menus />
      <Fields />
      <Pickers />
      <Toggles />
      <Overlays />
      <TabsSpecimen />
      <ToastSpecimen />
      <SplitSpecimen />
    </Area>
  );
}
