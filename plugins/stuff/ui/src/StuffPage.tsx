// My Stuff (v1 web/js/features/stuff.js, design/v1-reference/stuff): what you and your agents kept. A search
// over titles, notes, #tags and tasks; the kinds as chips; grouped by time (Today, This week, months) or by
// task; cards with their kind, title and facts, each with its menu (open or launch, copy, download, star,
// the task it came from, show in folder, remove). Add files drops them here. The rows are the peer's
// `stuff.item` view rows on the `stuff` topic; every write shows at once.
import { createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { entityKey, ownerOf, type EntityKey, type PluginClient, type SessionId } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Card, EmptyState, Icon, Inline, Input, Menu, Stack, Text, Wrap } from '@wisp/ui';
import { itemActions, type ActionId } from './actions.ts';
import { launchApp, publishApp, publishTargets, removeItem, revealItem, stopApp, unpublishApp, updateItem } from './commands.ts';
import { stuffState } from './state.ts';
import { useEntries, type Entry } from './items.ts';
import { kindOf } from './kinds.ts';
import { cardMeta, groupItems, kindChips, shownItems, when, type KindFilter } from './model.ts';
import { TOPIC } from './types.ts';

/** The actions this page carries out; the rest (pins, edit) live where they're done. */
const HERE: ReadonlySet<ActionId> = new Set(['open', 'stop', 'publish', 'pubcopy', 'pubopen', 'update', 'unpublish', 'copy', 'download', 'star', 'task', 'folder', 'remove']);

/** a link without its scheme, as v1 shows it */
const bare = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

const fileUrl = (e: Entry): string => `/api/stuff/${encodeURIComponent(e.it.id)}/file`;

