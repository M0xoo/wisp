// The app frame (src/shell/Frame.tsx), contained: split with the side pane open, split with the
// list folded, and the phone's stacked pages.
import type { JSX } from 'solid-js';
import { Frame, Text, Box, Stack, Inline, Button } from '../../src/index.ts';
import { Area, Specimen, State } from '../frame.tsx';

const pane = (label: string): JSX.Element => (
  <Box pad="6">
    <Text tone="muted">{label}</Text>
  </Box>
);
const top = (): JSX.Element => (
  <Inline gap="4" justify="between" grow>
    <Text weight="semibold">wisp</Text>
    <Button size="sm" variant="ghost" icon="search">Search</Button>
  </Inline>
);

export function ShellGallery(): JSX.Element {
  return (
    <Area id="shell" title="Shell">
      <Specimen title="Frame" note="The app's body layout: split at 900 px and up, one page at a time under it.">
        <Stack gap="6">
          <State label="split, side open">
            <Box grow><Frame contained layout="split" page="main" sideOpen top={top()} list={pane('List')} main={pane('Main')} side={pane('Side')} onListResize={() => {}} /></Box>
          </State>
          <State label="split, list folded">
            <Box grow><Frame contained layout="split" page="main" listOpen={false} top={top()} list={pane('List')} main={pane('Main')} /></Box>
          </State>
          <State label="stack, the list page">
            <Box grow><Frame contained layout="stack" page="list" top={top()} list={pane('List')} main={pane('Main')} /></Box>
          </State>
        </Stack>
      </Specimen>
    </Area>
  );
}
