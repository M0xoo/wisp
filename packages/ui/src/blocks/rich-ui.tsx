// Small pieces the rich blocks share: inline markdown for notes and labels (v1 inlineMd), a block's
// title, the calm line a block shows when it can't, and a link that leaves wisp through the host.
import { Show, type JSX } from 'solid-js';
import type { PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import type { Inline } from '../content/markdown/ast.ts';
import { safeHref } from '../content/markdown/ast.ts';
import { parseInline } from '../content/markdown/inline.ts';
import { useBlocks } from './context.tsx';

function inlines(nodes: readonly Inline[], open: ((url: string) => void) | undefined): JSX.Element[] {
  return nodes.map((n): JSX.Element => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return <code data-kit="code">{n.v}</code>;
      case 'strong': return <strong data-kit="md-strong">{inlines(n.c, open)}</strong>;
      case 'em': return <em data-kit="md-em">{inlines(n.c, open)}</em>;
      case 'del': return <del data-kit="md-del">{inlines(n.c, open)}</del>;
      case 'br': return <br />;
      case 'link': {
        const href = safeHref(n.href);
        if (href === undefined) return <>{inlines(n.c, open)}</>;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" data-kit="md-link" onClick={(e) => outClick(e, href, open)}>
            {inlines(n.c, open)}
          </a>
        );
      }
      default: {
        const never: never = n;
        return never;
      }
    }
  });
}

/** A short piece of markdown (a note, a caption, a node's label): inline only, rendered as text. */
export function InlineMd(props: { readonly source: string }): JSX.Element {
  const ctx = useBlocks();
  return <>{inlines(parseInline(props.source), ctx.openUrl)}</>;
}

/** A click on a link out: the host opens it when it can (the desktop app, a phone), else the browser does. */
export function outClick(e: MouseEvent, url: string, open: ((url: string) => void) | undefined): void {
  if (!open || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  open(url);
}

/** A link that leaves wisp, as text (with an icon) or icon-only (then `label` names it). */
export function OutLink(props: {
  readonly href: string;
  readonly part: PartName;
  readonly icon?: IconName;
  readonly label: string;
  readonly title?: string;
  readonly iconOnly?: boolean;
}): JSX.Element {
  const ctx = useBlocks();
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      title={props.title ?? props.label}
      aria-label={props.iconOnly ? props.label : undefined}
      data-kit="rb-out"
      data-icon-only={props.iconOnly ? '' : undefined}
      data-part={props.part}
      onClick={(e) => outClick(e, props.href, ctx.openUrl)}
    >
      <Icon name={props.icon ?? 'external'} size="sm" />
      <Show when={!props.iconOnly}>
        <span data-text="control">{props.label}</span>
      </Show>
    </a>
  );
}

/** A block's title line (v1 h3.b-title). */
export function BlockTitle(props: { readonly part: PartName; readonly icon?: IconName; readonly children: JSX.Element }): JSX.Element {
  return (
    <h3 data-kit="rb-title" data-part={props.part}>
      <Show when={props.icon}>{(name) => <Icon name={name()} size="md" tone="muted" />}</Show>
      <span data-kit="rb-title-text">{props.children}</span>
    </h3>
  );
}

/** What a block says when it can't show what it holds: one calm line, never an error box. */
export function CantShow(props: { readonly part: PartName; readonly children: JSX.Element }): JSX.Element {
  return (
    <div data-kit="rb-cant" data-part={props.part} role="note">
      <Icon name="warn" size="md" tone="warn" />
      <span data-kit="rb-cant-text">{props.children}</span>
    </div>
  );
}
