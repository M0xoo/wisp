// Follow-ups waiting for the run (v1 queued.js): above the text, keyed by id so a reorder moves the
// rows and an edited row keeps its box. Each says when it goes (Next · after Claude Code finishes,
// Held after Stop, Queued #2) and can be sent now, edited in place, combined with the next one,
// moved, or cancelled. Every change is a command with the queue's new order as its patch.
import { createSignal, Show, type JSX } from 'solid-js';
import { Key } from '@zag-js/solid';
import { IconButton, Inline, ListRow, Menu, Stack, TextArea, type MenuEntry } from '@wisp/ui';
import type { Env } from '../env.ts';
import { canCombineNext, combinableAll, editable, moved, quote, tagOf } from '../model/queue.ts';
import { plain } from '../text/mentions.ts';
import type { QueueItem, Row } from '../types.ts';

const K = 'shell-composer.queue';

export interface QueueActions {
  now(id: string): void;
  edit(id: string, text: string): void;
  merge(ids: string[]): void;
  order(ids: string[]): void;
  cancel(id: string): void;
}

export interface QueueListProps {
  readonly env: Env;
  readonly queue: readonly Row<QueueItem>[];
  readonly held: boolean;
  readonly running: boolean;
  /** the task's harness, for the tags and titles */
  readonly name: string;
  readonly actions: QueueActions;
  /** a confirm that may be async (the shell's dialog); true goes ahead */
  readonly confirm: (text: string) => Promise<boolean>;
  /** Escape in an edit puts focus back in the reply box */
  readonly refocus: () => void;
}

function EditBox(p: { readonly env: Env; readonly text: string; readonly onDone: (text: string | undefined) => void }): JSX.Element {
  const [v, setV] = createSignal(p.text);
  const done = { sent: false };
  const finish = (text: string | undefined): void => {
    if (done.sent) return;
    done.sent = true;
    p.onDone(text);
  };
  return (
    <TextArea
      aria-label={p.env.t(`${K}.edit`)}
      value={v()}
      onInput={setV}
      autofocus
      minRows={1}
      maxRows={8}
      onBlur={() => finish(v())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(undefined);
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          finish(v());
        }
      }}
    />
  );
}

/** Drag (pointer capture, one row's height per step) or ↑/↓ on the grip moves the row. */
function Grip(p: { readonly label: string; readonly onMove: (by: number) => void }): JSX.Element {
  const drag = { y: 0, step: 0, on: false };
  return (
    <span
      data-part="composer.queue.grip"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const row = (e.currentTarget as HTMLElement).closest('[data-kit="list-row"]');
        drag.y = e.clientY;
        drag.step = row?.getBoundingClientRect().height || 1;
        drag.on = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerUp={(e) => {
        if (!drag.on) return;
        drag.on = false;
        const by = Math.round((e.clientY - drag.y) / drag.step);
        if (by !== 0) p.onMove(by);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        p.onMove(e.key === 'ArrowUp' ? -1 : 1);
      }}
    >
      <IconButton icon="grip" size="xs" label={p.label} />
    </span>
  );
}

export function QueueList(p: QueueListProps): JSX.Element {
  const t = p.env.t;
  const [editing, setEditing] = createSignal<string | undefined>(undefined);
  const ids = (): string[] => p.queue.map((q) => q.id);
  const cancel = async (q: Row<QueueItem>): Promise<void> => {
    if (await p.confirm(t(`${K}.cancel-confirm`, { text: quote(plain(q.text)) }))) p.actions.cancel(q.id);
  };
  const menu = (q: Row<QueueItem>, i: number): MenuEntry[] => [
    { value: 'now', label: t(`${K}.now`), icon: 'send' },
    ...(editable(q) ? [{ value: 'edit', label: t(`${K}.edit`), icon: 'pen' as const }] : []),
    ...(canCombineNext(p.queue, i) ? [{ value: 'merge', label: t(`${K}.merge`), icon: 'merge' as const }] : []),
    ...(combinableAll(p.queue).length ? [{ value: 'merge-all', label: t(`${K}.merge-all`, { count: combinableAll(p.queue).length }), icon: 'merge' as const }] : []),
    ...(i > 0 ? [{ value: 'up', label: t(`${K}.up`), icon: 'arrow' as const }] : []),
    ...(i < p.queue.length - 1 ? [{ value: 'down', label: t(`${K}.down`), icon: 'arrow' as const }] : []),
    { kind: 'separator' },
    { value: 'cancel', label: t(`${K}.cancel`), icon: 'x', danger: true },
  ];
  const run = (q: Row<QueueItem>, i: number, v: string): void => {
    if (v === 'now') p.actions.now(q.id);
    else if (v === 'edit') setEditing(q.id);
    else if (v === 'merge') p.actions.merge([q.id, p.queue[i + 1]?.id ?? '']);
    else if (v === 'merge-all') p.actions.merge(combinableAll(p.queue));
    else if (v === 'up' || v === 'down') p.actions.order(moved(p.queue, i, v === 'up' ? i - 1 : i + 1));
    else if (v === 'cancel') void cancel(q);
  };
  return (
    <Stack gap="1" part="composer.queue" role="list" aria-label={t(`${K}.label`)}>
      <Key each={p.queue} by={(q) => q.id}>
        {(q, i) => {
          const tag = (): string => {
            const tg = tagOf(i(), p.held, p.name);
            return t(tg.key, tg.vars);
          };
          return (
            <Show
              when={editing() !== q().id}
              fallback={
                <EditBox
                  env={p.env}
                  text={q().text}
                  onDone={(text) => {
                    setEditing(undefined);
                    if (text !== undefined && text.trim() && text.trim() !== q().text) p.actions.edit(q().id, text);
                    if (text === undefined) p.refocus();
                  }}
                />
              }
            >
              <ListRow
                part="composer.queue.row"
                quiet
                title={plain(q().text)}
                sub={tag()}
                {...(editable(q()) && { onOpen: () => setEditing(q().id) })}
                lead={
                  <Show when={p.queue.length > 1}>
                    <Grip label={t(`${K}.grip`)} onMove={(by) => p.actions.order(moved(p.queue, i(), i() + by))} />
                  </Show>
                }
                actions={
                  <Inline gap="1">
                    <IconButton icon="send" size="xs" label={p.running ? t(`${K}.now-running`, { name: p.name }) : t(`${K}.now`)} onClick={() => p.actions.now(q().id)} />
                    <Show when={canCombineNext(p.queue, i())}>
                      <IconButton icon="merge" size="xs" label={t(`${K}.merge-title`)} onClick={() => p.actions.merge([q().id, ids()[i() + 1] ?? ''])} />
                    </Show>
                    <Show when={editable(q())}>
                      <IconButton icon="pen" size="xs" label={t(`${K}.edit`)} onClick={() => setEditing(q().id)} />
                    </Show>
                    <Menu part="composer.queue.menu" items={menu(q(), i())} onSelect={(v) => run(q(), i(), v)} placement="bottom-end" trigger={{ icon: 'dots', 'aria-label': t(`${K}.more`), size: 'xs' }} />
                    <IconButton icon="x" size="xs" label={t(`${K}.cancel-title`)} onClick={() => void cancel(q())} />
                  </Inline>
                }
              />
            </Show>
          );
        }}
      </Key>
    </Stack>
  );
}
