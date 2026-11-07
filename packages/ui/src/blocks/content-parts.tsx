// Small pieces the content blocks share: inline markdown (v1 inlineMd), a path with its folder
// faint and its name strong (v1 pathHtml), a change badge (A/M/D/R), a block's title row with
// its count, and a list folded after its first rows behind "Show all N".
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Button } from '../controls/Button.tsx';
import { Code } from '../content/Code.tsx';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { safeHref, type Inline } from '../content/markdown/ast.ts';
import { parseInline } from '../content/markdown/inline.ts';
import { flag, sub, type PartName } from '../core/props.ts';
import { useBlocks, useBlockT } from './context.tsx';
import { splitPath, type ChangeKind } from './content-util.ts';

type OpenUrl = ((url: string) => void) | undefined;

function inlines(nodes: readonly Inline[], part: PartName, openUrl: OpenUrl): JSX.Element[] {
  return nodes.map((n): JSX.Element => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return <Code part={sub(part, 'code')}>{n.v}</Code>;
      case 'strong': return <strong data-kit="md-strong">{inlines(n.c, part, openUrl)}</strong>;
      case 'em': return <em data-kit="md-em">{inlines(n.c, part, openUrl)}</em>;
      case 'del': return <del data-kit="md-del">{inlines(n.c, part, openUrl)}</del>;
      case 'br': return <br />;
      case 'link': {
        const href = safeHref(n.href);
        if (!href) return <>{inlines(n.c, part, openUrl)}</>;
        const onClick = (e: MouseEvent): void => {
          if (!openUrl || href.startsWith('#')) return;
          e.preventDefault();
          openUrl(href);
        };
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" data-kit="md-link" data-part={sub(part, 'link')} onClick={onClick}>
            {inlines(n.c, part, openUrl)}
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

/** One line of an agent's inline markdown (`code`, **bold**, links): text, never HTML. */
export function InlineMd(props: { readonly source: string; readonly part: PartName }): JSX.Element {
  const ctx = useBlocks();
  const nodes = createMemo(() => parseInline(props.source));
  return <>{inlines(nodes(), props.part, ctx.openUrl)}</>;
}

/** A path on one line: the folder gives way first, then the name ends in `…`. */
export function PathText(props: { readonly path: string; readonly part: PartName }): JSX.Element {
  const parts = (): readonly [string, string] => splitPath(props.path);
  return (
    <span data-kit="cb-path" data-part={props.part} title={props.path}>
      <Show when={parts()[0]}>
        <span data-kit="cb-dir" data-text="control">{parts()[0]}</span>
      </Show>
      <span data-kit="cb-base" data-text="control">{parts()[1]}</span>
    </span>
  );
}

const CHANGE_NAME = { add: 'block.content.added', mod: 'block.content.modified', del: 'block.content.deleted', ren: 'block.content.renamed' } as const;

export function ChangeBadge(props: { readonly mark: string; readonly kind: ChangeKind; readonly part: PartName }): JSX.Element {
  const t = useBlockT();
  return (
    <span data-kit="cb-badge" data-part={props.part} data-change={props.kind} role="img" aria-label={t(CHANGE_NAME[props.kind])} title={t(CHANGE_NAME[props.kind])}>
      {props.mark}
    </span>
  );
}

/** A block's title (content text: it may wrap) with an optional icon and count. */
export function BlockTitle(props: { readonly part: PartName; readonly title: string; readonly count?: number; readonly icon?: IconName }): JSX.Element {
  return (
    <h3 data-kit="cb-title" data-part={props.part}>
      <Show when={props.icon}>{(name) => <Icon name={name()} size="md" tone="muted" />}</Show>
      <span data-kit="cb-title-text">{props.title}</span>
      <Show when={props.count !== undefined}>
        <span data-kit="cb-count" data-text="control">{props.count}</span>
      </Show>
    </h3>
  );
}

/** Past this many rows a list lays out only its rows near the screen (content-visibility). */
const LONG = 200;

export interface FoldedProps<T> {
  readonly items: readonly T[];
  /** rows shown before "Show all" */
  readonly limit: number;
  readonly as: 'ul' | 'ol';
  readonly kit: string;
  readonly part: PartName;
  readonly children: (item: T, i: () => number) => JSX.Element;
}

/** A list that shows its first `limit` rows and folds the rest behind "Show all N". */
export function Folded<T>(props: FoldedProps<T>): JSX.Element {
  const t = useBlockT();
  const [open, setOpen] = createSignal(false);
  const over = (): boolean => props.items.length > props.limit;
  const shown = createMemo(() => (open() || !over() ? props.items : props.items.slice(0, props.limit)));
  return (
    <>
      <Dynamic component={props.as} data-kit={props.kit} data-part={props.part} data-long={flag(shown().length > LONG)}>
        <For each={shown()}>{props.children}</For>
      </Dynamic>
      <Show when={over()}>
        <div data-kit="cb-more" data-part={sub(props.part, 'more')}>
          <Button variant="ghost" size="sm" icon={open() ? 'chevron' : 'expand'} pressed={open()} onClick={() => setOpen(!open())}>
            {open() ? t('block.showLess') : t('block.content.showAll', { n: props.items.length })}
          </Button>
        </div>
      </Show>
    </>
  );
}
