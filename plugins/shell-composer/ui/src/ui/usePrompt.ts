// The text box both prompts share: the draft (stored with its mentions encoded, so a reload brings
// them back), the / menu, the @ menu (tasks, crew, My Stuff), /after's task picker, prompt history,
// Backspace over a whole mention, pasted task ids and dictation. Keys go to the open menu first,
// then history, then the box's own (Shift+Tab, Enter): v1's order (the menu registers first).
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { useSignal, optionId, suggestKey, sendsOn, type SuggestItem } from '@wisp/ui';
import type { Env } from '../env.ts';
import { caretLines, historyStep } from '../text/history.ts';
import { decode, encode, insertMention, liveMentions, mentionQuery, pastedTasks, spans, type Mention } from '../text/mentions.ts';
import { slashMatches, type SlashCommand } from '../text/slash.ts';
import type { Dictation, DictationEvent } from '../types.ts';

export interface Candidate extends SuggestItem {
  readonly mention?: Mention;
}

export interface PromptOptions {
  readonly env: Env;
  /** the draft's entity: the task's key, or New task's */
  readonly entity: string;
  readonly slash: () => readonly SlashCommand[];
  /** what @query could be: tasks, crew, stuff (already filtered and ranked) */
  readonly mentionable: (query: string) => readonly Candidate[];
  /** /after's picker: tasks to wait for */
  readonly afterable?: (query: string) => readonly Candidate[];
  /** a pasted id names a known task: its title */
  readonly taskTitle: (id: string) => string | undefined;
  /** ↑/↓ browse the prompts sent before (New task only, as in v1) */
  readonly history?: boolean;
  readonly onSend: (opts: { readonly now: boolean }) => void;
  readonly onShiftTab?: () => void;
  readonly listId: string;
}

type Menu = { kind: 'slash' | 'mention' | 'after'; items: readonly Candidate[]; start: number };

export interface Prompt {
  /** what the box shows */
  readonly shown: Accessor<string>;
  /** what is stored and sent: mentions as `@[Title](scheme:id)` */
  readonly stored: Accessor<string>;
  readonly mentions: Accessor<readonly Mention[]>;
  readonly menu: Accessor<Menu | undefined>;
  readonly active: Accessor<number>;
  setActive(i: number): void;
  pick(value: string): void;
  input(shown: string, el: HTMLTextAreaElement): void;
  keydown(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void;
  paste(e: ClipboardEvent & { currentTarget: HTMLTextAreaElement }): void;
  /** replaces the whole text (history, a tip, a restore after a refusal) */
  set(stored: string): void;
  clear(): void;
  ref(el: HTMLTextAreaElement): void;
  focus(): void;
  listening: Accessor<boolean>;
  toggleDictation(d: Dictation, onError: (e: DictationEvent & { state: 'error' }) => void): void;
}

const AFTER = /^\/after\s+([^\n@]{0,60})$/i;

// size-ok: one closure per behaviour of the box, over its shared signals
export function usePrompt(o: PromptOptions): Prompt {
  const draft = useSignal(o.env.text(o.entity));
  const decoded = createMemo(() => decode(draft()));
  const shown = (): string => decoded().text;
  const mentions = (): readonly Mention[] => decoded().mentions;
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [closedAt, setClosedAt] = createSignal<string | undefined>(undefined);
  const [browse, setBrowse] = createSignal<number | null>(null);
  const [listening, setListening] = createSignal(false);
  const box: { el: HTMLTextAreaElement | undefined; stop: (() => void) | undefined } = { el: undefined, stop: undefined };
  onCleanup(() => box.stop?.());

  const write = (text: string, list: readonly Mention[]): void => o.env.setText(o.entity, encode(text, liveMentions(text, list)));
  const moveCaret = (to: number): void => {
    setCaret(to);
    queueMicrotask(() => box.el?.setSelectionRange(to, to));
  };

  const menu = createMemo<Menu | undefined>(() => {
    const text = shown();
    if (closedAt() === text) return undefined;
    const slash = slashMatches(text, o.slash());
    if (slash.length) return { kind: 'slash', start: 0, items: slash.map((c) => ({ value: c.name, label: `/${c.name}`, detail: c.args ? o.env.t(c.args) : '', hint: o.env.t(c.hint) })) };
    const before = text.slice(0, caret());
    const after = o.afterable && AFTER.exec(before);
    if (after) {
      const items = o.afterable?.(after[1] ?? '') ?? [];
      return items.length ? { kind: 'after', start: before.length - (after[1] ?? '').length, items } : undefined;
    }
    const q = mentionQuery(text, caret());
    if (!q) return undefined;
    const items = o.mentionable(q.query);
    return items.length ? { kind: 'mention', start: q.start, items } : undefined;
  });
  // a new list starts at its first row
  createEffect(
    on(
      () =>
        menu()
          ?.items.map((i) => i.value)
          .join('\n'),
      () => setActive(0),
      { defer: true },
    ),
  );

  function pick(value: string): void {
    const m = menu();
    const item = m?.items.find((i) => i.value === value);
    if (!m || !item) return;
    if (m.kind === 'slash') {
      const text = `/${value} `;
      write(text, mentions());
      moveCaret(text.length);
      return;
    }
    if (!item.mention) return;
    const next = insertMention(shown(), m.start, caret(), item.mention);
    write(next.text, [...mentions(), item.mention]);
    moveCaret(next.caret);
  }

  function menuKey(e: KeyboardEvent): boolean {
    const m = menu();
    if (!m) return false;
    const k = suggestKey(e, m.items.length, active());
    if (!k || k.t === 'open') return false;
    // Enter on a bare command typed out in full sends it (/goal, /feedback): v1 SL
    if (k.t === 'pick' && e.key === 'Enter' && m.kind === 'slash') {
      const exact = o.slash().find((c) => `/${c.name}` === shown().trim());
      if (exact?.bare) return false;
    }
    e.preventDefault();
    if (k.t === 'move') setActive(k.to);
    else if (k.t === 'close') setClosedAt(shown());
    else pick(m.items[active()]?.value ?? '');
    return true;
  }

  function historyKey(e: KeyboardEvent, el: HTMLTextAreaElement): boolean {
    if (!o.history || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.isComposing || el.selectionStart !== el.selectionEnd) return false;
    const lines = caretLines(shown(), el.selectionStart);
    const step = historyStep({ key: e.key, value: shown(), list: o.env.sent.value(), at: browse(), ...lines });
    if (!step) return false;
    e.preventDefault();
    setBrowse(step.at);
    o.env.setText(o.entity, step.value);
    moveCaret(decode(step.value).text.length);
    return true;
  }

  /** Backspace at a mention's end (Delete at its start) takes the whole mention. */
  function mentionKey(e: KeyboardEvent, el: HTMLTextAreaElement): boolean {
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || el.selectionStart !== el.selectionEnd || e.altKey || e.metaKey || e.ctrlKey) return false;
    const at = el.selectionStart;
    const s = spans(shown(), mentions()).find((x) => (e.key === 'Backspace' ? x.end === at : x.start === at));
    if (!s) return false;
    e.preventDefault();
    const text = shown().slice(0, s.start) + shown().slice(s.end);
    write(text, mentions());
    moveCaret(s.start);
    return true;
  }

