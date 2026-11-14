// The gallery's own frame, built from the kit like any feature: no class, no style.
import type { JSX } from 'solid-js';
import { Box, Heading, Stack, Text, Wrap } from '../src/index.ts';

/** One component: its name, then every state in a wrapping row. */
export function Specimen(props: { readonly title: string; readonly note?: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <Box as="section" part="gallery.specimen" surface="surface" border="line" radius="lg" pad="7">
      <Stack gap="6">
        <Stack gap="1">
          <Heading level={3}>{props.title}</Heading>
          {props.note ? <Text size="sm" tone="muted">{props.note}</Text> : null}
        </Stack>
        {props.children}
      </Stack>
    </Box>
  );
}

/** A labelled row of states inside a specimen. */
export function State(props: { readonly label: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <Stack gap="3">
      <Text size="xs" tone="faint" weight="medium">{props.label}</Text>
      <Wrap gap="4">{props.children}</Wrap>
    </Stack>
  );
}

/** A group of specimens under a heading. */
export function Area(props: { readonly id: string; readonly title: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <Stack as="section" gap="6" id={props.id} part="gallery.area">
      <Heading level={2}>{props.title}</Heading>
      {props.children}
    </Stack>
  );
}
