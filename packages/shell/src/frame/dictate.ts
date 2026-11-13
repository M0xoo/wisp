// The prompt's mic, in the Android app only (v1 dictate.js, F-comp-14): the phone's speech recognizer types what you
// say where the caret was, its partial results as they come, a space from the words around it. Tap again to stop.
// The box changed under it (sent, cleared, typed in): it stops and leaves the box as it is. One box listens at a time.
import { createSignal, onCleanup } from 'solid-js';
import type { ShellContext } from '../contract.ts';
import type { DictationError } from '../platform/types.ts';

/** `words` said between `before` and `after`: the box's text and where the caret goes. */
export function spoken(before: string, after: string, words: string): { text: string; caret: number } {
  const w = words.trim();
  const lead = w && before && !/\s$/.test(before) ? ' ' : '';
  const tail = w && after && !/^\s/.test(after) ? ' ' : '';
  return { text: before + lead + w + tail + after, caret: (before + lead + w).length };
}

/** The box a mic types into: its text, setting it, and the textarea (for the caret). */
export interface MicBox {
  text(): string;
  set(v: string): void;
  el(): HTMLTextAreaElement | undefined;
}

export interface Mic {
  readonly on: () => boolean;
  readonly label: () => string;
  toggle(): void;
}

const QUIET: Readonly<Partial<Record<DictationError, true>>> = { silence: true };

/** The mic for `box`, or none where the platform can't dictate (a browser, the desktop app, an older phone app). */
export function useMic(shell: ShellContext, box: MicBox, onStart?: () => void): Mic | undefined {
  const d = shell.platform.dictation;
  if (!d) return undefined;
  const [on, setOn] = createSignal(false);
  let stop: (() => void) | undefined;
  let around = { before: '', after: '', last: '' };
  const done = (): void => {
    stop = undefined;
    setOn(false);
  };
  const put = (words: string): void => {
    if (box.text() !== around.last) return stop?.(); // the box changed under it
    const s = spoken(around.before, around.after, words);
    around.last = s.text;
    box.set(s.text);
    queueMicrotask(() => box.el()?.setSelectionRange(s.caret, s.caret));
  };
  onCleanup(() => stop?.());
  return {
    on,
    label: () => shell.t(on() ? 'shell.mic.stop' : 'shell.mic.start'),
    toggle() {
      if (stop) return stop();
      const el = box.el();
      const v = box.text();
      const at = el?.selectionStart ?? v.length;
      around = { before: v.slice(0, at), after: v.slice(el?.selectionEnd ?? at), last: v };
      setOn(true); // at once: the recognizer takes a moment to open
      onStart?.();
      stop = d.start((e) => {
        if (e.state === 'partial' || e.state === 'final') put(e.text);
        if (e.state === 'error') {
          if (e.text) put(e.text);
          const msg = shell.t(`shell.mic.${e.error}`);
          if (QUIET[e.error]) shell.toast.show(msg);
          else shell.toast.error(msg, { duration: e.error === 'blocked' ? 8000 : 4200 });
        }
        if (e.state === 'end' || e.state === 'error') done();
      });
    },
  };
}
