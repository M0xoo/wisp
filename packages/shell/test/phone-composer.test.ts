// The phone app's composer (F-comp-13, F-comp-14): the paperclip offers Take photo, Record video and Choose files
// where the app has its camera handler (v1 attachments.js), and the mic types what you say where the caret was, its
// partial results as they come (v1 dictate.js). Browsers and the desktop app see neither.
import { createRoot } from 'solid-js';
import { expect, test } from 'vitest';
import { attachAct, PICK } from '../src/frame/capture.ts';
import { spoken, useMic } from '../src/frame/dictate.ts';
import { androidDictation, androidPlatform } from '../src/platform/android.ts';
import { nullPlatform } from '../src/platform/index.ts';
import type { ShellContext } from '../src/contract.ts';
import type { Platform, PlatformWindow } from '../src/platform/types.ts';

const shellOn = (platform: Platform, toasts: string[] = []): ShellContext =>
  ({ platform, t: (k: string) => k, toast: { show: (m: string) => toasts.push(m), error: (m: string) => toasts.push(`bad:${m}`) } }) as unknown as ShellContext;

function fakeWindow(app: PlatformWindow['wispAndroid']): PlatformWindow & { fire(detail: unknown): void; calls: string[] } {
  const fns: ((e: Event) => void)[] = [];
  const mq = { matches: false } as MediaQueryList;
  return {
    navigator: { platform: 'Linux', userAgent: 'wispMobile' } as Navigator,
    document: {} as Document,
    matchMedia: () => mq,
    addEventListener: (_t: string, fn: (e: Event) => void) => fns.push(fn),
    removeEventListener: () => {},
    open: () => null,
    location: { reload: () => {}, origin: 'http://127.0.0.1:4791' },
    ...(app && { wispAndroid: app }),
    calls: [],
    fire(detail) {
      for (const f of fns) f({ type: 'wisp-dictation', detail } as unknown as Event);
    },
  };
}

test('the phone app attach menu offers the camera first then files and a browser opens the picker_v1_attach_menu', () => {
  const picked: unknown[] = [];
  const phone = attachAct(shellOn(nullPlatform({ camera: true })), (o) => picked.push(o), false);
  expect(phone.menu?.items.map((i) => ('value' in i ? i.value : ''))).toEqual(['photo', 'video', 'files']);
  phone.menu?.onSelect('photo');
  phone.menu?.onSelect('video');
  expect(picked).toEqual([PICK.photo, PICK.video]);
  expect(PICK.photo).toEqual({ accept: 'image/*', capture: true });
  const browser = attachAct(shellOn(nullPlatform()), (o) => picked.push(o), false);
  expect(browser.menu).toBeUndefined();
  browser.onClick?.();
  expect(picked.at(-1)).toEqual({ multiple: true });
  // an older app (no camera handler) keeps the file picker
  expect(androidPlatform(fakeWindow({})).camera).toBe(false);
  expect(androidPlatform(fakeWindow({ camera: () => true })).camera).toBe(true);
});

test('dictation types what is said at the caret a space from the words around it_v1_dictate', () => {
  expect(spoken('fix the', '', 'login page')).toEqual({ text: 'fix the login page', caret: 18 });
  expect(spoken('fix ', 'now', 'it')).toEqual({ text: 'fix it now', caret: 6 });
  expect(spoken('', '', '  hello ')).toEqual({ text: 'hello', caret: 5 });
  expect(spoken('a', 'b', '')).toEqual({ text: 'ab', caret: 1 });
  // no bridge, or a phone without a speech service: no mic
  expect(androidDictation(fakeWindow(undefined))).toBeUndefined();
  expect(androidDictation(fakeWindow({ dictate: () => {}, dictateStop: () => {}, dictation: () => false }))).toBeUndefined();
  const calls: string[] = [];
  const w = fakeWindow({ dictate: () => calls.push('start'), dictateStop: () => calls.push('stop'), dictation: () => true });
  const d = androidDictation(w);
  expect(d).toBeDefined();
  const toasts: string[] = [];
  createRoot((dispose) => {
    let text = 'fix the bug';
    const el = { selectionStart: 7, selectionEnd: 7, setSelectionRange: () => {} } as unknown as HTMLTextAreaElement;
    const mic = useMic(shellOn(nullPlatform({ ...(d && { dictation: d }) }), toasts), { text: () => text, set: (v) => (text = v), el: () => el });
    expect(mic).toBeDefined();
    mic?.toggle();
    expect(mic?.on()).toBe(true); // at once
    expect(calls).toEqual(['start']);
    w.fire({ state: 'partial', text: 'login' });
    expect(text).toBe('fix the login bug');
    w.fire({ state: 'final', text: 'login page' });
    expect(text).toBe('fix the login page bug');
    w.fire({ state: 'end' });
    expect(mic?.on()).toBe(false);
    // typed in while listening: it stops and leaves the box alone
    mic?.toggle();
    text = 'something else';
    w.fire({ state: 'partial', text: 'ignored' });
    expect(text).toBe('something else');
    expect(calls.at(-1)).toBe('stop');
    w.fire({ state: 'error', error: 'blocked' });
    expect(mic?.on()).toBe(false);
    expect(toasts).toEqual(['bad:shell.mic.blocked']);
    dispose();
  });
  // a browser: no mic
  createRoot((dispose) => {
    expect(useMic(shellOn(nullPlatform()), { text: () => '', set: () => {}, el: () => undefined })).toBeUndefined();
    dispose();
  });
});
