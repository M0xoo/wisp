// ADR-0048's edge cases for an untrusted plugin's UI: only kit components and their props are drawn; its frame can't
// reach wisp's API or storage; an event goes back to it by the id its descriptor gave.
import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { clean, type Desc } from '../src/remote/descriptor.ts';
import { CSP, PRELUDE, SANDBOX, frameDoc } from '../src/remote/frame.ts';
import { Render, readFrame } from '../src/remote/RemoteView.tsx';
import { remoteUiDefs } from '../src/remote/index.ts';

const off: (() => void)[] = [];
afterEach(() => {
  while (off.length) off.pop()?.();
  document.body.innerHTML = '';
});

describe('the untrusted tier’s UI (ADR-0048)', () => {
  test('a_descriptor_names_only_kit_components_and_their_props_and_anything_else_is_dropped', () => {
    const tree = clean({
      c: 'Stack',
      p: { gap: '3', class: 'x', style: 'color:red', onclick: 'steal()', align: 'nowhere' },
      k: [
        { c: 'Text', p: { tone: 'muted', size: 'sm' }, k: ['Hello ', 42, '<img src=x onerror=alert(1)>'] },
        { c: 'div', p: { innerHTML: '<b>no</b>' }, k: ['gone'] },
        { c: 'script', k: ['alert(1)'] },
        { c: 'Button', p: { label: 'Save', variant: 'primary', href: 'javascript:alert(1)' }, on: 'save' },
        { c: 'Button', p: { label: 'Bad id' }, on: 'a b<c>' },
        { c: 'Select', p: { items: [{ value: 'a', label: 'A' }, { nope: 1 }, 'x'], value: 'a' }, on: 'pick' },
        { c: 'SettingsRow', p: { title: 'Row', control: { c: 'Switch', p: { checked: true }, on: 'flip' } } },
        { c: 'Code', p: { text: 'ls', block: 'yes' } },
        null,
        ['nested array'],
      ],
    }) as Desc;
    expect(tree.c).toBe('Stack');
    expect(tree.p).toEqual({ gap: '3' });
    expect(tree.k.map((n) => (typeof n === 'string' ? 'text' : n.c))).toEqual(['Text', 'Button', 'Button', 'Select', 'SettingsRow', 'Code']);
    const text = tree.k[0] as Desc;
    expect(text.k).toEqual(['Hello ', '42', '<img src=x onerror=alert(1)>']); // text: drawn as text, never as HTML
    const save = tree.k[1] as Desc;
    expect(save.on).toBe('save');
    expect(save.p).toEqual({ label: 'Save', variant: 'primary' });
    expect((tree.k[2] as Desc).on).toBeUndefined();
    expect((tree.k[3] as Desc).p['items']).toEqual([{ value: 'a', label: 'A' }]);
    expect(((tree.k[4] as Desc).p['control'] as Desc).on).toBe('flip');
    expect((tree.k[5] as Desc).p).toEqual({ text: 'ls' });
    expect(clean({ c: 'iframe' })).toBeUndefined();
    expect(clean('just text')).toBe('just text');
    // a flood is cut, not drawn whole
    const flood = clean({ c: 'Stack', k: Array.from({ length: 5000 }, (_, i) => String(i)) }) as Desc;
    expect(flood.k.length).toBeLessThan(2000);
    // and what's drawn is the kit, with the text as text
    const host = document.createElement('div');
    document.body.append(host);
    off.push(render(() => <Render node={tree} fire={() => undefined} />, host));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('[class="x"]')).toBeNull(); // the plugin's class and style never reach the page
    expect(host.innerHTML).not.toContain('color:red');
  });

  test('an_untrusted_ui_cannot_reach_wisps_api_or_storage_from_its_frame', () => {
    expect(SANDBOX).toBe('allow-scripts'); // no allow-same-origin: an opaque origin, no cookies, no wisp storage
    expect(CSP).toContain("default-src 'none'"); // no fetch, no sockets (connect-src falls back to none)
    expect(CSP).not.toMatch(/connect-src/);
    const doc = frameDoc();
    expect(doc).toContain(`content="${CSP}"`);
    expect(doc).not.toMatch(/allow-same-origin|localStorage|document\.cookie|fetch\(/);
    expect(PRELUDE).not.toMatch(/fetch|XMLHttpRequest|importScripts/);
    // the host reads only what it knows from a frame
    expect(readFrame({ t: 'call', id: 1, cmd: 'plugins.list', args: {} })).toEqual({ t: 'call', id: 1, cmd: 'plugins.list', args: {} });
    expect(readFrame({ t: 'call', id: 1, cmd: '../../api/x' })).toBeUndefined();
    expect(readFrame({ t: 'navigate', to: '/settings' })).toBeUndefined();
    expect(readFrame('ready')).toBeUndefined();
    // only a plugin of yours, only in Settings for now
    const defs = remoteUiDefs([
      { plugin: 'user.theme', id: 'user.theme.pane', place: 'shell.settings', title: 'Theme', module: '' },
      { plugin: 'wisp.crew', id: 'wisp.crew.x', place: 'shell.settings', title: 'X', module: '' },
      { plugin: 'user.theme', id: 'user.theme.bar', place: 'shell.toolbar', title: 'Bar', module: '' },
    ]);
    expect(defs.map((d) => [d.id, d.settings?.map((s) => s.id)])).toEqual([['user.theme', ['user.theme.pane']]]);
  });

  test('an_event_goes_back_to_the_plugin_by_the_id_its_descriptor_gave', () => {
    const fired: [string | undefined, unknown][] = [];
    const tree = clean({
      c: 'Stack',
      k: [
        { c: 'Button', p: { label: 'Save' }, on: 'save' },
        { c: 'Button', p: { label: 'Nothing' } },
        { c: 'Input', p: { label: 'Name' }, on: 'name' },
      ],
    });
    const host = document.createElement('div');
    document.body.append(host);
    off.push(render(() => <Render node={tree ?? ''} fire={(on, v) => fired.push([on, v])} />, host));
    const buttons = [...host.querySelectorAll('button')];
    buttons[0]?.click();
    buttons[1]?.click();
    const input = host.querySelector('input');
    if (input) {
      input.value = 'Ada';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(fired).toEqual([
      ['save', undefined],
      [undefined, undefined],
      ['name', 'Ada'],
    ]);
  });
});
