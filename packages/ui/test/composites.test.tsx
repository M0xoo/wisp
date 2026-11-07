import { describe, expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { mount, part } from './helpers.tsx';
import {
  Banner, Callout, Card, Checklist, Composer, EmptyState, ListRow, Section, SettingsRow, Stats, Steps, Toolbar, nextInToolbar, sendsOn,
} from '../src/composites/index.ts';

const key = (k: string, extra: Partial<KeyboardEventInit> = {}): KeyboardEvent => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });

describe('every composite renders its data-part (default and given)', () => {
  test('defaults', () => {
    mount(() => (
      <>
        <ListRow title="Fix the login" />
        <Card>Body</Card>
        <Toolbar aria-label="Task actions"><button type="button">A</button></Toolbar>
        <Composer value="" onInput={() => {}} onSend={() => {}} placeholder="Reply…" />
        <EmptyState title="No machines yet" />
        <Banner>Reconnecting to wisp…</Banner>
        <Callout title="Heads up">Text</Callout>
        <Stats items={[{ label: 'tests passing', value: 42 }]} />
        <Steps items={[{ title: 'Build', status: 'done' }]} />
        <Checklist items={[{ text: 'Merged', done: true }]} />
        <Section title="Theme">Rows</Section>
        <SettingsRow title="Theme" control={<span />} />
      </>
    ));
    for (const name of [
      'ui.list-row', 'ui.card', 'ui.toolbar', 'ui.composer', 'ui.empty-state', 'ui.banner', 'ui.callout',
      'ui.stats', 'ui.steps', 'ui.checklist', 'ui.section', 'ui.settings-row',
    ]) {
      expect(part(name), name).not.toBeNull();
    }
    expect(part('ui.composer.send')).not.toBeNull();
    expect(part('ui.list-row.time')).not.toBeNull();
  });

  test('a given part replaces the default, and inner parts follow it', () => {
    mount(() => <ListRow part="list.row" title="A task" />);
    expect(part('list.row')).not.toBeNull();
    expect(part('list.row.title')?.textContent).toBe('A task');
    expect(part('ui.list-row')).toBeNull();
  });
});

