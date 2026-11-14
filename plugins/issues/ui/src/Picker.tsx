// Start from an issue (v1 web/js/features/issues.js pickIssue): New task's Issue button opens it near the top, in
// the ⌘K palette's sheet (v1 .palette.issues, 640 wide: two lines a row, the list one height).
// The project's open GitHub issues (or the Linear / Jira ones assigned to you), searched as you type and on the
// peer past the newest 50; the other sources under them, or Connect Linear… / Jira… (Settings → Connectors with
// that connector filled in). Picking one fills New task's prompt (ShellContext.prompts) and closes; a draft it
// replaces comes back with Undo. Nothing starts until you send it.
import { createMemo, createResource, createSignal, onCleanup, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { PaletteSheet, type PaletteRow } from '@wisp/ui';
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
      pick(sel());
    }
  };
  const placeholder = (): string => (source() === 'github' ? say('issues.search.github', { name: project.name || say('issues.thisProject') }) : say(`issues.search.${source()}`));
  // v1 .palette.issues: the issues under their group line, then the other sources under theirs
  const rows = createMemo((): PaletteRow[] => [
    ...shown().map((i, k) => ({
      id: `i:${i.id}`,
      ...(k === 0 && !res()?.error && { head: groupOf(source(), res(), say) }),
      label: [[`${i.ref} ${i.title}`, false]] as const,
      sub: [...i.labels.slice(0, 3), i.assignee].filter(Boolean).join(' · '),
      icon: 'issue' as const,
    })),
    ...rest().map((o, k) => ({
      id: `o:${o.label}`,
      ...(k === 0 && { head: say('issues.group.others') }),
      label: [[o.label, false]] as const,
      ...(o.kind === 'connect' && o.sub ? { sub: o.sub } : {}),
      icon: o.icon,
    })),
  ]);
  // why there's nothing to list (v1 note): the peer's reason with its fix, or the empty line once it answered
  const note = createMemo(() => {
    const r = res();
    if (r?.error) {
      const k = fixLabel(r.fix);
      return { text: r.error, tone: r.fix === 'retry' ? ('warn' as const) : ('info' as const), ...(k && { action: { label: t(k as Key), onClick: () => fix(r.fix ?? '') } }) };
    }
    if (res.loading || shown().length > 0) return undefined;
    return { text: emptyLine(source(), r, project.name || say('issues.thisProject'), say) };
  });
  const pick = (k: number): void => {
    const issue = shown()[k];
    if (issue) return fill(issue);
    const o = rest()[k - shown().length];
    if (o) other(o);
  };
  return (
    <PaletteSheet
      part="issues.picker"
      variant="issues"
      value={q()}
      placeholder={placeholder()}
      label={t('issues.title')}
      rows={rows()}
      selected={sel()}
      empty={t('issues.loading')}
      note={note()}
      loading={res.loading}
      foot={{ navigate: t('issues.foot.navigate'), open: t('issues.foot.open'), close: t('issues.foot.close') }}
      onInput={typed}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          return close();
        }
        onKey(e);
      }}
      onPick={pick}
      onHover={setSel}
      inputRef={(el) => requestAnimationFrame(() => el.focus())}
    />
  );
}
