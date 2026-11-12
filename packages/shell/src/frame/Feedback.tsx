// Send feedback (v1 feedback.js openFeedback): an idea or a bug, a thumb about wisp as a whole (not for a bug: one
// bug per report), the words, Send (⌘↵). It closes with a thank-you at once; a refusal opens it again with the words.
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { Button, Inline, RateButtons, Stack, Tabs, Text, TextArea } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { ownerOf } from '@wisp/client';
import { usePluginClient } from '../slot.tsx';
import { canSend, sendFeedback, type FeedbackArgs, type FeedbackParams } from './feedback.ts';

export default function Feedback(props: { readonly params: FeedbackParams }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const home = usePluginClient('shell').home;
  const [kind, setKind] = createSignal<'bug' | 'idea'>(props.params.kind ?? 'idea');
  const [rating, setRating] = createSignal<'up' | 'down' | undefined>();
  const [text, setText] = createSignal(props.params.text ?? '');
  let box: HTMLTextAreaElement | undefined;
  onMount(() => requestAnimationFrame(() => box?.focus()));
  const bug = (): boolean => kind() === 'bug';
  const send = (): void => {
    if (!canSend(kind(), rating(), text())) return;
    const r = rating();
    const sid = props.params.sessionId;
    const args: FeedbackArgs = { peer: sid ? ownerOf(sid) : home, text: text().trim(), kind: kind(), ...(r && { rating: r }), ...(sid && { sessionId: sid }), source: props.params.source ?? 'dialog' };
    shell.navigate({ t: 'closeOverlay', id: 'shell.feedback' as never });
    shell.toast.success(t('shell.feedback.thanks'));
    void shell.client.commands.run(sendFeedback, args).then(
      (r) => !r.sent && r.available && shell.toast.show(t('shell.feedback.saved')),
      () => shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.feedback' as never, params: { text: args.text, kind: args.kind ?? 'idea' } } }),
    );
  };
  return (
    <Stack gap="4" part="feedback.body">
      <Tabs
        variant="seg"
        fieldset
        aria-label={t('shell.feedback.kind')}
        value={kind()}
        onChange={(v) => {
          setKind(v === 'bug' ? 'bug' : 'idea');
          box?.focus();
        }}
        items={[
          { value: 'idea', label: t('shell.feedback.idea'), icon: 'spark' },
          { value: 'bug', label: t('shell.feedback.bug'), icon: 'bug' },
        ]}
      />
      <Inline gap="3" align="center" part="feedback.rate">
        <Text size="sm">{bug() ? t('shell.feedback.oneBug') : t('shell.feedback.how')}</Text>
        <Show when={!bug()}>
          <RateButtons rating={rating()} labels={{ up: t('shell.feedback.good'), down: t('shell.feedback.notGood') }} onRate={(n) => setRating(n ?? undefined)} />
        </Show>
      </Inline>
      <TextArea
        ref={(el) => (box = el)}
        value={text()}
        onInput={setText}
        minRows={5}
        maxRows={12}
        maxLength={4000}
        placeholder={bug() ? t('shell.feedback.bugHint') : t('shell.feedback.ideaHint')}
        aria-label={t('shell.feedback.title')}
        part="feedback.text"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Inline gap="3" align="center" part="feedback.foot">
        <Text size="xs" tone="muted">
          {t('shell.feedback.note')}
        </Text>
        <span data-kit="grow" />
        <Button variant="primary" size="sm" icon="send" disabled={!canSend(kind(), rating(), text())} onClick={send} part="feedback.send">
          {t('shell.feedback.send')}
        </Button>
      </Inline>
    </Stack>
  );
}
