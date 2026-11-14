// The `doc` block (v1 R.doc): a markdown file the agent wrote, as a page: its title, path, length and reading time,
// its opening rendered and fading out into Read all N lines, Copy, Save to My Stuff, Show in folder (when the host can) and Full
// screen. The text is the block's own (kept with the turn), else the host's live read (BlockContext.docText). A
// file that wasn't there says so in one line.
import { Match, Show, Switch, createSignal, type Accessor, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Markdown } from '../content/markdown/Markdown.tsx';
import { Dialog } from '../controls/Dialog.tsx';
import { InlineMd, PathText } from './content-parts.tsx';
import { KeepButton } from './keep-button.tsx';
import { docKeep } from './keep.ts';
import { useBlockT, useBlocks } from './context.tsx';
import { docBody, docPreview, docStats, docTitle } from './rich-doc.ts';
import { useCopy } from './rich-scope.ts';
import { opt, str } from './read.ts';
import type { BlockProps, DocText } from './types.ts';

export function DocBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const path = str(props.block['path']);
  const own = opt(props.block['text']);
  const live: Accessor<DocText> = own !== undefined ? () => ({ kind: 'ready', text: own }) : ctx.docText && path ? ctx.docText(path) : () => ({ kind: 'failed', reason: '' });
  const text = (): string | undefined => {
    const d = live();
    return d.kind === 'ready' ? d.text : undefined;
  };
  const title = (): string => docTitle(str(props.block['title']), text() ?? '', path) || t('block.doc.name');
  const stats = (): { lines: number; minutes: number } | undefined => {
    const x = text();
    return x === undefined ? undefined : docStats(x);
  };
  const preview = (): { source: string; whole: boolean } => docPreview(text() ?? '', title());
  const { copied, copy } = useCopy();
  const [full, setFull] = createSignal(false);
  const onLink = (href: string, e: MouseEvent): void => {
    if (!ctx.openUrl || href.startsWith('#')) return;
    e.preventDefault();
    ctx.openUrl(href);
  };
  return (
    <div data-kit="rb-doc" data-card="" data-part="block.doc" data-missing={live().kind === 'failed' ? '' : undefined}>
      <div data-kit="rb-doc-head">
        <span data-kit="rb-doc-ic" aria-hidden="true">
          <Icon name="file" />
          <i>MD</i>
        </span>
        <div data-kit="rb-doc-name">
          <b>{title()}</b>
          <span>
            <Show when={path}>
              <PathText path={path} part="block.doc.path" />
            </Show>
            <Show when={stats()}>
              {(s) => (
                <>
                  <i>{s().lines === 1 ? t('block.doc.line') : t('block.doc.lines', { n: s().lines })}</i>
                  <i>{t('block.doc.minutes', { n: s().minutes })}</i>
                </>
              )}
            </Show>
          </span>
        </div>
        <Show when={text() !== undefined}>
          <div data-kit="rb-doc-tools">
            <button type="button" data-kit="cb-ghost-xs" title={t('block.doc.copy')} aria-label={t('block.doc.copy')} onClick={() => copy(text() ?? '')}>
              <Icon name={copied() ? 'check' : 'copy'} size="sm" />
            </button>
            <KeepButton keep={docKeep(path, title(), text() ?? '')} part="block.doc.keep" />
            <Show when={ctx.revealFile && path}>
              <button type="button" data-kit="cb-ghost-xs" title={t('block.doc.revealTip')} onClick={() => ctx.revealFile?.(path)}>
                <Icon name="folder" size="sm" />
                <span data-kit="rb-doc-label">{t('block.doc.reveal')}</span>
              </button>
            </Show>
            <button type="button" data-kit="cb-ghost-xs" title={t('block.doc.fullTip')} onClick={() => setFull(true)}>
              <Icon name="expand" size="sm" />
              <span data-kit="rb-doc-label">{t('block.doc.full')}</span>
            </button>
          </div>
        </Show>
      </div>
      <Switch>
        <Match when={live().kind === 'loading'}>
          <p data-kit="rb-doc-gone">{t('block.doc.loading')}</p>
        </Match>
        <Match when={text() === undefined}>
          <p data-kit="rb-doc-gone">
            <Icon name="warn" size="sm" />
            {t('block.doc.gone')}
          </p>
        </Match>
        <Match when={text() !== undefined}>
          <div data-kit="rb-doc-page" data-fits={preview().whole ? '' : undefined} onClick={() => !preview().whole && setFull(true)}>
            <Markdown source={preview().source} onLink={onLink} part="block.doc.text" />
            <Show when={!preview().whole}>
              <button type="button" data-kit="rb-doc-more" onClick={(e) => (e.stopPropagation(), setFull(true))}>
                <Icon name="expand" size="sm" />
                <span>{t('block.doc.readAll', { n: stats()?.lines ?? 0 })}</span>
              </button>
            </Show>
          </div>
        </Match>
      </Switch>
      <Show when={opt(props.block['caption'])}>
        {(c) => (
          <p data-kit="rb-caption">
            <InlineMd source={c()} part="block.doc.caption" />
          </p>
        )}
      </Show>
      <Dialog title={title()} open={full()} onOpenChange={setFull} size="lg" part="block.doc.reader">
        <Markdown source={docBody(text() ?? '')} onLink={onLink} part="block.doc.full" />
      </Dialog>
    </div>
  );
}
