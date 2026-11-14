// Layout, type, icons, pills, times, avatars, keys, links, placeholders, dividers, extension slots.
import { For, type JSX } from 'solid-js';
import { FONT_SIZES, SPACES, TONES } from '@wisp/tokens';
import {
  Avatar, Box, Divider, ExtensionSlot, Grid, Heading, ICON_NAMES, Icon, Inline, Kbd, Link, Pill, Scroll, Skeleton,
  Stack, Text, Time, type TextTone,
} from '../../src/index.ts';
import { Area, Specimen, State } from '../frame.tsx';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;

function Swatch(props: { readonly label: string }): JSX.Element {
  return (
    <Box surface="bg-2" radius="md" padX="4" padY="3" part="gallery.swatch">
      <Text size="xs" mono tone="muted">{props.label}</Text>
    </Box>
  );
}

function LayoutSpecimens(): JSX.Element {
  return (
    <>
      <Specimen title="Stack and Inline" note="Gaps come from the scale only: 0–9 (2 px to 32 px).">
        <State label="Inline gap per step">
          <For each={SPACES.slice(1)}>
            {(s) => (
              <Stack gap="2">
                <Text size="xs" tone="faint">gap {s}</Text>
                <Inline gap={s}>
                  <Swatch label="a" />
                  <Swatch label="b" />
                </Inline>
              </Stack>
            )}
          </For>
        </State>
        <State label="Stack, justify and align">
          <Stack gap="3"><Swatch label="one" /><Swatch label="two" /><Swatch label="three" /></Stack>
          <Box border="line" radius="md" pad="4" grow>
            <Inline gap="4" justify="between"><Swatch label="start" /><Swatch label="end" /></Inline>
          </Box>
        </State>
      </Specimen>
      <Specimen title="Grid" note="Fixed columns, or as many columns of at least a Size token as fit.">
        <State label="columns=3">
          <Grid columns={3} gap="4" grow><Swatch label="1" /><Swatch label="2" /><Swatch label="3" /><Swatch label="4" /></Grid>
        </State>
        <State label="min=avatar-lg (auto-fit)">
          <Grid min="avatar-lg" gap="3" grow><For each={[1, 2, 3, 4, 5, 6, 7, 8]}>{(n) => <Swatch label={String(n)} />}</For></Grid>
        </State>
      </Specimen>
      <Specimen title="Box and Scroll" note="Surfaces, borders, radii and shadows from tokens; a scroll box with a stable gutter.">
        <State label="surfaces">
          <Box surface="surface" border="line" radius="lg" pad="6"><Text size="sm">surface + line</Text></Box>
          <Box surface="surface-2" border="line-2" radius="control" pad="6"><Text size="sm">surface-2 + line-2</Text></Box>
          <Box surface="bg-2" radius="md" pad="6"><Text size="sm">bg-2</Text></Box>
          <Box surface="surface" shadow="2" radius="xl" pad="6"><Text size="sm">shadow 2</Text></Box>
        </State>
        <State label="Scroll max=menu-min">
          <Box border="line" radius="lg" pad="0">
            <Scroll max="menu-min" focusable aria-label="Sample scroll">
              <Box pad="4"><Stack gap="2"><For each={Array.from({ length: 12 }, (_, i) => i + 1)}>{(i) => <Text size="sm">Line {i}</Text>}</For></Stack></Box>
            </Scroll>
          </Box>
        </State>
      </Specimen>
    </>
  );
}

const INKS: readonly TextTone[] = ['ink', 'ink-2', 'muted', 'faint', 'accent-ink'];

function TypeSpecimens(): JSX.Element {
  return (
    <Specimen title="Text and Heading" note="One scale: xs 11.5, sm 12.5, md 13, lg 14, then xl, title and display.">
      <State label="sizes">
        <For each={FONT_SIZES}>{(s) => <Text size={s}>{s}</Text>}</For>
      </State>
      <State label="inks and tones">
        <For each={[...INKS, ...TONES]}>{(t) => <Text tone={t} weight="medium">{t}</Text>}</For>
      </State>
      <State label="mono, numeric, truncate, nowrap, two lines">
        <Text mono size="sm">~/Downloads/wisp</Text>
        <Text numeric>1,234.50</Text>
        <Box grow>
          <Text truncate title="A very long task title that does not fit in its column and ends in an ellipsis">
            A very long task title that does not fit in its column and ends in an ellipsis
          </Text>
        </Box>
        <Text lines={2} size="sm">A title that gets two lines on a phone instead of being cut to "do a full audi…" after a few words.</Text>
      </State>
      <State label="headings">
        <Stack gap="3">
          <Heading level={1}>Display heading</Heading>
          <Heading level={2}>Dialog title</Heading>
          <Heading level={3}>Section heading</Heading>
          <Heading level={4}>Group heading</Heading>
        </Stack>
      </State>
    </Specimen>
  );
}

