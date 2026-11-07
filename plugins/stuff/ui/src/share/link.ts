// Share links and what can be shared (v1 web/js/features/share.js): a link is <grid>/s/<16
// characters>, found anywhere in New task's box; a passkey to suggest is easy to read out.

import type { ShareableTask } from './types.ts';

// <grid>/s/<16 characters>, anywhere in the text, ending at a space, a stop or the end.
const LINK = /(https?:\/\/[^\s/]+\/s\/[A-Za-z0-9_-]{16})\/?(?=[\s.,;)]|$)/;

/** The first share link in the text, or ''. */
export const shareLinkIn = (text: string | undefined): string => LINK.exec(text ?? '')?.[1] ?? '';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text without the link (its trailing slash too): what goes as the imported task's first follow-up. */
export const withoutLink = (text: string, link: string): string => text.replace(new RegExp(`${escapeRe(link)}/?`), '').trim();

/** Share… is offered on a task of your own: not wisp's own, a subagent's run, a card, one still
 *  starting, a delegated one or one on another machine. */
export const shareable = (s: ShareableTask | undefined): boolean => !!s && s.agent !== 'wisp' && !s.parentId && !s.kind && !s.pending && !s.delegated && !s.machine;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1: nothing to misread

/** Twelve letters and digits in fours: "k7mq-2xhd-pn4w". `bytes` is injectable for tests. */
export function suggestPasskey(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(12))): string {
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length])
    .join('')
    .replace(/(.{4})(?=.)/g, '$1-');
}

/** A passkey is at most 128 characters (the server refuses more). */
export const PASSKEY_MAX = 128;
