// What My Stuff needs from the page around it that @wisp/client doesn't offer yet: toasts with an
// action, a file's address on its peer, the clipboard, a new tab, the grid's preview address and the
// shell's extension inputs. The shell provides these (StuffEnvProvider); until it does, the
// defaults keep every screen working and say so in a toast where they can't.

import { createContext, useContext, type JSX } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import type { ExtensionOutput } from '@wisp/ui';
import type { Item, StuffView } from './types.ts';

export interface ToastSpec {
  readonly tone?: 'info' | 'success' | 'error';
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly duration?: number;
}

export interface StuffEnv {
  toast(message: string, o?: ToastSpec): void;
  /** the item's bytes on the peer that keeps it: `?r=` follows its rev so an update shows */
  fileUrl(key: EntityKey, it: Item, o?: { download?: boolean }): string;
  coverUrl(key: EntityKey, it: Item): string;
  /** a doc's or a code file's text (the reader, Copy) */
  readText(key: EntityKey, it: Item): Promise<string>;
  /** files dropped, pasted or picked: the bytes go over HTTP, not the sync stream */
  upload(file: File, o: { name: string; type: string }): Promise<StuffView>;
  /** wisp's own origin and the page's address: a frame on wisp's origin never gets same-origin */
  origin(): string;
  page(): string;
  /** the grid's preview address template (`https://p{port}--ada.grid.example`), if any */
  previewTemplate(): string | undefined;
  /** a sign-in link for a preview address behind the grid (v1 grid-link.js); the address otherwise */
  gridLink(url: string, to: string): Promise<string>;
  /** the phone app: no hover, no new tabs signed in, apps only through wisp Cloud */
  mobile(): boolean;
  openTab(url: string): void;
  copy(text: string): Promise<boolean>;
  /** a picture's bytes onto the clipboard */
  copyImage(url: string): Promise<boolean>;
  download(url: string, name: string): void;
  /** what the shell attached to an input this view offers (`shell.stuff:head`) */
  slot(input: string): readonly ExtensionOutput[];
  /** New task, with the item mentioned in the prompt box */
  mention(key: EntityKey, it: Item): void;
}

const pageHref = (): string => (typeof document === 'undefined' ? 'http://localhost/' : document.baseURI);

export const defaultEnv: StuffEnv = {
  toast: () => undefined,
  fileUrl: (_key, it, o) => `/api/stuff/${encodeURIComponent(it.id)}/file?r=${it.rev ?? 1}${o?.download ? '&download=1' : ''}`,
  coverUrl: (_key, it) => `/api/stuff/${encodeURIComponent(it.id)}/cover?r=${it.rev ?? 1}`,
  readText: () => Promise.reject(new Error('stuff.err.noReader')),
  upload: () => Promise.reject(new Error('stuff.err.noUpload')),
  origin: () => new URL(pageHref()).origin,
  page: pageHref,
  previewTemplate: () => undefined,
  gridLink: (_url, to) => Promise.resolve(to),
  mobile: () => false,
  openTab: (url) => void globalThis.open?.(url, '_blank', 'noopener'),
  copy: (text) =>
    globalThis.navigator?.clipboard?.writeText(text).then(
      () => true,
      () => false,
    ) ?? Promise.resolve(false),
  copyImage: () => Promise.resolve(false),
  download: () => undefined,
  slot: () => [],
  mention: () => undefined,
};

const Ctx = createContext<StuffEnv>(defaultEnv);

export function StuffEnvProvider(props: { readonly env: Partial<StuffEnv>; readonly children?: JSX.Element }): JSX.Element {
  return <Ctx.Provider value={{ ...defaultEnv, ...props.env }}>{props.children}</Ctx.Provider>;
}

export const useEnv = (): StuffEnv => useContext(Ctx);
