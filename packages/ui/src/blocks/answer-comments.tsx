// Comments on an answer (v1 comments.js): select words in a block and the bubble over them says Comment, or hover a
// block and its button (top right, half over its edge) does; the card opens beside what it's about, takes the note
// (⌘↵ keeps it, Esc lets it go) and hands it to the host, which keeps it for the next follow-up. What waits on the
// answer shows where it is: its words lit with their number after them, a whole block ringed with its number in the
// corner. Only wisp's own little nodes are drawn; the block is left as it is.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { CommentCard } from '../app/Comments.tsx';
import { Icon } from '../content/Icon.tsx';
import { styleOf } from '../core/props.ts';
import { useBlockT } from './context.tsx';
import { locate, quoteOf } from './comment-range.ts';
import { useFrame, useTimeout } from './rich-scope.ts';
import type { AnswerBlock, AnswerCommentAt, AnswerCommentMark, AnswerComments } from './types.ts';

// Blocks that are buttons already: commenting on them means nothing (v1 SKIP)
const SKIP = new Set(['next', 'actions', 'question', 'blocked', 'spell']);
export const commentable = (type: string): boolean => !SKIP.has(type);

/** What the card sits beside: the block's button, or the words picked (their range, kept past the selection). */
type Anchor = { readonly el: Element } | { readonly range: Range };
interface Draft {
  readonly at: AnswerCommentAt;
  readonly anchor: Anchor;
}

export interface Commenting {
  readonly c: AnswerComments;
  readonly draft: () => Draft | undefined;
  readonly open: (at: AnswerCommentAt, anchor: Anchor) => void;
  readonly close: () => void;
}

const HL = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
// every answer's lit words, under one highlight (an answer per turn: each keeps its own ranges here)
const lit = new Map<object, Range[]>();
function paintLit(): void {
  if (HL()) CSS.highlights.set('wisp-comment', new Highlight(...[...lit.values()].flat()));
}

export function createCommenting(c: AnswerComments): Commenting {
  const [draft, setDraft] = createSignal<Draft | undefined>(undefined);
  return { c, draft, open: (at, anchor) => setDraft({ at, anchor }), close: () => setDraft(undefined) };
}

// the elements a selection reads a line break between (sel.toString() gives "a\n\nb" for <p>a</p><p>b</p>)
const BREAK = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th, tr, dd, dt, div';

/** A block's text nodes, wisp's own marks and buttons left out; a break (null) between two that sit in different
 * paragraphs, cells or items, read as a space as the selection reads it. */
function textsOf(holder: Element): (Text | null)[] {
  const out: (Text | null)[] = [];
  let last: Element | null | undefined;
  const walk = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[data-cmt-own]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const at = n.parentElement?.closest(BREAK);
    if (last !== undefined && at !== last) out.push(null);
    last = at;
    out.push(n as Text);
  }
  return out;
}

function rangeOf(holder: Element, quote: string): Range | undefined {
  const nodes = textsOf(holder);
  // a quote kept cut short (quoteOf) is found by what it kept
  const at = locate(
    nodes.map((n) => (n ? n.data : ' ')),
    quote.endsWith('…') ? quote.slice(0, -1) : quote,
  );
  const a = at && nodes[at.from[0]];
  const b = at && nodes[at.to[0]];
  if (!at || !a || !b) return undefined;
  const r = document.createRange();
  try {
    r.setStart(a, at.from[1]);
    r.setEnd(b, at.to[1]);
  } catch {
    return undefined;
  }
  return r;
}

type Tag = { readonly n: number; readonly x: number; readonly y: number; readonly note: string };

/** Where each text comment's words are now in `holder`: lit, its number raised over their end like a footnote. Measured
 * a frame after the marks change, and again whenever the block's size does. */
function useWordMarks(holderOf: () => Element | undefined, words: () => readonly AnswerCommentMark[]): () => readonly Tag[] {
  const [tags, setTags] = createSignal<readonly Tag[]>([]);
  const key = {};
  const frame = useFrame();
  const measure = (): void => {
    const holder = holderOf();
    if (!holder || (words().length === 0 && !lit.has(key) && tags().length === 0)) return;
    const box = holder.getBoundingClientRect();
    const ranges: Range[] = [];
    const out: Tag[] = [];
    for (const m of words()) {
      const r = rangeOf(holder, m.quote ?? '');
      if (!r) continue;
      ranges.push(r);
      const rects = r.getClientRects();
      const last = rects[rects.length - 1];
      // absolute children start inside the block's border
      if (last) out.push({ n: m.n, x: last.right - box.left - holder.clientLeft - 4, y: last.top - box.top - holder.clientTop - 12, note: m.note });
    }
    setTags(out);
    if (ranges.length) lit.set(key, ranges);
    else lit.delete(key);
    paintLit();
  };
  // only a block with words waiting on it is watched for a new size (an answer has many blocks, few comments)
  let ro: ResizeObserver | undefined;
  createEffect(
    on(words, (w) => {
      frame(measure);
      const holder = holderOf();
      if (w.length > 0 && !ro && holder && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => frame(measure));
        ro.observe(holder);
      } else if (w.length === 0) {
        ro?.disconnect();
        ro = undefined;
      }
    }),
  );
  onCleanup(() => {
    ro?.disconnect();
    lit.delete(key);
    paintLit();
  });
  return tags;
}

