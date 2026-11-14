// The kinds of things My Stuff keeps, in the order the page lists them, with their icon and the
// i18n keys of their names (Apps / App). One table, so the chips, the cards and ⌘K agree.

import type { IconName } from '@wisp/ui';
import type { StuffKind } from './types.ts';

export interface KindInfo {
  readonly id: StuffKind;
  readonly icon: IconName;
  /** "Apps" */
  readonly many: string;
  /** "App" */
  readonly one: string;
}

export const KINDS: readonly KindInfo[] = [
  { id: 'app', icon: 'app', many: 'stuff.kind.app.many', one: 'stuff.kind.app.one' },
  { id: 'image', icon: 'image', many: 'stuff.kind.image.many', one: 'stuff.kind.image.one' },
  { id: 'video', icon: 'play', many: 'stuff.kind.video.many', one: 'stuff.kind.video.one' },
  { id: 'doc', icon: 'file', many: 'stuff.kind.doc.many', one: 'stuff.kind.doc.one' },
  { id: 'code', icon: 'terminal', many: 'stuff.kind.code.many', one: 'stuff.kind.code.one' },
  { id: 'file', icon: 'clip', many: 'stuff.kind.file.many', one: 'stuff.kind.file.one' },
  { id: 'link', icon: 'web', many: 'stuff.kind.link.many', one: 'stuff.kind.link.one' },
];

const FILE = KINDS[5] as KindInfo;
export const kindOf = (id: string | undefined): KindInfo => KINDS.find((k) => k.id === id) ?? FILE;
export const isKind = (s: unknown): s is StuffKind => KINDS.some((k) => k.id === s);

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

/** What a file is, before the peer says: code with a language, a doc with text, else by extension. */
export function guessKind(name: string, p: { lang?: string; text?: string } = {}): StuffKind {
  if (p.lang) return 'code';
  if (p.text !== undefined) return 'doc';
  return IMAGE.test(name) ? 'image' : VIDEO.test(name) ? 'video' : 'file';
}
