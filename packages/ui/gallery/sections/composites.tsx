import { createSignal, type JSX } from 'solid-js';
import {
  Avatar, Banner, Button, Callout, Card, Checklist, Composer, EmptyState, Grid, Icon, IconButton, Inline, ListRow, Pill,
  Section, SettingsRow, Stack, Stats, Steps, Text, Time, Toolbar, VirtualList,
} from '../../src/index.ts';
import { Area, Specimen, State } from '../frame.tsx';

// A fixed clock, so the screenshots read the same every run.
const NOW = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;

interface Row {
  readonly id: string;
  readonly title: string;
  readonly n: number;
}

const WORDS = ['Refactor auth', 'Fix flaky toast test', 'Port the sprite', 'Bring in 3 worktrees', 'Ship it', 'Rerun the audit', 'Answer the review'];
const makeRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, n: i, title: `${WORDS[i % WORDS.length] ?? 'Task'} #${i + 1}` }));

/** Fisher–Yates with a seeded step, so Shuffle is the same on every load. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function Rows(): JSX.Element {
  const [selected, setSelected] = createSignal('b');
  const row = (id: string, title: string, extra: Partial<Parameters<typeof ListRow>[0]> = {}): JSX.Element => (
    <ListRow
      title={title}
      selected={selected() === id}
      onOpen={() => setSelected(id)}
      lead={<Avatar name={title} size="sm" color="pc-teal" />}
      time={<Time at={NOW - 28 * MIN} now={NOW} />}
      actions={<IconButton icon="dots" label="More" size="xs" />}
      {...extra}
    />
  );
  return (
    <Specimen title="ListRow" note="Click a row: the selection moves, nothing in the row does. Hover shows the actions beside the time.">
      <Stack gap="1" part="gallery.rows">
        {row('a', 'Refactor the auth middleware', { sub: 'wisp · main', pills: <Pill tone="good" dot>Finished</Pill> })}
        {row('b', 'Fix the flaky toast test that only fails on Linux under load', { sub: 'wisp · fix/toast', pills: <Pill tone="warn" dot live>Needs you</Pill> })}
        {row('c', 'A finished task, quieter', { quiet: true, sub: 'site · docs' })}
        {row('d', 'No time, no pills', { time: undefined, actions: undefined })}
        <ListRow title="Static row (no open action)" sub="Nothing to click" />
      </Stack>
    </Specimen>
  );
}

function LongLists(): JSX.Element {
  const base = makeRows(5000);
  const [items, setItems] = createSignal<readonly Row[]>(base);
  const [seed, setSeed] = createSignal(7);
  const [log, setLog] = createSignal<readonly Row[]>(makeRows(40));
  const [tail, setTail] = createSignal(true);
  return (
    <Specimen title="VirtualList" note="5,000 keyed rows; Shuffle moves the same nodes. The transcript starts at the end and follows new rows while you are at the tail.">
      <Grid min="dialog-sm" gap="7">
        <Stack gap="4">
          <Inline gap="4">
            <Button size="sm" icon="rotate" onClick={() => { setSeed(seed() + 1); setItems(shuffled(items(), seed())); }}>Shuffle</Button>
            <Button size="sm" variant="ghost" onClick={() => setItems(base)}>Reset</Button>
          </Inline>
          <Card pad="2">
            <VirtualList items={items()} key={(r) => r.id} estimate={36} height="dialog-sm" aria-label="Five thousand rows" part="gallery.virtual">
              {(r) => <ListRow title={r().title} time={<Time at={NOW - r().n * MIN} now={NOW} />} onOpen={() => {}} />}
            </VirtualList>
          </Card>
        </Stack>
        <Stack gap="4">
          <Inline gap="4">
            <Button size="sm" icon="plus" onClick={() => setLog([...log(), ...makeRows(log().length + 1).slice(-1)])}>Add row</Button>
            <Text size="sm" tone="muted">{tail() ? 'At the tail: following' : 'Scrolled up: not following'}</Text>
          </Inline>
          <Card pad="2">
            <VirtualList items={log()} key={(r) => r.id} anchor="bottom" height="popover" onTailChange={setTail} aria-label="Transcript" part="gallery.transcript">
              {(r) => (
                <Stack gap="1" padX="4" padY="3">
                  <Text size="xs" tone="faint">Turn {r().n + 1}</Text>
                  <Text size="md">{r().n % 3 === 0 ? 'A longer answer that wraps onto a second line so rows have different heights and get measured as they render.' : r().title}</Text>
                </Stack>
              )}
            </VirtualList>
          </Card>
        </Stack>
      </Grid>
    </Specimen>
  );
}

function Replies(): JSX.Element {
  const [text, setText] = createSignal('');
  const [sent, setSent] = createSignal<readonly string[]>([]);
  return (
    <Specimen title="Composer" note="Enter sends, Shift+Enter is a new line. The box clears at once; the text grows the box up to ten lines.">
      <Stack gap="6">
        <State label="Empty, with slots">
          <Composer
            value={text()}
            onInput={setText}
            onSend={(v) => { setSent([...sent(), v]); setText(''); }}
            placeholder="Reply to Claude Code…"
            head={sent().length ? <Text size="sm" tone="muted">Sent: {sent().at(-1)}</Text> : undefined}
            left={<><IconButton icon="clip" label="Attach" size="sm" /><Button size="sm" variant="ghost" icon="plan">Plan</Button></>}
            right={<Text size="xs" tone="faint">Opus</Text>}
          />
        </State>
        <State label="Busy (sending)">
          <Composer value="Run the suite again" onInput={() => {}} onSend={() => {}} busy pinned={false} />
        </State>
        <State label="Disabled">
          <Composer value="" onInput={() => {}} onSend={() => {}} placeholder="Signed out" disabled pinned={false} />
        </State>
      </Stack>
    </Specimen>
  );
}

function Blocks(): JSX.Element {
  return (
    <>
      <Specimen title="Stats">
        <Stats items={[
          { label: 'tests passing', value: 1248, delta: '+6', tone: 'good' },
          { label: 'p95 send', value: 95, unit: 'ms', delta: '−325', tone: 'good' },
          { label: 'failures', value: 1, delta: '+1', tone: 'bad' },
          { label: 'bundle', value: '41.2', unit: 'KB' },
        ]} />
      </Specimen>
      <Specimen title="Steps and Checklist">
        <Grid min="dialog-sm" gap="8">
          <Steps items={[
            { title: 'Read the brief', status: 'done' },
            { title: 'Port the tokens', detail: 'tokens/*.json → tokens.css and generated.ts', status: 'done' },
            { title: 'Build the kit', detail: 'Working on composites', status: 'current' },
            { title: 'Android check', status: 'skipped' },
            { title: 'Visual snapshots', detail: 'Chrome refused to start', status: 'failed' },
            { title: 'Release', status: 'pending' },
          ]} />
          <Checklist statusLabel={(d) => (d ? 'Done' : 'Not done')} items={[
            { text: 'Merged', done: true },
            { text: 'Version bumped', done: true },
            { text: 'Changelog', done: false },
            { text: 'Published to npm', done: false },
          ]} />
        </Grid>
      </Specimen>
    </>
  );
}

function Notices(): JSX.Element {
  return (
    <Specimen title="Banner, Callout, EmptyState, Card">
      <Stack gap="6">
        <Banner tone="warn" icon="clock">Reconnecting to wisp…</Banner>
        <Banner tone="accent" icon="update" title="wisp 2.0 is ready" action={<Button size="sm" variant="primary">Update</Button>} onDismiss={() => {}} />
        <Banner tone="bad">Can’t reach wisp. Check the connection and try again.</Banner>
        <Grid min="dialog-sm" gap="6">
          <Callout tone="info" title="Assumption">Behind a proxy, so the IP comes from X-Forwarded-For.</Callout>
          <Callout tone="good" title="Merged">The branch merges cleanly with main.</Callout>
          <Callout tone="warn">One sentence, the button stays: a warning before Ship it is a line, never a hold.</Callout>
          <Callout tone="bad" title="Tests failed">expected 401, got 500</Callout>
        </Grid>
        <Grid min="dialog-sm" gap="6">
          <Card><EmptyState icon="laptop" title="No machines yet" action={<Button variant="primary" icon="plus">Add a machine</Button>}>Add a computer you can reach over SSH and its tasks show here.</EmptyState></Card>
          <Card header="Card with header and footer" footer="Updated 28m ago">The body. Cards line up in a grid.</Card>
          <Card interactive tone="accent" onClick={() => {}} aria-label="Open the plan">
            <Inline gap="4"><Icon name="plan" tone="accent" /><Text weight="medium">Interactive card (a button)</Text></Inline>
          </Card>
        </Grid>
      </Stack>
    </Specimen>
  );
}

function Settings(): JSX.Element {
  const [on, setOn] = createSignal(true);
  return (
    <Specimen title="Section, SettingsRow, Toolbar">
      <Stack gap="8">
        <Section title="Appearance" description="How wisp looks on this computer." actions={<Button size="sm" variant="ghost">Reset</Button>}>
          <SettingsRow title="Theme" description="System follows your computer's setting." control={<Button size="sm" pressed={on()} onClick={() => setOn(!on())}>{on() ? 'Dark' : 'Light'}</Button>} />
          <SettingsRow title="Default folder" description="Where new tasks start." wideControl control={<Button size="sm" icon="folder">~/code/wisp</Button>} />
        </Section>
        <Toolbar aria-label="Task actions" part="gallery.toolbar">
          <Button size="sm" variant="ghost" tone="good" icon="check">Mark done</Button>
          <Button size="sm" variant="ghost" icon="rerun">Rerun…</Button>
          <Button size="sm" variant="ghost" icon="archive">Archive</Button>
          <IconButton icon="dots" label="More" size="sm" />
        </Toolbar>
      </Stack>
    </Specimen>
  );
}

export function CompositesGallery(): JSX.Element {
  return (
    <Area id="composites" title="Composites">
      <Rows />
      <LongLists />
      <Replies />
      <Blocks />
      <Notices />
      <Settings />
    </Area>
  );
}
