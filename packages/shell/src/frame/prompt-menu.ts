// A prompt box's @ and / menus (v1 composer.js, mention-text.js, slash-text.js): which menu the caret is in and what
// it's looking for, what a pick does to the text, and how the box's `@Title`s are sent (`@[Title](scheme:id)`).
// Pure; `usePromptMenu` wires it to a box, the plugins' sources (contract PromptSourceDef) and the kit's list.
import { createMemo, createSignal, type Accessor } from 'solid-js';
import type { PromptSuggest } from '@wisp/ui';
import type { PromptItem, PromptSourceDef, ShellContext } from '../contract.ts';

export interface MenuAt {
  readonly trigger: '@' | '/';
  /** where the trigger is: the pick replaces from here to the caret */
  readonly start: number;
  readonly query: string;
}

/** The menu the caret is in: `/word` at the very start (a command, v1), `@words` after a space or the start. */
export function menuAt(text: string, caret: number): MenuAt | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { trigger: '/', start: 0, query: slash[1] ?? '' };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { trigger: '@', start: caret - (at[2] ?? '').length - 1, query: at[2] ?? '' };
  return null;
}

/** The text after a pick: the trigger and what followed it replaced by the item's insert, the caret after it. */
export function applyPick(text: string, m: MenuAt, caret: number, item: Pick<PromptItem, 'insert'>): { text: string; caret: number } {
  const next = text.slice(0, m.start) + item.insert + text.slice(caret);
  return { text: next, caret: m.start + item.insert.length };
}

export interface Mentioned {
  readonly scheme: 'wisp' | 'crew' | 'stuff';
  readonly id: string;
  readonly title: string;
}

/** What is sent: each picked `@Title` still in the text as `@[Title](scheme:id)` (v1's stored form); the rest as typed. */
export function encodeMentions(text: string, mentions: readonly Mentioned[]): string {
  let out = text;
  for (const m of mentions) {
    const shown = `@${m.title}`;
    const i = out.indexOf(shown);
    if (i < 0) continue;
    out = `${out.slice(0, i)}@[${m.title}](${m.scheme}:${m.id})${out.slice(i + shown.length)}`;
  }
  return out;
}

/** The items for a menu: every source for its trigger and box, in order, at most `max`. */
export function itemsFor(sources: readonly PromptSourceDef[], m: MenuAt, where: 'reply' | 'home', ctx: Parameters<PromptSourceDef['items']>[1], max = 8): PromptItem[] {
  const out: PromptItem[] = [];
  for (const s of sources) {
    if (s.trigger !== m.trigger || (s.where && !s.where.includes(where))) continue;
    for (const it of s.items(m.query, ctx)) {
      out.push(it);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface PromptMenu {
  readonly suggest: Accessor<PromptSuggest | undefined>;
  /** call from the box's input: what's typed and where the caret is */
  readonly typed: (text: string) => void;
  /** what to send: the text with its mentions encoded */
  readonly encode: (text: string) => string;
  /** after a send: the mentions go */
  readonly reset: () => void;
}

export function usePromptMenu(o: {
  readonly shell: ShellContext;
  readonly where: 'reply' | 'home';
  readonly task?: string;
  readonly text: Accessor<string>;
  readonly setText: (v: string) => void;
  readonly input: () => HTMLTextAreaElement | undefined;
  readonly id: string;
}): PromptMenu {
  const sources = o.shell.promptSources();
  const [at, setAt] = createSignal<MenuAt | null>(null);
  const [active, setActive] = createSignal(0);
  const [mentions, setMentions] = createSignal<readonly Mentioned[]>([]);
  const ctx = { client: o.shell.client.plugin('shell'), ...(o.task !== undefined && { task: o.task }) };
  const items = createMemo((): PromptItem[] => {
    const m = at();
    return m ? itemsFor(sources(), m, o.where, ctx) : [];
  });
  const pick = (value: string): void => {
    const m = at();
    const it = items().find((x) => x.value === value);
    const el = o.input();
    if (!m || !it) return;
    const caret = el?.selectionStart ?? o.text().length;
    const r = applyPick(o.text(), m, caret, it);
    if (it.mention) setMentions([...mentions().filter((x) => x.title !== it.mention?.title), it.mention]);
    o.setText(r.text);
    setAt(null);
    queueMicrotask(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };
  const suggest = createMemo((): PromptSuggest | undefined => {
    const list = items();
    if (!at() || list.length === 0) return undefined;
    return {
      id: o.id,
      label: o.shell.t(at()?.trigger === '/' ? 'shell.prompt.slash' : 'shell.prompt.mention'),
      items: list.map((x) => ({
        value: x.value,
        label: x.label,
        ...(x.detail && { detail: x.detail }),
        ...(x.hint && { hint: x.hint }),
        ...(x.icon && { icon: x.icon as never }),
        ...(x.open && { onOpen: x.open, openLabel: o.shell.t('shell.prompt.open', { name: x.label }) }),
      })),
      active: Math.min(active(), list.length - 1),
      onPick: pick,
      onActive: setActive,
      onClose: () => setAt(null),
    };
  });
  return {
    suggest,
    typed: (text) => {
      const caret = o.input()?.selectionStart ?? text.length;
      setAt(menuAt(text, caret));
      setActive(0);
    },
    encode: (text) => encodeMentions(text, mentions()),
    reset: () => setMentions([]),
  };
}
