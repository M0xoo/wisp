// Part of the css rule: design/layout.md §6 ("nothing wraps that shouldn't"). In kit CSS:
//   - `flex-wrap: wrap` (or wrap-reverse, or a `flex-flow` that wraps) only inside the `Wrap` layout:
//     a bar collapses in a declared order, it never wraps its row (§2, §5);
//   - control text never wraps: no `white-space: normal | pre-wrap | pre-line | break-spaces` and no
//     `text-wrap: wrap | balance | pretty` on a control part (§1).
// A rule is "inside Wrap" when a selector it sits under names `[data-kit='wrap…']` or a `data-part`
// ending in `wrap`. Control parts are `[data-text='control']` and the kit's control components.

import type { CssDecl } from '../core/css-scan.ts';

const WRAP_SCOPE = /\[data-kit=['"]?wrap\b|\[data-part=['"]?[\w.-]*wrap['"]?\]/;
const CONTROL_SCOPE = /\[data-text=['"]?control\b|\[data-kit=['"]?(button|icon-button|pill|chip|tab|tabs-trigger|menu-item|list-row-title|toolbar|bar|badge|breadcrumb|time|count)\b/;
const WRAPS_FLEX = /(^|\s)wrap(-reverse)?(\s|$)/;
const WRAPS_TEXT = /^(normal|pre-wrap|pre-line|break-spaces)\b/;
const WRAPS_TEXT_WRAP = /^(wrap|balance|pretty)\b/;

export interface LayoutProblem {
  line: number;
  message: string;
}

function selectors(d: CssDecl): string {
  return d.within.filter((p) => !p.startsWith('@')).join(' ');
}

export function layoutProblems(decls: readonly CssDecl[]): LayoutProblem[] {
  const out: LayoutProblem[] = [];
  for (const d of decls) {
    const prop = d.prop.toLowerCase();
    const value = d.value.toLowerCase().trim();
    const where = selectors(d);
    if ((prop === 'flex-wrap' || prop === 'flex-flow') && WRAPS_FLEX.test(value) && !WRAP_SCOPE.test(where)) {
      out.push({ line: d.line, message: `${prop}: ${value} outside Wrap: a bar collapses its items, it never wraps its row (design/layout.md §2)` });
    }
    const textWraps = (prop === 'white-space' && WRAPS_TEXT.test(value)) || (prop === 'text-wrap' && WRAPS_TEXT_WRAP.test(value));
    if (textWraps && CONTROL_SCOPE.test(where)) {
      out.push({ line: d.line, message: `${prop}: ${value} on a control part: control text is nowrap + ellipsis (design/layout.md §1)` });
    }
  }
  return out;
}
