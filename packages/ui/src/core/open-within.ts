// Whether a box has one of its menus open (v1 launcher.css `:has(.open)`): the kit's menus live in a portal, so the
// box can't see them with CSS (and the kit doesn't use :has); their triggers say so with aria-expanded, which this
// watches. Owned by the calling component: unmounting stops it.
import { createSignal, onCleanup, type Accessor } from 'solid-js';

export function useOpenWithin(): { readonly ref: (el: HTMLElement) => void; readonly open: Accessor<boolean> } {
  const [open, setOpen] = createSignal(false);
  let mo: MutationObserver | undefined;
  onCleanup(() => mo?.disconnect());
  return {
    open,
    ref: (el) => {
      const read = (): void => void setOpen(!!el.querySelector('[aria-expanded="true"]'));
      if (typeof MutationObserver === 'undefined') return;
      mo?.disconnect();
      mo = new MutationObserver(read);
      mo.observe(el, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'], childList: true });
      read();
    },
  };
}
