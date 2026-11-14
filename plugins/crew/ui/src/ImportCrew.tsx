// Import crew members (v1 crew-share.js importCrew, reviewImportCrew): a shared member's .crew.json, its JSON, or a
// link (https or gist:<id>), checked by the host (crew.import, dryRun), then who joins: each ticked, its name editable,
// what starts it and how it runs. Add puts them on the crew at once, paused; a refusal comes back with the toast.
import { createSignal, For, Show, type JSX } from 'solid-js';
import { defineCommand, type PeerId, type PluginClient } from '@wisp/client';
import { Button, Checkbox, Inline, Input, Stack, Text, TextArea } from '@wisp/ui';
import { t } from './i18n.ts';
import { cadenceLabel } from './model.ts';
import { VIEW } from './views.ts';
import { joining, lockedOf, srcOf, withPassword, type Picks, type Src } from './import-picks.ts';

interface Proposed {
  readonly key: string;
  readonly name: string;
  readonly role?: string;
  readonly cron?: string;
  readonly agent?: string;
  readonly notes?: readonly string[];
}
interface Answer {
  readonly members?: readonly Proposed[];
  readonly source?: { readonly owner?: string };
  readonly room?: number;
  readonly locked?: string;
  readonly wrong?: boolean;
}

const importCrew = defineCommand<{ peer: PeerId; src: Src; dryRun: boolean; choices?: Picks }, Answer>({
  id: 'crew.import',
  owner: (a) => a.peer,
  wire: (a) => ({ ...a.src, ...(a.dryRun && { dryRun: true }), ...(a.choices && { choices: a.choices }) }),
  optimistic: 'none',
  pending: 'the import',
});

