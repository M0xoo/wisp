// The `hero` block (v1 R.hero): what happened, in one line under a status pill, and a sentence or
// two of summary. The title is content (it wraps, balanced); the pill is control text.
import { Show, type JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { Pill } from '../content/Pill.tsx';
import { useBlockT } from './context.tsx';
import { InlineMd } from './content-parts.tsx';
import { oneOf, str } from './read.ts';
import type { BlockProps } from './types.ts';

const STATUS = ['done', 'partial', 'blocked', 'info'] as const;
type HeroStatus = (typeof STATUS)[number];
const TONE: Readonly<Record<HeroStatus, Tone>> = { done: 'good', partial: 'warn', blocked: 'bad', info: 'info' };
const LABEL = { done: 'block.hero.done', partial: 'block.hero.partial', blocked: 'block.hero.blocked', info: 'block.hero.info' } as const;

export function HeroBlock(props: BlockProps): JSX.Element {
  const t = useBlockT();
  const status = (): HeroStatus => oneOf(props.block['status'], STATUS, 'done');
  const summary = (): string => str(props.block['summary']);
  return (
    <div data-kit="cb-hero" data-part="block.hero" data-status={status()}>
      <div data-kit="cb-hero-top" data-part="block.hero.top">
        <Pill part="block.hero.status" tone={TONE[status()]} dot>
          {t(LABEL[status()])}
        </Pill>
      </div>
      <h2 data-kit="cb-hero-title" data-part="block.hero.title">{str(props.block['title']) || t('block.hero.title')}</h2>
      <Show when={summary()}>
        <p data-kit="cb-hero-summary" data-part="block.hero.summary">
          <InlineMd source={summary()} part="block.hero.summary" />
        </p>
      </Show>
    </div>
  );
}