function SmallSpecimens(): JSX.Element {
  return (
    <>
      <Specimen title="Pill" note="Tones mean state. Soft for states, outline for tags.">
        <State label="soft, with a dot">
          <For each={TONES}>{(t) => <Pill tone={t} dot>{t}</Pill>}</For>
          <Pill tone="accent" dot live>Working</Pill>
        </State>
        <State label="icon and outline">
          <Pill tone="warn" icon="clock">Waiting</Pill>
          <Pill tone="good" icon="check">Finished</Pill>
          <Pill variant="outline">refactor</Pill>
          <Pill variant="outline" tone="accent">matched</Pill>
        </State>
      </Specimen>
      <Specimen title="Time" note="Relative for the past, absolute for the future, fixed-width column, full date on hover.">
        <State label="column">
          <Stack gap="1">
            <For each={[0, 1, 28, 180, 60 * 30, 60 * 24 * 40]}>
              {(m) => (
                <Inline gap="4">
                  <Text size="sm">{m} min before</Text>
                  <Time at={NOW - m * MIN} now={NOW} />
                </Inline>
              )}
            </For>
            <Inline gap="4"><Text size="sm">18 min later</Text><Time at={NOW + 18 * MIN} now={NOW} /></Inline>
            <Inline gap="4"><Text size="sm">2 days later</Text><Time at={NOW + 2 * 1440 * MIN} now={NOW} /></Inline>
          </Stack>
        </State>
      </Specimen>
      <Specimen title="Avatar">
        <State label="sizes, colours, status, picture fallback">
          <Avatar name="Ada Lovelace" size="sm" />
          <Avatar name="Grace Hopper" color="pc-teal" />
          <Avatar name="Alan Turing" size="lg" color="pc-violet" status="good" />
          <Avatar name="Broken Picture" size="lg" src="/missing.png" status="warn" />
          <Avatar name="Square" shape="square" color="pc-amber" />
        </State>
      </Specimen>
      <Specimen title="Kbd, Link, Divider">
        <State label="keys (hidden on touch)"><Kbd keys={['⌘', 'K']} /><Kbd keys={['Esc']} /></State>
        <State label="links">
          <Link href="#content">Accent link</Link>
          <Link href="https://trywisp.dev" external tone="ink">External, ink</Link>
          <Link href="#content" tone="muted">Muted</Link>
        </State>
        <State label="dividers">
          <Box grow><Stack gap="4"><Divider /><Divider strength="strong" /></Stack></Box>
          <Inline gap="4"><Text size="sm">left</Text><Divider orientation="vertical" /><Text size="sm">right</Text></Inline>
        </State>
      </Specimen>
      <Specimen title="Skeleton" note="Placeholders with the real thing's shape and size.">
        <State label="a list row loading">
          <Box border="line" radius="lg" pad="6" grow>
            <Inline gap="5">
              <Skeleton shape="circle" />
              <Box grow><Stack gap="3"><Skeleton width="2/3" /><Skeleton width="1/3" /></Stack></Box>
              <Skeleton shape="pill" />
            </Inline>
          </Box>
          <Skeleton shape="block" width="popover" />
        </State>
      </Specimen>
    </>
  );
}

function IconSpecimen(): JSX.Element {
  return (
    <Specimen title="Icon" note={`${ICON_NAMES.length} icons, ported from v1's sprite. Names are a typed union.`}>
      <Grid min="menu-min" gap="2">
        <For each={ICON_NAMES}>
          {(name) => (
            <Inline gap="4">
              <Icon name={name} tone="ink-2" />
              <Text size="xs" mono tone="muted">{name}</Text>
            </Inline>
          )}
        </For>
      </Grid>
      <State label="sizes and tones">
        <Icon name="settings" size="xs" /><Icon name="settings" size="sm" /><Icon name="settings" size="md" />
        <Icon name="settings" /><Icon name="settings" size="lg" />
        <Icon name="check" tone="good" /><Icon name="warn" tone="warn" label="Warning" /><Icon name="x" tone="bad" />
      </State>
    </Specimen>
  );
}

function SlotSpecimen(): JSX.Element {
  return (
    <Specimen title="ExtensionSlot" note="What plugins attached to one input, keyed by extension id.">
      <State label="shell.composer:left, inline">
        <Box border="line" radius="md" pad="4">
          <ExtensionSlot
            input="shell.composer:left"
            extensions={[
              { id: 'claude.model-picker', render: () => <Pill icon="spark">Opus</Pill> },
              { id: 'wisp.mode', render: () => <Pill tone="accent">Plan</Pill> },
            ]}
          />
        </Box>
      </State>
    </Specimen>
  );
}

export function ContentGallery(): JSX.Element {
  return (
    <Area id="content" title="Layout and content">
      <LayoutSpecimens />
      <TypeSpecimens />
      <SmallSpecimens />
      <IconSpecimen />
      <SlotSpecimen />
    </Area>
  );
}
