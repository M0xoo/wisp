import { describe, expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, part, tick } from './helpers.tsx';
import { Field } from '../src/controls/Field.tsx';
import { Input, TextArea } from '../src/controls/Input.tsx';
import { Select } from '../src/controls/Select.tsx';
import { Combobox } from '../src/controls/Combobox.tsx';
import { Checkbox, Switch } from '../src/controls/Switch.tsx';
import { RadioGroup } from '../src/controls/RadioGroup.tsx';

const key = (el: Element | null, k: string): void => {
  el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};
const type = (el: HTMLInputElement | null, text: string): void => {
  if (!el) return;
  el.value = text;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
};

const harnesses = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini CLI' },
];

describe('Input and Field', () => {
  test('a Field wires its label, hint and error to the input', () => {
    mount(() => (
      <Field label="Branch" hint="Where the work goes" error="Already taken" part="ship.branch">
        <Input value="main" mono part="ship.branch.input" />
      </Field>
    ));
    const input = part('ship.branch.input') as HTMLInputElement;
    const label = part('ship.branch.label') as HTMLLabelElement;
    expect(label.htmlFor).toBe(input.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toEqual([part('ship.branch.error')?.id, part('ship.branch.hint')?.id]);
    expect(input.getAttribute('data-mono')).toBe('');
  });

  test('onInput gets every keystroke; an icon puts the input in a box', () => {
    const onInput = vi.fn();
    mount(() => <Input icon="search" placeholder="Search" onInput={onInput} aria-label="Search" />);
    const box = part('ui.input');
    expect(box?.getAttribute('data-kit')).toBe('field-box');
    const input = box?.querySelector('input') ?? null;
    type(input, 'wisp');
    expect(onInput).toHaveBeenCalledWith('wisp');
  });
});

describe('TextArea', () => {
  // happy-dom lays nothing out: give textareas a scrollHeight of 20px per line.
  const proto = HTMLTextAreaElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: HTMLTextAreaElement) { return this.value.split('\n').length * 20; } });

  test('autosize grows with the text up to maxRows, then scrolls', async () => {
    const [text, setText] = createSignal('one');
    mount(() => <TextArea value={text()} onInput={setText} minRows={1} maxRows={3} aria-label="Prompt" />);
    const el = part('ui.textarea') as HTMLTextAreaElement;
    el.style.lineHeight = '20px';
    await tick();
    const h1 = parseFloat(el.style.height);
    setText('one\ntwo\nthree');
    await tick();
    const h3 = parseFloat(el.style.height);
    expect(h3).toBeGreaterThan(h1);
    setText('1\n2\n3\n4\n5\n6');
    await tick();
    expect(parseFloat(el.style.height)).toBe(h3);
    expect(el.style.overflowY).toBe('auto');
    if (original) Object.defineProperty(proto, 'scrollHeight', original);
  });
});

describe('Select', () => {
  test('renders the picked label and picks with the keyboard', async () => {
    const [value, setValue] = createSignal<string | undefined>('claude');
    mount(() => <Select items={harnesses} value={value()} onChange={setValue} aria-label="Harness" />);
    const trigger = part('ui.select.trigger');
    expect(trigger?.textContent).toContain('Claude Code');
    trigger?.focus();
    key(trigger, 'ArrowDown');
    await tick(30);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[data-part="ui.select.option"]').length).toBe(3);
    const list = part('ui.select.list');
    key(list, 'ArrowDown');
    await tick(10);
    key(list, 'Enter');
    await tick(30);
    expect(value()).toBe('codex');
  });

  test('shows the placeholder when nothing is picked', () => {
    mount(() => <Select items={harnesses} value={undefined} onChange={() => {}} placeholder="Pick a harness" aria-label="Harness" />);
    expect(part('ui.select.trigger')?.getAttribute('data-placeholder')).toBe('');
    expect(part('ui.select.trigger')?.textContent).toContain('Pick a harness');
  });
});

describe('Combobox', () => {
  test('typing filters, ArrowDown highlights, Enter selects', async () => {
    const onChange = vi.fn();
    mount(() => <Combobox items={harnesses} value={undefined} onChange={onChange} emptyText="No match" aria-label="Harness" />);
    const input = part('ui.combobox.input') as HTMLInputElement;
    input.focus();
    type(input, 'co');
    await tick(30);
    const shown = () => [...document.querySelectorAll('[data-part="ui.combobox.option"]')].map((o) => o.textContent);
    expect(shown()).toEqual(['Claude Code', 'Codex']);
    key(input, 'ArrowDown');
    await tick(30);
    expect(document.querySelector('[data-part="ui.combobox.option"][data-highlighted]')).not.toBeNull();
    const highlighted = document.querySelector('[data-part="ui.combobox.option"][data-highlighted]')?.textContent;
    key(input, 'Enter');
    await tick(30);
    expect(onChange).toHaveBeenCalledWith(harnesses.find((h) => h.label === highlighted)?.value);
  });

  test('nothing matches: the caller\'s empty text shows', async () => {
    mount(() => <Combobox items={harnesses} value={undefined} onChange={() => {}} emptyText="No match" aria-label="Harness" />);
    const input = part('ui.combobox.input') as HTMLInputElement;
    input.focus();
    type(input, 'zzz');
    await tick(30);
    expect(document.querySelector('[data-kit="listbox-empty"]')?.textContent).toBe('No match');
  });
});

describe('Switch, Checkbox, RadioGroup', () => {
  test('a switch toggles on click and reports it', async () => {
    const [on, setOn] = createSignal(false);
    mount(() => <Switch checked={on()} onChange={setOn} label="Sounds" part="settings.sounds" />);
    expect(part('settings.sounds.control')?.getAttribute('data-state')).toBe('unchecked');
    (part('settings.sounds') as HTMLElement).click();
    await tick(10);
    expect(on()).toBe(true);
    expect(part('settings.sounds.control')?.getAttribute('data-state')).toBe('checked');
  });

  test('a checkbox shows indeterminate and becomes checked', async () => {
    const onChange = vi.fn();
    mount(() => <Checkbox checked="indeterminate" onChange={onChange} label="All" />);
    expect(part('ui.checkbox.control')?.getAttribute('data-state')).toBe('indeterminate');
    (part('ui.checkbox') as HTMLElement).click();
    await tick(10);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('a radio group is a fieldset of native radios sharing a name', () => {
    const onChange = vi.fn();
    mount(() => (
      <RadioGroup label="Theme" value="dark" onChange={onChange} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
    ));
    const radios = [...document.querySelectorAll<HTMLInputElement>('[data-part="ui.radio-group.option"] input')];
    expect(part('ui.radio-group')?.tagName).toBe('FIELDSET');
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    radios[0]?.click();
    expect(onChange).toHaveBeenCalledWith('light');
  });
});