describe('ListRow', () => {
  const view = (selected: () => boolean) => (
    <ListRow title="Refactor auth" sub="wisp · main" lead={<span>•</span>} pills={<span>Working</span>} time={<span>28m ago</span>} actions={<button type="button">⋯</button>} selected={selected()} onOpen={() => {}} />
  );

  test('selecting adds and removes no elements and keeps the column order', () => {
    const [sel, setSel] = createSignal(false);
    const host = mount(() => view(sel));
    const shape = (): string[] => [...host.querySelectorAll('[data-kit]')].map((n) => n.getAttribute('data-kit') ?? '');
    const before = shape();
    const timeNode = part('ui.list-row.time');
    setSel(true);
    expect(shape()).toEqual(before);
    expect(part('ui.list-row')?.getAttribute('aria-selected')).toBe('true');
    // Same nodes, not re-created ones: nothing replays an entry animation.
    expect(part('ui.list-row.time')).toBe(timeNode);
    expect(before.slice(0, 6)).toEqual(['list-row', 'list-row-lead', 'list-row-main', 'list-row-hit', 'list-row-title', 'list-row-sub']);
  });

  test('every cell is rendered even when empty, so columns never shift', () => {
    mount(() => <ListRow title="Bare" />);
    for (const cell of ['lead', 'main', 'pills', 'time', 'actions']) expect(part(`ui.list-row.${cell}`), cell).not.toBeNull();
  });

  test('the title carries its full text for hover, and opens the row', () => {
    const onOpen = vi.fn();
    mount(() => <ListRow title="A very long task title that will be cut" onOpen={onOpen} current />);
    const title = part('ui.list-row.title');
    expect(title?.getAttribute('title')).toBe('A very long task title that will be cut');
    const hit = title?.closest('button');
    expect(hit?.getAttribute('aria-current')).toBe('page');
    hit?.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test('href renders a real link', () => {
    mount(() => <ListRow title="Docs" href="/docs" />);
    expect(part('ui.list-row.title')?.closest('a')?.getAttribute('href')).toBe('/docs');
  });
});

describe('Composer', () => {
  function setup(submit?: 'enter' | 'mod-enter') {
    const onSend = vi.fn();
    const [value, setValue] = createSignal('Ship it');
    mount(() => <Composer value={value()} onInput={setValue} onSend={onSend} {...(submit ? { submit } : {})} />);
    const box = part('ui.composer.input');
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('no textarea');
    return { onSend, box, setValue };
  }

  test('Enter sends the text; Shift+Enter does not', () => {
    const { onSend, box } = setup();
    box.dispatchEvent(key('Enter', { shiftKey: true }));
    expect(onSend).not.toHaveBeenCalled();
    const enter = key('Enter');
    box.dispatchEvent(enter);
    expect(onSend).toHaveBeenCalledWith('Ship it');
    expect(enter.defaultPrevented).toBe(true);
  });

  test('mod-enter mode: Enter is a new line, ⌘/Ctrl+Enter sends', () => {
    const { onSend, box } = setup('mod-enter');
    box.dispatchEvent(key('Enter'));
    expect(onSend).not.toHaveBeenCalled();
    box.dispatchEvent(key('Enter', { metaKey: true }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  test('blank text and busy do not send; Send is disabled while blank', () => {
    const { onSend, box, setValue } = setup();
    setValue('   ');
    box.dispatchEvent(key('Enter'));
    expect(onSend).not.toHaveBeenCalled();
    expect(part('ui.composer.send')?.hasAttribute('disabled')).toBe(true);
  });

  test('an IME confirming a word with Enter is not a send', () => {
    expect(sendsOn({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: true }, 'enter')).toBe(false);
    expect(sendsOn({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false }, 'enter')).toBe(true);
  });

  test("Send's name comes from the kit's strings unless given", () => {
    mount(() => <Composer value="x" onInput={() => {}} onSend={() => {}} sendLabel="Reply" part="task.reply" />);
    expect(part('task.reply.send')?.getAttribute('aria-label')).toBe('Reply');
  });
});

describe('Toolbar', () => {
  test('arrow keys, Home and End move focus between its controls, wrapping', () => {
    mount(() => (
      <Toolbar aria-label="Task actions">
        <button type="button" data-n="a">A</button>
        <button type="button" data-n="b">B</button>
        <button type="button" data-n="c" disabled>C</button>
        <button type="button" data-n="d">D</button>
      </Toolbar>
    ));
    const btn = (n: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-n="${n}"]`);
    btn('a')?.focus();
    btn('a')?.dispatchEvent(key('ArrowRight'));
    expect(document.activeElement).toBe(btn('b'));
    btn('b')?.dispatchEvent(key('ArrowRight'));
    expect(document.activeElement).toBe(btn('d')); // the disabled one is skipped
    btn('d')?.dispatchEvent(key('ArrowRight'));
    expect(document.activeElement).toBe(btn('a'));
    btn('a')?.dispatchEvent(key('ArrowLeft'));
    expect(document.activeElement).toBe(btn('d'));
    btn('d')?.dispatchEvent(key('Home'));
    expect(document.activeElement).toBe(btn('a'));
    expect(part('ui.toolbar')?.getAttribute('role')).toBe('toolbar');
  });

  test('nextInToolbar ignores other keys and empty bars', () => {
    expect(nextInToolbar([], 0, 'ArrowRight')).toBeUndefined();
    const a = document.createElement('button');
    expect(nextInToolbar([a], 0, 'x')).toBeUndefined();
  });
});

describe('the rest', () => {
  test('Banner: errors are alerts, others status; dismiss has a name', () => {
    const onDismiss = vi.fn();
    mount(() => (
      <>
        <Banner tone="bad" part="a.bad">Failed</Banner>
        <Banner tone="info" part="a.info" onDismiss={onDismiss}>Update ready</Banner>
      </>
    ));
    expect(part('a.bad')?.getAttribute('role')).toBe('alert');
    expect(part('a.info')?.getAttribute('role')).toBe('status');
    const x = part('a.info.dismiss');
    expect(x?.getAttribute('aria-label')).toBe('Dismiss');
    x?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test('Stats formats numbers and shows unit and delta', () => {
    mount(() => <Stats items={[{ label: 'tests', value: 1234, unit: 'ms', delta: '+6', tone: 'good' }]} format={(n) => `#${n}`} />);
    const stat = part('ui.stats.item');
    expect(stat?.getAttribute('data-tone')).toBe('good');
    expect(stat?.textContent).toContain('#1234');
    expect(stat?.textContent).toContain('+6');
  });

  test('Steps marks the current step; Checklist keeps undone items', () => {
    mount(() => (
      <>
        <Steps items={[{ title: 'a', status: 'done' }, { title: 'b', status: 'current' }, { title: 'c', status: 'skipped' }]} />
        <Checklist items={[{ text: 'Merged', done: true }, { text: 'Published', done: false }]} statusLabel={(d) => (d ? 'Done' : 'Not done')} />
      </>
    ));
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe('b');
    expect(document.querySelectorAll('[data-part="ui.checklist.item"]').length).toBe(2);
    expect(document.querySelector('[data-kit="check-box"]')?.getAttribute('aria-label')).toBe('Done');
  });

  test('SettingsRow labels its control; Section names itself by its heading', () => {
    mount(() => (
      <Section title="Appearance">
        <SettingsRow title="Theme" controlId="theme" control={<select id="theme" />} />
      </Section>
    ));
    expect(document.querySelector('label[for="theme"]')?.textContent).toBe('Theme');
    const section = part('ui.section');
    const labelledBy = section?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelledBy)?.textContent).toBe('Appearance');
  });

  test('Card with onClick is a button', () => {
    const onClick = vi.fn();
    mount(() => <Card onClick={onClick} header="Head">Body</Card>);
    const card = part('ui.card');
    expect(card?.tagName).toBe('BUTTON');
    card?.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(part('ui.card.header')?.textContent).toBe('Head');
  });
});
