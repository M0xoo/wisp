// Start from an issue (v1 web/js/features/issues.js pickIssue): New task's Issue button opens it over the launcher.
// The project's open GitHub issues (or the Linear / Jira ones assigned to you), searched as you type and on the
// peer past the newest 50; the other sources under them, or Connect Linear… / Jira… (Settings → Connectors with
// that connector filled in). Picking one fills New task's prompt (ShellContext.prompts) and closes; a draft it
// replaces comes back with Undo. Nothing starts until you send it.
import { createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { Button, Callout, Icon, Input, Inline, ListRow, Stack, Text } from '@wisp/ui';
import { t, type Key } from './i18n.ts';
import { emptyLine, fixLabel, groupOf, issuePrompt, matches, others, PICKER, type Issue, type IssueList, type Other, type PickerParams, type Source } from './model.ts';

const list = defineCommand<{ peer: PeerId; source: Source; project?: string; q: string }, IssueList>({
  id: 'issues.list',
  owner: (a) => a.peer,
  wire: ({ peer: _peer, ...a }) => a,
  optimistic: 'none',
  pending: 'the issues',
  dedupe: (a) => JSON.stringify([a.peer, a.source, a.project, a.q]),
});

/** v1 waits this long after typing before asking the peer to search past the newest 50. */
const DEEP_MS = 300;

export default function Picker(props: { readonly client: PluginClient; readonly params: PickerParams }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const project = { id: props.params.project, name: props.params.name };
  const [source, setSource] = createSignal<Source>(props.params.source);
  const [q, setQ] = createSignal('');
  const [deepQ, setDeepQ] = createSignal('');
  const [sel, setSel] = createSignal(0);
  const ask = (s: Source, query: string): Promise<IssueList> =>
    c
      .run(list, { peer: c.home, source: s, ...(s === 'github' && project.id && { project: project.id }), q: query })
      .catch((e: unknown) => ({ source: s, issues: [], linear: false, jira: false, error: say('issues.couldnt', { error: e instanceof Error ? e.message : String(e) }), fix: 'retry' }));
  const [res, { refetch }] = createResource(source, (s) => ask(s, ''));
  const [deep] = createResource(
    () => (deepQ() ? ([source(), deepQ()] as const) : undefined),
    ([s, query]) => ask(s, query).then((r) => r.issues),
  );
  const scope = c.scope.child('issues-picker');
  onCleanup(() => scope.dispose());
  let cancel: (() => void) | undefined;
  const typed = (v: string): void => {
    setQ(v);
    setSel(0);
    cancel?.();
    cancel = scope.timeout(DEEP_MS, () => setDeepQ(v.trim()));
  };
  const shown = createMemo((): Issue[] => {
    const mine = (res()?.issues ?? []).filter((i) => matches(i, q()));
    const more = q().trim() && deepQ() === q().trim() ? (deep() ?? []).filter((i) => !mine.some((m) => m.id === i.id)) : [];
    return [...mine, ...more];
  });
  const rest = createMemo(() => others(source(), res(), project, say).filter((o) => !q().trim() || o.label.toLowerCase().includes(q().trim().toLowerCase())));
  const close = (): void => c.navigate({ t: 'closeOverlay', id: PICKER as never });
  const settings = (pane: string, more: Record<string, string> = {}): void => {
    close();
    c.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane, ...more } } });
  };
  const fill = (i: Issue): void => {
    const box = shell.prompts?.get('launcher');
    close();
    if (!box) return;
    const was = box.text();
    box.set(issuePrompt(i));
    box.focus();
    if (was.trim()) shell.toast.show(say('issues.replaced', { ref: i.ref }), { action: { label: say('issues.undo'), onClick: () => (box.set(was), box.focus()) } });
  };
  const other = (o: Other): void => {
    if (o.kind === 'connect') return settings('connectors', { connector: o.source });
    setQ('');
    setDeepQ('');
    setSel(0);
    setSource(o.source);
  };
  const fix = (f: string): void => {
    if (f === 'retry') return void refetch();
    if (f === 'linear' || f === 'jira') return settings('connectors', { connector: f });
    settings('accounts');
  };
  const count = (): number => shown().length + rest().length;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = count();
      if (n) setSel((sel() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const i = sel();
      const issue = shown()[i];
      if (issue) fill(issue);
      else {
        const o = rest()[i - shown().length];
        if (o) other(o);
      }
    }
  };
  const placeholder = (): string => (source() === 'github' ? say('issues.search.github', { name: project.name || say('issues.thisProject') }) : say(`issues.search.${source()}`));
  return (
    <Stack gap="3" part="issues.picker">
      <Input
        type="search"
        icon="search"
        spellcheck={false}
        autocomplete="off"
        value={q()}
        placeholder={placeholder()}
        aria-label={t('issues.title')}
        onInput={typed}
        onKeyDown={onKey}
        part="issues.picker.input"
        ref={(el) => requestAnimationFrame(() => el.focus())}
      />
      <Show when={res()?.error}>
        {(err) => (
          <Callout tone={res()?.fix === 'retry' ? 'warn' : 'info'} part="issues.picker.note">
            <Inline gap="3" justify="between">
              <Text size="sm">{err()}</Text>
              <Show when={fixLabel(res()?.fix)}>
                {(k) => (
                  <Button size="sm" variant="ghost" onClick={() => fix(res()?.fix ?? '')}>
                    {t(k() as Key)}
                  </Button>
                )}
              </Show>
            </Inline>
          </Callout>
        )}
      </Show>
      <Stack gap="0" role="listbox" aria-label={t('issues.title')} part="issues.picker.list">
        <Show when={!res()?.error}>
          <Text size="xs" tone="faint" weight="medium" part="issues.picker.group">
            {groupOf(source(), res(), say)}
          </Text>
        </Show>
        <Show
          when={!res.loading}
          fallback={
            <Text size="sm" tone="muted">
              {t('issues.loading')}
            </Text>
          }
        >
          <Show
            when={shown().length > 0 || res()?.error}
            fallback={
              <Text size="sm" tone="muted">
                {emptyLine(source(), res(), project.name || say('issues.thisProject'), say)}
              </Text>
            }
          >
            <For each={shown()}>
              {(i, k) => (
                <ListRow
                  part="issues.picker.row"
                  title={`${i.ref} ${i.title}`}
                  lead={<Icon name="issue" size="sm" />}
                  sub={[...i.labels.slice(0, 3), i.assignee].filter(Boolean).join(' · ')}
                  selected={sel() === k()}
                  onOpen={() => fill(i)}
                />
              )}
            </For>
          </Show>
        </Show>
        <Show when={rest().length > 0}>
          <Text size="xs" tone="faint" weight="medium" part="issues.picker.group">
            {t('issues.group.others')}
          </Text>
          <For each={rest()}>
            {(o, k) => (
              <ListRow
                part="issues.picker.other"
                title={o.label}
                lead={<Icon name={o.icon} size="sm" />}
                {...(o.kind === 'connect' ? { sub: o.sub } : {})}
                selected={sel() === shown().length + k()}
                onOpen={() => other(o)}
              />
            )}
          </For>
        </Show>
      </Stack>
    </Stack>
  );
}
