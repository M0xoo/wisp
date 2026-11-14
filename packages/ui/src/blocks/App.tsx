// The `app` block (v1 app-frame.js appBlock): a small interactive page the agent wrote, run in a sandboxed frame
// (scripts only: no network, no wisp, no files) in wisp's colours. Its height follows its content (80–1000 px), what
// it saves with wisp.save() comes back (BlockContext.appState, else for this page only), Start over clears it, and
// text it offers to send shows in a strip: Send (a reply), Edit first (the reply box), or Copy; Dismiss.
import { Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { useBlockT, useBlocks } from './context.tsx';
import { opt, num } from './read.ts';
import { APP_HEIGHT, APP_MAX_SEND, APP_TOKENS, appDoc, appProblem, keepable, readAppMessage, type Scheme } from './rich-app-doc.ts';
import { CantShow } from './rich-ui.tsx';
import { useTimeout } from './rich-scope.ts';
import type { BlockProps } from './types.ts';

/** wisp's colours now, for the app's own page. */
function theme(): { vars: Record<string, string>; scheme: Scheme } {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const k of APP_TOKENS) vars[k] = cs.getPropertyValue(k).trim();
  const attr = root.getAttribute('data-theme');
  const scheme: Scheme = attr === 'dark' || attr === 'light' ? attr : globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return { vars, scheme };
}

export function AppBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const title = opt(props.block['title']);
  const problem = appProblem(props.block['html']);
  if (problem)
    return (
      <CantShow part="block.app.cant">{`${t('block.app.cant', { title: title ?? t('block.app.frame') })} ${problem === 'noHtml' ? t('block.app.noHtml') : t('block.app.tooBig', { kb: 200 })}`}</CantShow>
    );
  const key = `app:${props.index}`;
  let mem: unknown = ctx.appState?.get(key) ?? props.block['state'] ?? null;
  const [height, setHeight] = createSignal(Math.min(Math.max(num(props.block['height']) ?? 320, APP_HEIGHT[0]), APP_HEIGHT[1]));
  const [scrolls, setScrolls] = createSignal(false);
  const [offer, setOffer] = createSignal('');
  const [doc, setDoc] = createSignal('');
  let frame: HTMLIFrameElement | undefined;
  const mount = (state: unknown): void => {
    const th = theme();
    setDoc(
      appDoc(String(props.block['html']), {
        vars: th.vars,
        scheme: th.scheme,
        state,
      }),
    );
  };
  const later = useTimeout();
  // kept at once for this page; sent to the host 400 ms after the last save (v1), not a write per keystroke
  const save = (state: unknown): void => {
    if (!keepable(state)) return;
    mem = state;
    later.start(400, () => ctx.appState?.set(key, mem));
  };
  // the page is whole before the frame is made: a frame born with an empty srcdoc keeps it in Chrome
  mount(mem);
  onMount(() => {
    const on = (e: MessageEvent): void => {
      if (!frame || e.source !== frame.contentWindow) return;
      const m = readAppMessage(e.data);
      if (!m) return;
      if (m.type === 'height') {
        setHeight(Math.min(Math.max(Math.round(m.h), APP_HEIGHT[0]), APP_HEIGHT[1]));
        setScrolls(m.h > APP_HEIGHT[1]);
      } else if (m.type === 'save') save(m.state);
      else if (m.text.trim()) setOffer(m.text.slice(0, APP_MAX_SEND));
    };
    globalThis.addEventListener('message', on);
    onCleanup(() => globalThis.removeEventListener('message', on));
  });
  const done = (): void => void setOffer('');
  return (
    <div data-kit="rb-app" data-card="" data-part="block.app">
      <div data-kit="rb-app-head">
        <Icon name="spark" size="sm" />
        <span data-kit="rb-app-title">{title ?? t('block.app.name')}</span>
        <span data-kit="rb-pv-tag" title={t('block.app.sandboxTip')}>
          <Icon name="lock" size="sm" />
          {t('block.app.sandboxed')}
        </span>
        <button
          type="button"
          data-kit="rb-pv-btn"
          title={t('block.app.reset')}
          aria-label={t('block.app.reset')}
          onClick={() => {
            save(null);
            done();
            mount(null);
          }}
        >
          <Icon name="rerun" size="sm" />
        </button>
      </div>
      <div data-kit="rb-app-box" data-scrolls={scrolls() ? '' : undefined} style={{ '--k-app-h': `${height()}px` }}>
        <iframe ref={(el) => (frame = el)} sandbox="allow-scripts" title={title ?? t('block.app.frame')} srcdoc={doc()} />
      </div>
      <Show when={offer()}>
        <div data-kit="rb-app-send" data-part="block.app.offer">
          <span data-kit="rb-app-lbl">
            <Icon name="send" size="sm" />
            {ctx.reply ? t('block.app.sendTo') : t('block.app.sendTask')}
          </span>
          <div data-kit="rb-app-txt">{offer()}</div>
          <div data-kit="rb-app-btns">
            <Show when={ctx.reply}>
              <button type="button" data-kit="rb-btn" data-primary="" onClick={() => (ctx.reply?.(offer()), done())}>
                {t('block.app.send')}
              </button>
            </Show>
            <Show when={ctx.draft}>
              <button type="button" data-kit="rb-btn" data-primary={ctx.reply ? undefined : ''} onClick={() => (ctx.draft?.(offer()), done())}>
                {t('block.app.edit')}
              </button>
            </Show>
            <Show when={!ctx.reply && !ctx.draft}>
              <button type="button" data-kit="rb-btn" data-primary="" onClick={() => (void globalThis.navigator?.clipboard?.writeText(offer()).catch(() => {}), done())}>
                {t('block.app.copy')}
              </button>
            </Show>
            <button type="button" data-kit="rb-btn" onClick={done}>
              {t('block.app.dismiss')}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