/** On one block: its Comment button, the numbers of what waits on it, the ring round it when the whole block is. */
export function BlockComment(props: { readonly cm: Commenting; readonly i: number; readonly block: AnswerBlock }): JSX.Element {
  const t = useBlockT();
  let btn: HTMLButtonElement | undefined;
  const mine = createMemo(() => props.cm.c.marks().filter((m) => m.i === props.i));
  const whole = createMemo(() => mine().filter((m) => !m.quote));
  const words = createMemo(() => mine().filter((m) => m.quote));
  const tags = useWordMarks(() => btn?.parentElement ?? undefined, words);
  const drafting = (): boolean => props.cm.draft()?.at.i === props.i && props.cm.draft()?.at.quote === undefined;
  return (
    <>
      <button
        ref={(el) => (btn = el)}
        type="button"
        data-kit="cmt-add"
        data-cmt-own=""
        data-part="answer.block.comment"
        data-on={drafting() ? '' : undefined}
        title={t('block.comment.on')}
        aria-label={t('block.comment.on')}
        onClick={(e) => {
          e.stopPropagation();
          props.cm.open({ i: props.i, block: props.block }, { el: e.currentTarget });
        }}
      >
        <Icon name="comment" size="sm" />
      </button>
      <Show when={whole().length > 0 || drafting()}>
        <span data-kit="cmt-ring" data-cmt-own="" />
      </Show>
      <Show when={whole().length > 0}>
        <span data-kit="cmt-corners" data-cmt-own="">
          <For each={whole()}>
            {(m) => (
              <span data-kit="cmt-mark" data-part="answer.comment.mark" title={m.note || t('block.comment')} aria-label={t('block.comment.mark', { n: m.n })}>
                {m.n}
              </span>
            )}
          </For>
        </span>
      </Show>
      <For each={tags()}>
        {(m) => (
          <span
            data-kit="cmt-mark"
            data-at="tag"
            data-cmt-own=""
            data-part="answer.comment.mark"
            title={m.note || t('block.comment')}
            aria-label={t('block.comment.mark', { n: m.n })}
            style={styleOf({ '--cmt-x': `${m.x}px`, '--cmt-y': `${m.y}px` })}
          >
            {m.n}
          </span>
        )}
      </For>
    </>
  );
}

type Picked = { readonly at: AnswerCommentAt; readonly range: Range; readonly x: number; readonly y: number; readonly under: boolean };

/** The words picked, when they're in one block of this answer (`root`) that takes comments, and where the bubble goes. */
function pickOf(sel: Selection | null, root: HTMLElement | undefined, blocks: readonly unknown[], coarse: boolean): Picked | undefined {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return undefined;
  const range = sel.getRangeAt(0);
  const holderOf = (n: Node): Element | null | undefined => (n instanceof Element ? n : n.parentElement)?.closest('[data-kit="answer-block"]');
  const a = holderOf(range.startContainer);
  const quote = quoteOf(sel.toString());
  if (!a || a !== holderOf(range.endContainer) || a.parentElement !== root || !quote) return undefined;
  if (range.startContainer.parentElement?.closest('input, textarea, [data-cmt-own]')) return undefined;
  const i = Number((a as HTMLElement).dataset['i']);
  const raw = blocks[i] as AnswerBlock | undefined;
  if (!raw || typeof raw.type !== 'string' || !commentable(raw.type)) return undefined;
  const r = range.getBoundingClientRect();
  // over the words; on a phone under them, clear of the system's own copy menu
  const under = coarse || r.top - 40 < 56;
  return { at: { i, block: raw, quote }, range: range.cloneRange(), x: r.left + r.width / 2, y: under ? r.bottom + 8 : r.top - 8, under };
}