export default function StuffPage(props: { readonly client: PluginClient }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const t = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const scope = c.scope.child('stuff-page');
  onCleanup(() => scope.dispose());
  c.watch(c.home, TOPIC, scope);
  const entries = useEntries(c);
  // where an app can be published: the grids this computer is on (none: no Publish)
  const st = stuffState(c);
  c.run(publishTargets, { peer: c.home }).then(
    (ts) => st.setPublishTo(ts.map((x) => x.host).filter(Boolean)),
    () => {},
  );
  const [q, setQ] = createSignal('');
  const [kind, setKind] = createSignal<KindFilter>('all');
  const byKey = createMemo(() => new Map(entries().map((e) => [e.it.id, e])));
  const filter = () => ({ query: q(), kind: kind(), starred: false });
  const chips = createMemo(() => kindChips(entries().map((e) => e.it), filter(), t));
  const shown = createMemo(() => shownItems(entries().map((e) => e.it), { ...filter(), kind: chips().kind }, t));
  const groups = createMemo(() =>
    groupItems(shown(), 'time', {
      t,
      now: Date.now(),
      task: () => undefined,
      month: (at, withYear) => new Date(at).toLocaleDateString(undefined, withYear ? { month: 'long', year: 'numeric' } : { month: 'long' }),
    }),
  );
  const quiet = (p: Promise<unknown>): void => {
    p.catch(() => {}); // the shell's onError shows the rollback toast
  };

  const run = (e: Entry, id: ActionId): void => {
    const key = e.key;
    const args = { key, id: e.it.id };
    switch (id) {
      case 'open':
        if (e.it.kind === 'app') {
          c.run(launchApp, args).then((l) => window.open(l.url, '_blank', 'noopener'), () => {});
        } else window.open(e.it.kind === 'link' && e.it.url ? e.it.url : fileUrl(e), '_blank', 'noopener');
        return;
      case 'stop':
        return quiet(c.run(stopApp, args));
      // Publish (again): a link anyone can open on your grid; its row says publishing until the grid answers
      case 'publish':
      case 'update': {
        const again = !!e.it.published;
        c.run(publishApp, args).then(
          (next) => {
            const url = next.published?.url;
            if (!url) return;
            void shell.platform.copy(url).then((copied) =>
              shell.toast.success(t(again ? 'stuff.page.updated' : 'stuff.page.published', { at: bare(url) }), { ...(copied && { description: t('stuff.page.linkCopied') }), action: { label: t('stuff.page.openLink'), onClick: () => window.open(url, '_blank', 'noopener') } }),
            );
          },
          () => {},
        );
        return;
      }
      case 'unpublish': {
        const was = e.it.published?.url ?? '';
        c.run(unpublishApp, args).then(
          () => shell.toast.show(t('stuff.page.unpublished', { at: bare(was) })),
          () => {},
        );
        return;
      }
      case 'pubopen':
        if (e.it.published?.url) window.open(e.it.published.url, '_blank', 'noopener');
        return;
      case 'pubcopy':
        void shell.platform.copy(e.it.published?.url ?? '').then((ok) => shell.toast.show(t(ok ? 'stuff.page.copied' : 'stuff.page.copyFailed')));
        return;
      case 'copy':
        void navigator.clipboard.writeText(e.it.kind === 'link' ? (e.it.url ?? '') : (e.it.excerpt ?? '')).catch(() => {});
        return;
      case 'download': {
        const a = document.createElement('a');
        a.href = fileUrl(e);
        a.download = e.it.name;
        a.click();
        return;
      }
      case 'star':
        return quiet(c.run(updateItem, { ...args, starred: !e.it.starred }));
      case 'task':
        if (e.it.from?.session) c.navigate({ t: 'openTask', id: entityKey(ownerOf(key), e.it.from.session) as unknown as SessionId });
        return;
      case 'folder':
        return quiet(c.run(revealItem, args));
      case 'remove':
        return quiet(c.run(removeItem, args));
      default:
    }
  };

  const upload = (files: FileList | null): void => {
    for (const f of Array.from(files ?? [])) {
      // the bytes go to My Stuff's upload route on this computer; its rows follow on the stuff topic
      c.http(c.home)
        .send({ method: 'POST', path: `/stuff/upload?name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.type)}`, body: f, contentType: 'application/octet-stream' })
        .catch((e: unknown) => shell.toast.error(e instanceof Error ? e.message : String(e)));
    }
  };
  let picker: HTMLInputElement | undefined;

  const card = (e: Entry): JSX.Element => {
    const k = kindOf(e.it.kind);
    const actions = () => itemActions(e.it, { ...(st.publishTo()[0] && { publishTo: st.publishTo()[0] }), pinnedTask: false, pinnedHome: false, task: !!e.it.from?.session, mobile: false }).filter((a) => HERE.has(a.id));
    return (
      <Card part="stuff.card" as="li" interactive onClick={() => run(e, 'open')}>
        <Stack gap="2">
          <Inline gap="2" justify="between">
            <Inline gap="2">
              <Icon name={k.icon} />
              <Text weight="medium" truncate>
                {e.it.title || e.it.name}
              </Text>
            </Inline>
            <Menu
              part="stuff.card.menu"
              trigger={{ icon: 'dots', 'aria-label': t('stuff.page.more', { name: e.it.title || e.it.name }), variant: 'ghost', size: 'xs' }}
              items={actions().map((a) => ({ value: a.id, label: t(a.label, a.vars), icon: a.icon, ...(a.danger && { danger: true }) }))}
              onSelect={(v) => run(e, v as ActionId)}
            />
          </Inline>
          <Show when={e.it.excerpt}>
            <Text size="sm" tone="muted" truncate>
              {e.it.excerpt}
            </Text>
          </Show>
          <Inline gap="2" justify="between">
            <Text size="sm" tone="muted" truncate>
              {cardMeta(e.it, t)}
            </Text>
            <Text size="sm" tone="muted">
              {when(e.it.at, Date.now())}
            </Text>
          </Inline>
        </Stack>
      </Card>
    );
  };

  return (
    <Stack gap="4" part="stuff.page" pad="4">
      <Inline gap="3" justify="between" part="stuff.head">
        <Inline gap="2">
          <Icon name="stuff" />
          <Text weight="semibold" truncate>
            {t('stuff.title')}
          </Text>
        </Inline>
        <Inline gap="2">
          <Button size="sm" variant="ghost" icon="plus" part="stuff.add" onClick={() => picker?.click()}>
            {t('stuff.page.add')}
          </Button>
          <input ref={(el) => (picker = el)} type="file" multiple hidden onChange={(ev) => upload(ev.currentTarget.files)} />
        </Inline>
      </Inline>
      <Text tone="muted" part="stuff.role">
        {t('stuff.role')}
      </Text>
      <Input icon="search" aria-label={t('stuff.page.search')} placeholder={t('stuff.page.search')} value={q()} onInput={setQ} />
      <Show when={chips().chips.length > 1}>
        <Wrap gap="2" part="stuff.kinds">
          <For each={chips().chips}>
            {(ch) => (
              <Button size="sm" variant={chips().kind === ch.id ? 'primary' : 'ghost'} onClick={() => setKind(ch.id)}>
                {`${ch.id === 'all' ? t('stuff.kind.all') : t(kindOf(ch.id).many)} ${ch.count}`}
              </Button>
            )}
          </For>
        </Wrap>
      </Show>
      <Show
        when={entries().length > 0}
        fallback={
          <EmptyState part="stuff.empty" icon="stuff" title={t('stuff.page.empty.title')} action={<Button size="sm" onClick={() => picker?.click()}>{t('stuff.page.add')}</Button>}>
            {t('stuff.page.empty.description')}
          </EmptyState>
        }
      >
        <Show when={shown().length > 0} fallback={<Text tone="muted">{t('stuff.page.nothing')}</Text>}>
          <For each={groups()}>
            {(g) => (
              <Stack gap="2" part="stuff.group">
                <Text size="sm" tone="muted" weight="medium">
                  {g.label}
                </Text>
                <Wrap gap="3" part="stuff.cards">
                  <For each={g.items}>{(it) => (byKey().get(it.id) ? card(byKey().get(it.id) as Entry) : null)}</For>
                </Wrap>
              </Stack>
            )}
          </For>
        </Show>
      </Show>
    </Stack>
  );
}

export type { EntityKey };
