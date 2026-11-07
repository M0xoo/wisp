// The `platform` module (plan §7): what differs between the browser, the Tauri desktop app and the
// Capacitor Android app goes through this one interface, so no feature checks MOBILE or sniffs a
// user agent. Every call answers what happened ('unsupported' is an answer, never a throw), so a
// feature can offer the action everywhere and say so where it can't.

import type { Target } from '@wisp/client';

export type PlatformKind = 'browser' | 'desktop' | 'android';

export interface NotifyOptions {
  title: string;
  body?: string;
  /** one notification per tag: a newer one replaces it (one per task) */
  tag?: string;
  /** where tapping it goes: the shell navigates there with openFromToast (#573) */
  target?: Target;
  silent?: boolean;
}

export type Permission = 'granted' | 'denied' | 'prompt' | 'unsupported';
export type Shown = 'shown' | 'denied' | 'unsupported';

export interface ShareData {
  title?: string;
  text?: string;
  url?: string;
  files?: readonly File[];
}

export interface PickOptions {
  /** 'image/*,.pdf' */
  accept?: string;
  multiple?: boolean;
  /** the phone's camera instead of its files */
  capture?: boolean;
}

export type Haptic = 'tap' | 'select' | 'success' | 'warning' | 'error';

export interface Platform {
  readonly kind: PlatformKind;
  /** touch-first and narrow: the phone layout's affordances (a FAB, press feedback) */
  readonly mobile: boolean;
  /** installed (home-screen web app, or a native shell): the service worker serves the page */
  readonly standalone: boolean;
  /** ⌘ on Apple platforms, Ctrl elsewhere: how `mod+k` is shown and matched */
  readonly apple: boolean;
  notifyPermission(): Promise<Permission>;
  /** asks once; a second ask after a refusal answers 'denied' without a prompt */
  requestNotify(): Promise<Permission>;
  notify(n: NotifyOptions): Promise<Shown>;
  /** the app icon's count (0 clears it) */
  badge(count: number): Promise<'set' | 'unsupported'>;
  share(d: ShareData): Promise<'shared' | 'cancelled' | 'unsupported'>;
  pickFiles(o?: PickOptions): Promise<readonly File[]>;
  haptic(kind: Haptic): void;
  copy(text: string): Promise<boolean>;
  openExternal(url: string): void;
  /** the app came back to the foreground (a phone unlocking, a window focused) */
  onResume(fn: () => void): () => void;
  /** a notification was tapped: where it goes */
  onOpen(fn: (target: Target) => void): () => void;
}

/** The slice of `window` the implementations read; tests pass a fake. */
export interface PlatformWindow {
  readonly navigator: Navigator;
  readonly document: Document;
  matchMedia(q: string): MediaQueryList;
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
  open(url: string, target?: string, features?: string): unknown;
  readonly Notification?: typeof Notification;
  readonly __TAURI_INTERNALS__?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  readonly Capacitor?: CapacitorGlobal;
}

/** The part of Capacitor's global the Android implementation uses (no @capacitor dependency). */
export interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
  Plugins?: Record<string, Record<string, ((args?: unknown) => Promise<unknown>) | undefined> | undefined>;
}
