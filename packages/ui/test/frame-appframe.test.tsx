// AppFrame, Thumb and the frame theme (src/frame): a sandboxed page that keeps its box while it
// loads, never flashes on a new address, and only hears from the frame it made.
import { describe, expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { AppFrame, FRAME_TOKENS, lockDoc, themeCss, Thumb, type AppFrameController } from '../src/index.ts';
import { mount, part, tick } from './helpers.tsx';

const frames = (host: HTMLElement): HTMLIFrameElement[] => [...host.querySelectorAll('iframe')];
const loaded = (f: HTMLIFrameElement | undefined): void => void f?.dispatchEvent(new Event('load'));
// happy-dom loads no page into a frame: give it a window to talk to.
function fakeWindow(f: HTMLIFrameElement | undefined): { postMessage: ReturnType<typeof vi.fn> } {
  const win = { postMessage: vi.fn() };
  if (f) Object.defineProperty(f, 'contentWindow', { value: win, configurable: true });
  return win;
}

describe('AppFrame', () => {
  test('sandboxed and named; a placeholder holds its place until the page loads', async () => {
    const onLoad = vi.fn();
    const host = mount(() => <AppFrame title="Board" src="http://127.0.0.1:47100/" sandbox="allow-scripts allow-forms" allow="clipboard-write" onLoad={onLoad} />);
    await tick();
    const [f] = frames(host);
    expect(f?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(f?.getAttribute('title')).toBe('Board');
    expect(f?.getAttribute('allow')).toBe('clipboard-write');
    expect(part('ui.app-frame.wait')?.getAttribute('role')).toBe('status');
    expect(part('ui.app-frame')?.hasAttribute('data-ready')).toBe(false);
    loaded(f);
    await tick();
    expect(part('ui.app-frame.wait')).toBeNull();
    expect(part('ui.app-frame')?.hasAttribute('data-ready')).toBe(true);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  test('an empty sandbox is kept as given: everything off', async () => {
    const host = mount(() => <AppFrame title="x" srcdoc="<p>hi</p>" sandbox="" />);
    await tick();
    expect(frames(host)[0]?.getAttribute('sandbox')).toBe('');
  });

  test('a new address loads hidden on top; the old page stays until it has loaded', async () => {
    const [src, setSrc] = createSignal('http://127.0.0.1:47100/?r=1');
    const host = mount(() => <AppFrame title="Board" src={src()} sandbox="allow-scripts" />);
    await tick();
    loaded(frames(host)[0]);
    setSrc('http://127.0.0.1:47100/?r=2');
    await tick();
    const [old, next] = frames(host);
    expect(frames(host)).toHaveLength(2);
    expect(next?.hasAttribute('data-pending')).toBe(true);
    expect(old?.hasAttribute('data-pending')).toBe(false);
    loaded(next);
    await tick();
    expect(frames(host)).toEqual([next]);
    expect(next?.hasAttribute('data-pending')).toBe(false);
    expect(part('ui.app-frame.wait')).toBeNull();
  });

  test('messages: only from its own frame and origin; replies go back to that origin', async () => {
    const got: unknown[] = [];
    const host = mount(() => <AppFrame title="Board" src="http://127.0.0.1:47100/" origin="http://127.0.0.1:47100" sandbox="allow-scripts" onMessage={(d, reply) => (got.push(d), reply({ ok: 1 }))} />);
    await tick();
    const win = fakeWindow(frames(host)[0]);
    const spy = win.postMessage;
    window.dispatchEvent(new MessageEvent('message', { data: 'forged', source: window, origin: 'http://127.0.0.1:47100' }));
    window.dispatchEvent(new MessageEvent('message', { data: 'wrong origin', source: win as unknown as Window, origin: 'https://evil.example' }));
    window.dispatchEvent(new MessageEvent('message', { data: 'real', source: win as unknown as Window, origin: 'http://127.0.0.1:47100' }));
    expect(got).toEqual(['real']);
    expect(spy).toHaveBeenCalledWith({ ok: 1 }, 'http://127.0.0.1:47100');
  });

  test('the controller posts to the newest frame, reloads, and focuses', async () => {
    let c: AppFrameController | undefined;
    const host = mount(() => <AppFrame title="Board" src="http://127.0.0.1:47100/a" origin="http://127.0.0.1:47100" sandbox="allow-scripts" controller={(x) => (c = x)} />);
    await tick();
    const f = frames(host)[0];
    const spy = fakeWindow(f).postMessage;
    if (!c) throw new Error('no controller');
    c.post({ wispPane: 1, event: 'context' });
    expect(spy).toHaveBeenCalledWith({ wispPane: 1, event: 'context' }, 'http://127.0.0.1:47100');
    c.reload();
    expect(f?.getAttribute('src') ?? f?.src).toContain('/a');
  });

  test('a fixed page size scales into its box', async () => {
    mount(() => <AppFrame title="Phone" src="https://example.com/" sandbox="allow-scripts" page={{ w: 390, h: 844 }} scale={0.5} />);
    await tick();
    const box = part('ui.app-frame');
    expect(box?.hasAttribute('data-page')).toBe(true);
    expect(box?.style.getPropertyValue('--k-af-w')).toBe('390');
    expect(box?.style.getPropertyValue('--k-af-scale')).toBe('0.5');
  });

  test('locked: the page sits in a script-less wrapper whose CSP pins its navigations', async () => {
    const host = mount(() => <AppFrame title="Board" src="http://127.0.0.1:47100/" sandbox="allow-scripts allow-same-origin" lock="default-src 'none'; frame-src http://127.0.0.1:47100" />);
    await tick();
    const [wrapper] = frames(host);
    expect(wrapper?.hasAttribute('sandbox')).toBe(false);
    expect(wrapper?.srcdoc).toContain(`content="default-src 'none'; frame-src http://127.0.0.1:47100"`);
    expect(wrapper?.srcdoc).not.toMatch(/<script/);
  });
});

describe('the frame theme', () => {
  test('themeCss: a :root rule a value cannot break out of', () => {
    expect(themeCss({ '--ink': '#171717', '--bg': 'red;}</style><script>' }, 'dark')).toBe(':root{--ink:#171717;--bg:red/style>script>;color-scheme:dark}');
    expect(themeCss()).toBe(':root{;color-scheme:light}');
  });

  test('the tokens a framed page gets are the v1 set, in its order', () => {
    expect(FRAME_TOKENS[0]).toBe('--bg');
    expect(FRAME_TOKENS).toContain('--accent');
    expect(FRAME_TOKENS).toHaveLength(25);
  });

  test('lockDoc: the CSP comes first in head, nothing runs, a quote cannot end the attribute', () => {
    const doc = lockDoc(`default-src 'none'"><script>x</script>`);
    expect(doc.indexOf('<meta')).toBeLessThan(doc.indexOf('</head>'));
    expect(doc).not.toMatch(/<script/);
  });
});

describe('Thumb', () => {
  test('a picture, lazy and not draggable; a broken one falls back to what is drawn inside', async () => {
    const host = mount(() => (
      <Thumb src="/x.png" topEnd={<span>star</span>}>
        <span>fallback</span>
      </Thumb>
    ));
    const img = host.querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('draggable')).toBe('false');
    expect(part('ui.thumb.top-end')?.textContent).toBe('star');
    img?.dispatchEvent(new Event('error'));
    await tick();
    expect(host.querySelector('img')).toBeNull();
    expect(part('ui.thumb.body')?.textContent).toBe('fallback');
  });

  test('a video shows its first frame, muted', () => {
    const host = mount(() => <Thumb video="/v.mp4" />);
    const v = host.querySelector('video');
    expect(v?.getAttribute('src')).toBe('/v.mp4#t=0.1');
    expect(v?.muted || v?.hasAttribute('muted')).toBe(true);
  });

  test('no media: the body is what the caller draws', () => {
    mount(() => <Thumb ratio="square">doc</Thumb>);
    expect(part('ui.thumb')?.getAttribute('data-ratio')).toBe('square');
    expect(part('ui.thumb.body')?.textContent).toBe('doc');
  });
});
