// Grows a textarea with its text up to a cap, then it scrolls. Shared by TextArea and Composer.

/** Fit `el` to its content, between `minRows` and `maxRows` lines. */
export function fitTextarea(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
  const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const min = minRows * line + chrome;
  const max = maxRows * line + chrome;
  // Measure from the smallest height so it can shrink as well as grow.
  el.style.height = `${min}px`;
  const want = Math.min(Math.max(el.scrollHeight, min), max);
  el.style.height = `${want}px`;
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}
