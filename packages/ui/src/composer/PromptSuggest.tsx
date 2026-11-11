// The @ and / menus of a prompt box (v1 composer.js mention and slash menus): what the host offers for what's typed
// after the trigger, over the box (the reply box) or under it (New task), ↑/↓ to move, ↵ or Tab to pick, Esc to close.
// The host owns the list and what a pick does; the kit draws it and routes the keys.
import { Show, type JSX } from 'solid-js';
import { SuggestList, suggestKey, type SuggestItem } from './SuggestList.tsx';

export interface PromptSuggest {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SuggestItem[];
  readonly active: number;
  readonly onPick: (value: string) => void;
  readonly onActive: (index: number) => void;
  readonly onClose: () => void;
}

/** A key in the box while the menu is open: true when the menu took it (the box does nothing more). */
export function suggestKeyDown(s: PromptSuggest | undefined, e: KeyboardEvent): boolean {
  if (!s || s.items.length === 0) return false;
  const r = suggestKey(e, s.items.length, s.active);
  if (!r) return false;
  e.preventDefault();
  if (r.t === 'move') s.onActive(r.to);
  else if (r.t === 'pick') {
    const it = s.items[s.active];
    if (it) s.onPick(it.value);
  } else s.onClose();
  return true;
}

export function PromptSuggestList(props: { readonly suggest: PromptSuggest | undefined; readonly place: 'above' | 'below' }): JSX.Element {
  return (
    <Show when={props.suggest && props.suggest.items.length > 0 && props.suggest}>
      {(s) => (
        <div data-kit="prompt-suggest" data-place={props.place}>
          <SuggestList id={s().id} aria-label={s().label} items={s().items} active={s().active} onPick={s().onPick} onActive={s().onActive} part="composer.suggest" />
        </div>
      )}
    </Show>
  );
}

/** A prompt box as a drop target for files (v1 attachments.js): it lights up while files are over it; text drops
 * stay the browser's (into the box). Returns the box's handlers; none when the host takes no files. */
export function dropHandlers(onFiles: () => ((files: File[]) => void) | undefined, setOver: (on: boolean) => void): {
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
} {
  const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
  return {
    onDragOver: (e) => {
      if (!onFiles() || !hasFiles(e)) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e) => {
      if (!(e.currentTarget as Element).contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e) => {
      const take = onFiles();
      setOver(false);
      if (!take || !hasFiles(e)) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) take(files);
    },
  };
}
