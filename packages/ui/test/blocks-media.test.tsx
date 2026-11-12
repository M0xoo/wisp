// An answer's pictures and videos (v1 blocks.js R.image, R.video, zoomInSet; ui/viewer.js; ui/image.js): full screen
// goes through the answer's media in order, Copy puts the picture on the clipboard, Show in folder names the file.
import { afterEach, expect, test, vi } from 'vitest';
import { mount, part, tick } from './helpers.tsx';
import { Answer, type BlockContext } from '../src/index.ts';
import { fileName } from '../src/blocks/media-copy.ts';

const click = (el: Element | null | undefined): void => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const key = (k: string, o: KeyboardEventInit = {}): void => void dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
const count = (): string => document.querySelector("[data-kit='viewer-count']")?.textContent ?? '';

afterEach(() => (vi.unstubAllGlobals(), vi.restoreAllMocks()));

test('a picture opens full screen, the arrows go through the answers pictures and videos, Escape closes_v1_media_viewer', async () => {
  const revealed: string[] = [];
  const ctx: BlockContext = { media: (p) => (p.startsWith('http') ? p : `/api/sessions/s/file?path=${encodeURIComponent(p)}`), revealFile: (p) => void revealed.push(p) };
  mount(() => (
    <Answer
      ctx={ctx}
      blocks={[
        { type: 'image', path: 'shots/before.png', caption: 'Before' },
        { type: 'text', text: 'and after' },
        { type: 'image', path: 'shots/after.png', caption: 'After', source: '/tmp/after.png' },
        { type: 'video', path: 'run.mp4', caption: 'The run' },
        { type: 'image', src: 'https://example.com/a.png' },
      ]}
    />
  ));
  const imgs = document.querySelectorAll("[data-kit='rb-image']");
  expect(imgs[0]?.getAttribute('src')).toBe('/api/sessions/s/file?path=shots%2Fbefore.png');
  // the second picture: 2 of 4, in the answer's order
  click(imgs[1]);
  await tick();
  expect(document.querySelector("[data-kit='viewer-img']")?.getAttribute('alt')).toBe('After');
  expect(count()).toBe('2 / 4');
  key('ArrowRight');
  await tick();
  expect(count()).toBe('3 / 4');
  expect(document.querySelector("[data-kit='viewer-vid']")).not.toBeNull(); // the video plays there
  expect(part('block.viewer.copy')).toBeNull(); // a video has no copy
  key('ArrowLeft');
  key('ArrowLeft');
  await tick();
  expect(count()).toBe('1 / 4');
  expect(part('block.viewer.prev')?.hasAttribute('disabled')).toBe(true);
  expect(part('block.viewer.download')?.getAttribute('download')).toBe('before.png');
  key('Escape');
  await tick();
  expect(document.querySelector("[data-kit='viewer']")).toBeNull();

  // Show in folder: where the agent saved it; a link has none
  click(part('image.tools.folder'));
  expect(revealed).toEqual(['shots/before.png']);
  const folders = document.querySelectorAll("[data-part='image.tools.folder']");
  expect(folders.length).toBe(2);
  click(folders[1]);
  expect(revealed.at(-1)).toBe('/tmp/after.png');
  expect(fileName('/api/sessions/s/file?path=%2Ftmp%2Fx%20y.webp')).toBe('x y.webp');
  expect(fileName('https://x.dev/render', 'The chart')).toBe('The-chart.png');
});

test('Copy image puts a PNG on the clipboard and says so on the button; ⌘C in the viewer copies too_v1_copy_image', async () => {
  const wrote: string[][] = [];
  vi.stubGlobal(
    'ClipboardItem',
    class {
      readonly types: string[];
      constructor(o: Record<string, unknown>) {
        this.types = Object.keys(o);
      }
    },
  );
  // the picture is drawn onto a canvas as a PNG (jsdom has neither decode nor a canvas)
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => undefined } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['x'], { type: 'image/png' })));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async (items: { types: string[] }[]) => void wrote.push(items.flatMap((i) => i.types)) } });
  mount(() => <Answer ctx={{ media: (p) => `/f/${p}` }} blocks={[{ type: 'image', path: 'a.png' }]} />);
  click(part('image.tools.copy'));
  await tick();
  expect(wrote).toEqual([['image/png']]);
  expect(part('image.tools.copy')?.getAttribute('aria-label')).toBe('Copied');
  click(document.querySelector("[data-kit='rb-image']"));
  await tick();
  expect(count()).toBe(''); // one picture: no count, no arrows
  expect(part('block.viewer.next')).toBeNull();
  key('c', { metaKey: true });
  await tick();
  expect(wrote.length).toBe(2);
  expect(part('block.viewer.copy')?.hasAttribute('data-done')).toBe(true);
});
