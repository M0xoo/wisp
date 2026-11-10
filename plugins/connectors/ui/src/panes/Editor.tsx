// Add or edit a connector (v1's form): its name, local (a command wisp starts) or remote (a URL), and its
// secrets as key/value pairs (a saved value stays unless a new one is typed). A pasted MCP config fills
// the form. Save is named for what it does; nothing is sent until then.
import { createSignal, Index, Show, type JSX } from 'solid-js';
import { Button, Dialog, Field, IconButton, Inline, Input, RadioGroup, Stack, Text, TextArea } from '@wisp/ui';
import { t } from '../i18n.ts';
import { missing, parsePasted, tidyName, type Draft, type Pair } from '../lib.ts';

export interface EditorProps {
  readonly draft: Draft;
  readonly editing: boolean;
  readonly onSave: (d: Draft) => void;
  readonly onClose: () => void;
}

function Pairs(props: { readonly label: string; readonly pairs: Pair[]; readonly onChange: (p: Pair[]) => void; readonly keyHint: string }): JSX.Element {
  const set = (i: number, p: Partial<Pair>): void => props.onChange(props.pairs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Stack gap="2" part="connectors.pairs">
      <Text tone="muted">{props.label}</Text>
      <Index each={props.pairs}>
        {(p, i) => (
          <Inline gap="2">
            <Input size="sm" mono aria-label={t('connectors.form.key')} placeholder={props.keyHint} value={p().key} onInput={(v) => set(i, { key: v })} />
            <Input size="sm" mono type="password" aria-label={t('connectors.form.value')} placeholder={p().set ? t('connectors.form.saved') : (p().placeholder ?? t('connectors.form.value'))} value={p().value} onInput={(v) => set(i, { value: v })} />
            <IconButton icon="x" size="sm" label={t('connectors.form.drop', { key: p().key })} onClick={() => props.onChange(props.pairs.filter((_, j) => j !== i))} />
          </Inline>
        )}
      </Index>
      <Inline>
        <Button size="sm" variant="ghost" icon="plus" part="connectors.pairs.add" onClick={() => props.onChange([...props.pairs, { key: '', value: '', set: false }])}>
          {t('connectors.form.addKey')}
        </Button>
      </Inline>
    </Stack>
  );
}

export function Editor(props: EditorProps): JSX.Element {
  const [d, setD] = createSignal<Draft>(props.draft);
  const [paste, setPaste] = createSignal('');
  const [tried, setTried] = createSignal(false);
  const up = (p: Partial<Draft>): void => {
    setD({ ...d(), ...p });
  };
  const lack = (): ReturnType<typeof missing> => (tried() ? missing(d()) : null);
  const save = (): void => {
    setTried(true);
    if (missing(d()) === null) props.onSave(d());
  };
  const pasted = (text: string): void => {
    setPaste(text);
    const found = parsePasted(text);
    const first = found?.[0];
    if (first) setD({ ...first, name: first.name || d().name });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      closeOnOutside={false}
      title={props.editing ? t('connectors.form.edit', { name: d().name }) : t('connectors.add')}
      part="connectors.editor"
      footer={
        <Inline gap="3" justify="end">
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            {t('connectors.cancel')}
          </Button>
          <Button variant="primary" size="sm" part="connectors.save" onClick={save}>
            {props.editing ? t('connectors.form.save') : t('connectors.add')}
          </Button>
        </Inline>
      }
    >
      <Stack gap="4">
        <Field label={t('connectors.form.name')} hint={t('connectors.form.name.hint')} {...(lack() === 'name' && { error: t('connectors.form.name.needed') })}>
          <Input mono value={d().name} readOnly={props.editing} onInput={(v) => up({ name: v })} onBlur={() => up({ name: tidyName(d().name) })} placeholder="github" />
        </Field>
        <RadioGroup
          label={t('connectors.form.where')}
          value={d().transport}
          onChange={(v) => up({ transport: v === 'remote' ? 'remote' : 'local' })}
          options={[
            { value: 'local', label: t('connectors.form.local'), hint: t('connectors.form.local.hint') },
            { value: 'remote', label: t('connectors.form.remote'), hint: t('connectors.form.remote.hint') },
          ]}
        />
        <Show
          when={d().transport === 'local'}
          fallback={
            <>
              <Field label={t('connectors.form.url')} {...(lack() === 'url' && { error: t('connectors.form.url.needed') })}>
                <Input mono type="url" value={d().url} onInput={(v) => up({ url: v })} placeholder="https://mcp.example.com/mcp" />
              </Field>
              <Pairs label={t('connectors.form.headers')} keyHint="Authorization" pairs={d().headers} onChange={(headers) => up({ headers })} />
            </>
          }
        >
          <Field label={t('connectors.form.command')} {...(lack() === 'command' && { error: t('connectors.form.command.needed') })}>
            <Input mono value={d().command} onInput={(v) => up({ command: v })} placeholder="npx -y @modelcontextprotocol/server-github" />
          </Field>
          <Pairs label={t('connectors.form.env')} keyHint="GITHUB_TOKEN" pairs={d().env} onChange={(env) => up({ env })} />
        </Show>
        <Show when={!props.editing}>
          <Field label={t('connectors.form.paste')} hint={t('connectors.form.paste.hint')}>
            <TextArea mono minRows={3} value={paste()} onInput={pasted} placeholder='{ "mcpServers": { … } }' />
          </Field>
        </Show>
      </Stack>
    </Dialog>
  );
}

/** Kept for the pane's tests: the fields a draft shows for its transport. */
export const shownFields = (d: Draft): string[] => (d.transport === 'local' ? ['name', 'command', 'env'] : ['name', 'url', 'headers']);

