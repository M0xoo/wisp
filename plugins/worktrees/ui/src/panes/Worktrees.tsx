// Settings → Worktrees (v1 web/js/features/worktrees.js): how much room tasks' worktrees take, when
// they go, and removing or keeping one by hand. The rules run on the server; this shows them and
// sends what you pick. Every write shows at once and comes back with a toast if refused.
import { createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { entityKey, type PluginClient, type SessionId } from '@wisp/client';
import { Button, englishT, SelectSetting, SettingsGroup, timeLabel, useSignal } from '@wisp/ui';
import { bringIn, clean, dismiss, keep } from '../commands.ts';
import { diskLine, entries, ready, totalLine } from '../format.ts';
import { t } from '../i18n.ts';
import { fromRow, text } from '../source.ts';
import { CLEANUP_CHOICES, CLEANUP_DEFAULT, KIND, MAX_CHOICES, MAX_DEFAULT, ON_DONE_CHOICES, ON_DONE_DEFAULT, SETTING, STATUS_ID, TOPIC, type Entry, type Leftover, type Offer, type WorktreeItem, type WorktreesStatus } from '../types.ts';
import { BringIn } from './BringIn.tsx';
import { Confirm, type Ask } from './Confirm.tsx';
import { List } from './List.tsx';

const MINUTE = 60_000;
const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {}); // the shell's onError shows the rollback toast
};

function Rules(props: { readonly client: PluginClient }): JSX.Element {
  const locked = (by: string): string => t('worktrees.locked', { by });
  return (
    <>
      <SelectSetting part="worktrees.cleanup" title={t('worktrees.cleanup.title')} description={t('worktrees.cleanup.description')} locked={locked} source={text(fromRow(props.client, SETTING.cleanup), CLEANUP_DEFAULT)} items={CLEANUP_CHOICES.map((v) => ({ value: v, label: t(`worktrees.cleanup.${v}`) }))} />
      <SelectSetting part="worktrees.max" title={t('worktrees.max.title')} description={t('worktrees.max.description')} locked={locked} source={text(fromRow(props.client, SETTING.max), MAX_DEFAULT)} items={MAX_CHOICES.map((v) => ({ value: v, label: t(`worktrees.max.${v}`) }))} />
      <SelectSetting part="worktrees.on-done" title={t('worktrees.done.title')} description={t('worktrees.done.description')} locked={locked} source={text(fromRow(props.client, SETTING.onDone), ON_DONE_DEFAULT)} items={ON_DONE_CHOICES.map((v) => ({ value: v, label: t(`worktrees.done.${v}`) }))} />
    </>
  );
}

/** What Remove asks first, if anything (v1): leftovers and folders holding work ask; clean ones go. */
function removeAsk(x: Entry, run: () => void): Ask | undefined {
  if (x.left) {
    const n = x.only ?? 0;
    return { title: t('worktrees.remove.left.ask', { name: x.title }), body: n ? t('worktrees.remove.left.dirty', { count: n }) : t('worktrees.remove.left.body'), ok: t('worktrees.remove'), danger: true, run };
  }
  if (x.status === 'dirty') return { title: t('worktrees.remove.ask'), body: t('worktrees.remove.dirty', { count: x.only }), ok: t('worktrees.remove'), danger: true, run };
  if (x.status === 'unreadable') return { title: t('worktrees.remove.ask'), body: t('worktrees.remove.unreadable'), ok: t('worktrees.remove'), danger: true, run };
  return undefined;
}

export default function Worktrees(props: { readonly client: PluginClient; readonly filter?: string }): JSX.Element {
  const c = props.client;
  const peer = c.home;
  const scope = c.scope.child('worktrees-pane');
  onCleanup(() => scope.dispose());
  c.watch(peer, TOPIC, scope);
  const [now, setNow] = createSignal(Date.now());
  scope.interval(MINUTE, () => setNow(Date.now())); // "Goes in 3 days" and "2h ago" stay true while it's open

  const items = useSignal(c.entities.list<WorktreeItem>(KIND.item));
  const leftovers = useSignal(c.entities.list<Leftover>(KIND.leftover));
  const offers = useSignal(c.entities.list<Offer>(KIND.offer));
  const status = useSignal(c.entities.row<WorktreesStatus>(KIND.status, entityKey(peer, STATUS_ID)));
  const all = createMemo(() => entries(items() as WorktreeItem[], leftovers() as Leftover[]));
  const toClean = createMemo(() => ready(items() as WorktreeItem[], now()));
  const ago = (at: number): string => timeLabel(at, now(), englishT);
  const [ask, setAsk] = createSignal<Ask | undefined>();

  const cleanAll = (): void => {
    const ids = toClean().map((x) => x.id);
    setAsk({ title: t('worktrees.clean.ask', { count: ids.length }), body: t('worktrees.clean.ask.body'), ok: t('worktrees.clean.label'), danger: false, run: () => quiet(c.run(clean, { peer, ids })) });
  };
  const remove = (x: Entry): void => {
    const run = (): void => quiet(c.run(clean, x.left ? { peer, leftovers: [x.name] } : { peer, ids: [x.id], ...((x.status === 'dirty' || x.status === 'unreadable') && { force: true }) }));
    const a = removeAsk(x, run);
    if (a) setAsk(a);
    else run();
  };
  const n = (): number => toClean().length;
  const cleaning = (): boolean => status()?.cleaning !== null && status()?.cleaning !== undefined;

  return (
    <>
      <SettingsGroup
        part="worktrees.summary"
        title={totalLine(all(), status() as WorktreesStatus | undefined)}
        description={diskLine(status() as WorktreesStatus | undefined, ago)}
        actions={
          <Button size="sm" variant="ghost" part="worktrees.clean" disabled={n() === 0 || cleaning()} title={n() ? t('worktrees.clean.tip') : t('worktrees.clean.none')} onClick={cleanAll}>
            {n() ? t('worktrees.clean.n', { count: n() }) : t('worktrees.clean.label')}
          </Button>
        }
      >
        <Rules client={c} />
      </SettingsGroup>
      <BringIn offers={offers() as Offer[]} onTake={(o) => quiet(c.run(bringIn, { peer, project: o.project, paths: o.items.map((x) => x.path) }))} onSkip={(o) => quiet(c.run(dismiss, { peer, project: o.project }))} />
      <List
        entries={all()}
        looking={status()?.looking ?? true}
        now={now()}
        ago={ago}
        filter={props.filter}
        onOpen={(x) => {
          if (!x.left) c.navigate({ t: 'openTask', id: x.id as SessionId });
        }}
        onKeep={(x) => {
          if (!x.left) quiet(c.run(keep, { peer, id: x.id, keep: x.status !== 'kept' }));
        }}
        onRemove={remove}
      />
      <Confirm ask={ask()} onClose={() => setAsk(undefined)} />
    </>
  );
}
