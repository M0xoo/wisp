// Markdown: renders the parsed tree with Solid elements, never innerHTML, so the source can hold
// anything (`<script>`, `<img onerror>`) and it shows as text. Blocks that didn't change keep
// their DOM nodes while the source grows (a streaming answer), so nothing flickers or replays.
import { Dynamic } from 'solid-js/web';
import { createMemo, Index, type Accessor, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../../core/props.ts';
import { Code } from '../Code.tsx';
import type { Block, Inline, ListItem } from './ast.ts';
import { parseMarkdown } from './block.ts';

export interface MarkdownProps extends KitProps {
  readonly source: string;
  /** Called on a link click; may preventDefault to open it in-app. */
  readonly onLink?: (href: string, event: MouseEvent) => void;
  /** The heading element `#` maps to (default 3, so an answer's headings sit under the page's). */
  readonly headingBase?: 1 | 2 | 3 | 4;
}

interface Ctx {
  readonly part: PartName;
  readonly base: number;
  readonly onLink: (href: string, event: MouseEvent) => void;
}

function inlines(nodes: readonly Inline[], ctx: Ctx): JSX.Element[] {
  return nodes.map((n): JSX.Element => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return <Code part={sub(ctx.part, 'code')}>{n.v}</Code>;
      case 'strong': return <strong data-kit="md-strong">{inlines(n.c, ctx)}</strong>;
      case 'em': return <em data-kit="md-em">{inlines(n.c, ctx)}</em>;
      case 'del': return <del data-kit="md-del">{inlines(n.c, ctx)}</del>;
      case 'br': return <br />;
      case 'link': {
        const local = n.href.startsWith('#');
        return (
          <a
            href={n.href}
            title={n.title ?? undefined}
            target={local ? undefined : '_blank'}
            rel={local ? undefined : 'noopener noreferrer'}
            onClick={(e) => ctx.onLink(n.href, e)}
            data-kit="md-link"
            data-part={sub(ctx.part, 'link')}
          >
            {inlines(n.c, ctx)}
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

function item(it: ListItem, ctx: Ctx, tight: boolean): JSX.Element {
  return (
    <li data-kit="md-li" data-task={it.task === null ? undefined : it.task ? 'done' : 'open'}>
      {it.task === null ? null : <input type="checkbox" checked={it.task} disabled data-kit="md-task" />}
      {blocks(it.c, ctx, tight)}
    </li>
  );
}

function table(b: Extract<Block, { t: 'table' }>, ctx: Ctx): JSX.Element {
  const cell = (tag: 'th' | 'td', c: readonly Inline[], k: number): JSX.Element => (
    <Dynamic component={tag} data-kit={`md-${tag}`} data-align={b.align[k] ?? undefined}>
      {inlines(c, ctx)}
    </Dynamic>
  );
  return (
    <div data-kit="md-table-wrap" data-part={sub(ctx.part, 'table')}>
      <table data-kit="md-table">
        <thead>
          <tr>{b.head.map((c, k) => cell('th', c, k))}</tr>
        </thead>
        <tbody>
          {b.rows.map((row) => (
            <tr>{row.map((c, k) => cell('td', c, k))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function block(b: Block, ctx: Ctx, tight: boolean): JSX.Element {
  switch (b.t) {
    case 'heading': {
      const level = Math.min(6, b.level + ctx.base - 1);
      return <Dynamic component={`h${level}`} data-kit="md-heading" data-level={b.level}>{inlines(b.c, ctx)}</Dynamic>;
    }
    // A tight list's paragraphs are bare text in their items, as GFM renders them.
    case 'paragraph': return tight ? <>{inlines(b.c, ctx)}</> : <p data-kit="md-p">{inlines(b.c, ctx)}</p>;
    case 'code': return <Code block lang={b.lang} part={sub(ctx.part, 'code-block')}>{b.v}</Code>;
    case 'list': {
      const items = b.items.map((it) => item(it, ctx, b.tight));
      return b.ordered ? (
        <ol data-kit="md-list" start={b.start === 1 ? undefined : b.start} data-tight={b.tight ? '' : undefined}>{items}</ol>
      ) : (
        <ul data-kit="md-list" data-tight={b.tight ? '' : undefined}>{items}</ul>
      );
    }
    case 'quote': return <blockquote data-kit="md-quote">{blocks(b.c, ctx, false)}</blockquote>;
    case 'table': return table(b, ctx);
    case 'hr': return <hr data-kit="md-hr" />;
    default: {
      const never: never = b;
      return never;
    }
  }
}

function blocks(list: readonly Block[], ctx: Ctx, tight: boolean): JSX.Element[] {
  return list.map((b) => block(b, ctx, tight));
}

/** Two parses of the same text give equal trees; compare by content so unchanged blocks stay put. */
const sameBlock = (a: Block, b: Block): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

function TopBlock(props: { readonly block: Accessor<Block>; readonly ctx: Ctx }): JSX.Element {
  const stable = createMemo(() => props.block(), undefined, { equals: sameBlock });
  return <>{block(stable(), props.ctx, false)}</>;
}

export function Markdown(props: MarkdownProps): JSX.Element {
  const tree = createMemo(() => parseMarkdown(props.source));
  const ctx: Ctx = {
    get part() {
      return props.part ?? 'ui.markdown';
    },
    get base() {
      return props.headingBase ?? 3;
    },
    onLink: (href, e) => props.onLink?.(href, e),
  };
  return (
    <div id={props.id} data-kit="markdown" data-part={props.part ?? 'ui.markdown'}>
      <Index each={tree()}>{(b) => <TopBlock block={b} ctx={ctx} />}</Index>
    </div>
  );
}