  return {
    shown,
    stored: draft,
    mentions,
    menu,
    active,
    setActive,
    pick,
    input(text, el) {
      setCaret(el.selectionStart);
      if (closedAt() !== undefined && closedAt() !== text) setClosedAt(undefined);
      write(text, mentions());
    },
    keydown(e) {
      const el = e.currentTarget;
      queueMicrotask(() => setCaret(el.selectionStart));
      if (menuKey(e) || mentionKey(e, el) || historyKey(e, el)) return;
      if (e.key === 'Tab' && e.shiftKey && o.onShiftTab) {
        e.preventDefault();
        o.onShiftTab();
        return;
      }
      if (sendsOn(e, 'enter') || (e.key === 'Enter' && e.altKey && !e.isComposing)) {
        e.preventDefault();
        setBrowse(null);
        o.onSend({ now: e.altKey });
      }
    },
    paste(e) {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const ids = text && pastedTasks(text, (id) => o.taskTitle(id) !== undefined);
      if (!ids) return;
      e.preventDefault();
      const el = e.currentTarget;
      const picked = ids.map((id): Mention => ({ id, title: o.taskTitle(id) ?? id, kind: 'task' }));
      const lead = el.selectionStart > 0 && !/\s$/.test(shown().slice(0, el.selectionStart)) ? ' ' : '';
      const ins = lead + picked.map((m) => `@${m.title} `).join('');
      const next = shown().slice(0, el.selectionStart) + ins + shown().slice(el.selectionEnd);
      write(next, [...mentions(), ...picked]);
      moveCaret(el.selectionStart + ins.length);
    },
    set: (stored) => o.env.setText(o.entity, stored),
    clear: () => o.env.setText(o.entity, ''),
    ref: (el) => (box.el = el),
    focus: () => box.el?.focus(),
    listening,
    toggleDictation(d, onError) {
      if (box.stop) {
        box.stop();
        box.stop = undefined;
        setListening(false);
        return;
      }
      const el = box.el;
      const at = el?.selectionStart ?? shown().length;
      const head = shown().slice(0, at);
      const tail = shown().slice(el?.selectionEnd ?? at);
      const seen = { text: shown() };
      setListening(true);
      box.stop = d.start((ev) => {
        if (ev.state === 'partial' || ev.state === 'final') {
          // the box changed underneath (sent, cleared, typed in): stop and leave it alone
          if (shown() !== seen.text) return box.stop?.();
          const words = ev.text.trim();
          const text = `${head}${head && !/\s$/.test(head) ? ' ' : ''}${words}${tail && !/^\s/.test(tail) ? ' ' : ''}${tail}`;
          write(text, mentions());
          seen.text = text;
          moveCaret(text.length - tail.length);
        } else if (ev.state === 'error') {
          onError(ev);
        }
        if (ev.state === 'end' || ev.state === 'error') {
          box.stop = undefined;
          setListening(false);
        }
      });
    },
  };
}

/** The textarea's combobox wiring for the open menu. */
export const listboxOf = (p: Prompt, id: string): { id: string; active: string } | undefined => (p.menu() ? { id, active: optionId(id, p.active()) } : undefined);