// size-ok: one dialog, its two steps share the answer
export default function ImportCrew(props: { readonly client: PluginClient; readonly params: unknown }): JSX.Element {
  const c = props.client;
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const [text, setText] = createSignal('');
  const [bad, setBad] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [answer, setAnswer] = createSignal<{ src: Src; r: Answer } | undefined>();
  const [picks, setPicks] = createSignal<Picks>({});
  // a password-locked link: the review asks for it here (the CLI's --password is the CLI's words)
  const [locked, setLocked] = createSignal<{ wrong: boolean } | undefined>();
  const [password, setPassword] = createSignal('');
  const close = (): void => c.navigate({ t: 'closeOverlay', id: VIEW.import as never });
  let file: HTMLInputElement | undefined;

  const review = (src: Src): void => {
    setBusy(true);
    setBad('');
    c.run(importCrew, { peer: c.home, src, dryRun: true })
      .then((r) => {
        const lock = lockedOf(r);
        setLocked(lock);
        if (lock) return;
        setAnswer({ src, r });
        setPicks(Object.fromEntries((r.members ?? []).map((p) => [p.key, { name: p.name, skip: false }])));
      })
      .catch((e: unknown) => setBad(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)))
      .finally(() => setBusy(false));
  };
  const add = (): void => {
    const a = answer();
    if (!a) return;
    setBusy(true);
    c.run(importCrew, { peer: c.home, src: a.src, dryRun: false, choices: picks() })
      .then(close)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const set = (key: string, patch: Partial<Picks[string]>): void => {
    setPicks({ ...picks(), [key]: { ...(picks()[key] ?? { name: '', skip: false }), ...patch } });
  };
  const n = (): number => joining(picks());

  return (
    <Show
      when={answer()}
      fallback={
        <Stack gap="4" part="crew.import">
          <TextArea
            value={text()}
            minRows={5}
            maxRows={12}
            mono
            aria-label={t('wisp.crew.import.label')}
            placeholder={t('wisp.crew.import.placeholder')}
            onInput={(v) => (setText(v), setBad(''), setLocked(undefined), setPassword(''))}
          />
          <Show when={locked()}>
            {(l) => (
              <Stack gap="1" part="crew.import.password">
                <Input
                  type="password"
                  value={password()}
                  autofocus
                  autocomplete="off"
                  invalid={l().wrong}
                  aria-label={t('wisp.crew.import.password')}
                  placeholder={t('wisp.crew.import.passwordPlaceholder')}
                  onInput={setPassword}
                  onKeyDown={(e) => e.key === 'Enter' && password().trim() && review(withPassword(srcOf(text()), password()))}
                />
                <Text size="sm" tone={l().wrong ? 'bad' : 'muted'}>
                  {t(l().wrong ? 'wisp.crew.import.passwordWrong' : 'wisp.crew.import.passwordHint')}
                </Text>
              </Stack>
            )}
          </Show>
          <Text size="sm" tone="muted">
            {t('wisp.crew.import.hint')}
          </Text>
          <Show when={bad()}>
            <Text size="sm" tone="bad" part="crew.import.bad">
              {bad()}
            </Text>
          </Show>
          <Inline gap="2" justify="between">
            <Button size="sm" variant="ghost" icon="file" onClick={() => file?.click()}>
              {t('wisp.crew.import.file')}
            </Button>
            <input
              ref={(el) => (file = el)}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) void f.text().then((v) => (setText(v), review({ text: v })));
              }}
            />
            <Inline gap="2">
              <Button size="sm" variant="ghost" onClick={close}>
                {t('wisp.crew.page.cancel')}
              </Button>
              <Button size="sm" variant="primary" loading={busy()} disabled={!text().trim() || (!!locked() && !password().trim())} onClick={() => review(withPassword(srcOf(text()), password()))} part="crew.import.review">
                {t('wisp.crew.import.review')}
              </Button>
            </Inline>
          </Inline>
        </Stack>
      }
    >
      {(a) => (
        <Stack gap="4" part="crew.import.list">
          <Show when={'url' in a().src && a().src}>
            {(s) => (
              <Text size="sm" tone="muted">
                {say('wisp.crew.import.from', { url: (s() as { url: string }).url, owner: a().r.source?.owner ?? '' })}
              </Text>
            )}
          </Show>
          <For each={a().r.members ?? []}>
            {(p) => (
              <Stack gap="2" part="crew.import.member">
                <Inline gap="3">
                  <Checkbox checked={!picks()[p.key]?.skip} aria-label={say('wisp.crew.import.pick', { name: p.name })} onChange={(on) => set(p.key, { skip: !on })} />
                  <Input size="sm" value={picks()[p.key]?.name ?? p.name} aria-label={t('wisp.crew.editor.name')} onInput={(v) => set(p.key, { name: v })} />
                  <Show when={p.role}>
                    {(r) => (
                      <Text size="sm" tone="muted" truncate>
                        {r()}
                      </Text>
                    )}
                  </Show>
                </Inline>
                <Text size="sm" tone="faint">
                  {[p.cron ? cadenceLabel(p.cron, say as never) : t('wisp.crew.cadence.oncall'), p.agent ?? ''].filter(Boolean).join(' · ')}
                </Text>
                <For each={p.notes ?? []}>
                  {(note) => (
                    <Text size="sm" tone="muted">
                      {note}
                    </Text>
                  )}
                </For>
              </Stack>
            )}
          </For>
          <Inline gap="2" justify="between">
            <Text size="sm" tone="muted">
              {t('wisp.crew.import.paused')}
            </Text>
            <Inline gap="2">
              <Button size="sm" variant="ghost" onClick={() => setAnswer(undefined)}>
                {t('wisp.crew.import.back')}
              </Button>
              <Button size="sm" variant="primary" loading={busy()} disabled={n() === 0 || n() > (a().r.room ?? Infinity)} onClick={add} part="crew.import.add">
                {n() === 1 ? say('wisp.crew.import.addOne', { name: Object.values(picks()).find((x) => !x.skip)?.name ?? '' }) : say('wisp.crew.import.addMany', { count: n() })}
              </Button>
            </Inline>
          </Inline>
        </Stack>
      )}
    </Show>
  );
}
