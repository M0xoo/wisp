// The `preview` block: a live web page at the screen size the agent picked (web/js/preview-spec.js),
// its protocol entry and its text stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICES, PREVIEW_SIZE, isLoopback, previewProblem, previewSandbox, previewSize, previewUrl, shortUrl } from '../web/js/preview-spec.js';
import { SYSTEM_PROMPT } from '../server/protocol.js';
import { blocksToMarkdown } from '../server/render.js';
import * as schema from '../web/js/spell-schema.js';

test('a named device, an alias, WxH or width/height pick the size; desktop otherwise', () => {
  assert.deepEqual(previewSize({ device: 'mobile' }), { device: 'mobile', w: DEVICES.mobile.w, h: DEVICES.mobile.h });
  assert.equal(previewSize({ device: 'Tablette' }).device, 'tablet');
  assert.equal(previewSize({ device: 'phone' }).device, 'mobile');
  assert.deepEqual(previewSize({ device: '1280x720' }), { device: 'custom', w: 1280, h: 720 });
  assert.deepEqual(previewSize({ size: '375 × 667' }), { device: 'custom', w: 375, h: 667 });
  assert.deepEqual(previewSize({ width: 1024, height: 768 }), { device: 'custom', w: 1024, h: 768 });
  assert.deepEqual(previewSize({ width: 1024 }), { device: 'custom', w: 1024, h: DEVICES.desktop.h });
  assert.deepEqual(previewSize({}), { device: 'desktop', w: DEVICES.desktop.w, h: DEVICES.desktop.h });
  assert.equal(previewSize({ device: 'toaster' }).device, 'desktop');
  // Silly sizes are kept within bounds.
  assert.deepEqual(previewSize({ width: 5, height: 99999 }), { device: 'custom', w: PREVIEW_SIZE[0], h: PREVIEW_SIZE[1] });
});

test('only http(s) pages without credentials load; a bare localhost gets http://', () => {
  assert.equal(previewUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(previewUrl('localhost:5173/settings'), 'http://localhost:5173/settings');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'blob:https://x/y', 'https://u:p@example.com/', 'not a url', '', null]) {
    assert.equal(previewUrl(bad), null, String(bad));
  }
  assert.equal(previewProblem({}), 'It has no url.');
  assert.match(previewProblem({ url: 'javascript:alert(1)' }), /http/);
  assert.equal(previewProblem({ url: 'http://localhost:3000' }), '');
});

test("the frame never gets top navigation or modals, and wisp's own origin stays opaque", () => {
  const other = previewSandbox('http://localhost:3000/', 'http://localhost:8080');
  assert.match(other, /allow-scripts/);
  assert.match(other, /allow-same-origin/);
  assert.doesNotMatch(other, /allow-top-navigation|allow-modals/);
  // Scripts plus same-origin on wisp's origin could lift the sandbox and reach wisp.
  assert.doesNotMatch(previewSandbox('http://localhost:8080/api/x', 'http://localhost:8080'), /allow-same-origin/);
});

test('loopback and the address bar', () => {
  assert.ok(isLoopback('http://127.0.0.1:3000/'));
  assert.ok(isLoopback('http://localhost/'));
  assert.ok(!isLoopback('https://grid.trywisp.dev/'));
  assert.equal(shortUrl('https://example.com/'), 'example.com');
});

test('agents are told about the preview block, and it reads as a link in text', () => {
  assert.match(SYSTEM_PROMPT, /"type":"preview"/);
  assert.equal(blocksToMarkdown([{ type: 'preview', url: 'http://localhost:5173', device: 'mobile', caption: 'Settings' }]).trim(), '🌐 http://localhost:5173 (mobile) — Settings');
});

test('the preview and its pieces are spell parts, its icons are in ICONS, and preview is a built-in block', () => {
  for (const p of ['preview', 'preview.head', 'preview.stage', 'preview.foot']) assert.ok(schema.PARTS[p], p);
  for (const i of ['phone', 'tablet', 'rotate']) assert.ok(schema.ICONS.includes(i), i);
  assert.ok(schema.BUILTIN_BLOCKS.includes('preview'));
});