// one selectionchange listener for every answer on the page, however many turns show
const onSelection = new Set<() => void>();
const fanOut = (): void => {
  for (const f of onSelection) f();
};
function watchSelection(f: () => void): void {
  if (onSelection.size === 0) document.addEventListener('selectionchange', fanOut);
  onSelection.add(f);
  onCleanup(() => {
    onSelection.delete(f);
    if (onSelection.size === 0) document.removeEventListener('selectionchange', fanOut);
  });
}

const rectOf = (a: Anchor): DOMRect => ('el' in a ? a.el.getBoundingClientRect() : a.range.getBoundingClientRect());

/** The answer's selection bubble and the open card (both over the page, beside what they're about). */
export function CommentLayer(props: { readonly cm: Commenting; readonly root: () => HTMLElement | undefined; readonly blocks: readonly unknown[] }): JSX.Element {
  const t = useBlockT();
  const [picked, setPicked] = createSignal<Picked | undefined>(undefined);
  const settle = useTimeout();
  const coarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const read = (): void => void setPicked(pickOf(getSelection(), props.root(), props.blocks, coarse()));
  const onSel = (): void => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) {
      settle.stop();
      setPicked(undefined);
      return;
    }
    // wait for the hand to settle (dragging, a phone's handles) before offering anything
    settle.start(coarse() ? 380 : 160, read);
  };
  onMount(() => watchSelection(onSel));
  // the bubble follows its words as the page scrolls (v1)
  createEffect(() => {
    if (!picked()) return;
    addEventListener('scroll', read, true);
    onCleanup(() => removeEventListener('scroll', read, true));
  });
  return (
    <>
      <Show when={picked()}>
        {(p) => (
          <Portal>
            <div data-kit="cmt-bubble" data-part="answer.comment.bubble" role="toolbar" data-under={p().under ? '' : undefined} style={styleOf({ '--cmt-x': `${p().x}px`, '--cmt-y': `${p().y}px` })}>
              <button
                type="button"
                // pressing it must not clear the selection under it
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const cur = picked();
                  if (!cur) return;
                  props.cm.open(cur.at, { range: cur.range });
                  setPicked(undefined);
                  getSelection()?.removeAllRanges();
                }}
              >
                <Icon name="comment" size="sm" />
                <span>{t('block.comment')}</span>
              </button>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={props.cm.draft()} keyed>
        {(d) => <CommentFloat cm={props.cm} draft={d} />}
      </Show>
    </>
  );
}

/** The card, beside its anchor (under it, above when there's no room), kept there as the page scrolls. */
function CommentFloat(props: { readonly cm: Commenting; readonly draft: Draft }): JSX.Element {
  const t = useBlockT();
  const [note, setNote] = createSignal('');
  const [pos, setPos] = createSignal({ x: 8, y: 8 });
  let box: HTMLDivElement | undefined;
  const place = (): void => {
    if (!box) return;
    const a = rectOf(props.draft.anchor);
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const below = a.bottom + 10 + h < innerHeight - 8;
    setPos({ x: Math.max(8, Math.min(innerWidth - w - 8, a.left + a.width / 2 - w / 2)), y: below ? a.bottom + 10 : Math.max(8, a.top - h - 10) });
  };
  const away = (e: PointerEvent): void => {
    if (box && e.target instanceof Node && !box.contains(e.target)) props.cm.close();
  };
  onMount(() => {
    place();
    // the words stay lit while the card is open
    if ('range' in props.draft.anchor && HL()) CSS.highlights.set('wisp-comment-draft', new Highlight(props.draft.anchor.range));
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    document.addEventListener('pointerdown', away, true);
    onCleanup(() => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
      document.removeEventListener('pointerdown', away, true);
      if (HL()) CSS.highlights.delete('wisp-comment-draft');
    });
  });
  const at = props.draft.at;
  return (
    <Portal>
      <div ref={(el) => (box = el)} data-kit="cmt-float" data-part="answer.comment.card" role="dialog" aria-label={t('block.comment.mark', { n: props.cm.c.next() })} style={styleOf({ '--cmt-x': `${pos().x}px`, '--cmt-y': `${pos().y}px` })}>
        <CommentCard
          n={props.cm.c.next()}
          where={props.cm.c.label(at)}
          code={at.quote?.replace(/\s+/g, ' ') ?? ''}
          value={note()}
          placeholder={t(at.quote ? 'block.comment.text' : 'block.comment.block')}
          onInput={setNote}
          onSave={() => {
            if (!note().trim()) return;
            props.cm.c.add(at, note().trim());
            props.cm.close();
          }}
          onCancel={() => props.cm.close()}
          labels={{ save: t('block.comment.save'), cancel: t('block.comment.cancel'), hint: t('block.comment.hint') }}
        />
      </div>
    </Portal>
  );
}
