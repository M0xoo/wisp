// F-look-4: the app's icon is v1's handwritten w with the orb (web/favicon.svg, icon-*.png), in the tab, on a phone's
// home screen and in the installed app, not a stand-in.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const pub = (f: string): string => new URL(`../public/${f}`, import.meta.url).pathname;

test('the_tab_icon_is_the_handwritten_w_with_the_orb_as_in_v1', () => {
  const svg = readFileSync(pub('favicon.svg'), 'utf8');
  // the ink stroke's gradient (teal to violet), the w's path and the orb at its tail
  expect(svg).toContain('id="ink"');
  expect(svg).toContain('id="orb"');
  expect(svg).toContain('<circle cx="795.2" cy="377.2" r="36.8" fill="url(#orb)"/>');
  expect(svg).toContain('<rect x="100" y="100" width="824" height="824" rx="190" fill="url(#bg)"/>');
});

test('installed_and_home_screen_icons_are_v1s_pngs_and_the_manifest_names_them', () => {
  const png = (f: string): Buffer => readFileSync(pub(f));
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  // width and height from the IHDR chunk
  const size = (b: Buffer): [number, number] => [b.readUInt32BE(16), b.readUInt32BE(20)];
  expect(size(png('apple-touch-icon.png'))).toEqual([180, 180]);
  expect(size(png('icon-192.png'))).toEqual([192, 192]);
  expect(size(png('icon-512.png'))).toEqual([512, 512]);
  expect(size(png('icon-maskable-512.png'))).toEqual([512, 512]);
  for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) expect(png(f).subarray(0, 4)).toEqual(PNG);
  const m = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8')) as { icons: { src: string; purpose?: string }[] };
  expect(m.icons.map((i) => i.src)).toEqual(['/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
  expect(m.icons.find((i) => i.purpose === 'maskable')?.src).toBe('/icon-maskable-512.png');
  expect(readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8')).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />');
});
