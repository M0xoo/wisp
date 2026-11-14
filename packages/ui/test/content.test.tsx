import { describe, expect, test } from 'vitest';
import { mount, part } from './helpers.tsx';
import {
  Avatar, Box, Button, Divider, Grid, Heading, Icon, IconButton, Inline, Kbd, KitProvider, Link, Pill, Scroll,
  Skeleton, Stack, Text, Time, initials, timeLabel, englishT, type Translate,
} from '../src/index.ts';

describe('each component renders its default data-part', () => {
  const cases: Array<[string, () => import('solid-js').JSX.Element]> = [
    ['ui.box', () => <Box />],
    ['ui.stack', () => <Stack />],
    ['ui.inline', () => <Inline />],
    ['ui.grid', () => <Grid />],
    ['ui.scroll', () => <Scroll />],
    ['ui.text', () => <Text>x</Text>],
    ['ui.heading', () => <Heading>x</Heading>],
    ['ui.kbd', () => <Kbd keys={['⌘', 'K']} />],
    ['ui.link', () => <Link href="/x">x</Link>],
    ['ui.icon', () => <Icon name="check" />],
    ['ui.pill', () => <Pill>Done</Pill>],
    ['ui.time', () => <Time at={0} now={0} />],
    ['ui.avatar', () => <Avatar name="Ada Lovelace" />],
    ['ui.skeleton', () => <Skeleton />],
    ['ui.divider', () => <Divider />],
    ['ui.button', () => <Button>Go</Button>],
    ['ui.icon-button', () => <IconButton icon="x" label="Close" />],
  ];
  for (const [name, view] of cases) {
    test(name, () => {
      mount(view);
      expect(part(name)).not.toBeNull();
    });
  }
  test('a part prop replaces the default', () => {
    mount(() => <Button part="composer.send">Send</Button>);
    expect(part('composer.send')?.getAttribute('data-kit')).toBe('button');
    expect(part('ui.button')).toBeNull();
  });
});

describe('Box and Stack', () => {
  test('Box picks a semantic element and carries token knobs as custom properties', () => {
    mount(() => <Box as="section" pad="4" padX="6" surface="surface" radius="lg" vars={{ '--sb-w': '320px' }} />);
    const el = part('ui.box');
    expect(el?.tagName).toBe('SECTION');
    expect(el?.style.getPropertyValue('--k-pad-y')).toBe('var(--space-4)');
    expect(el?.style.getPropertyValue('--k-pad-x')).toBe('var(--space-6)');
    expect(el?.style.getPropertyValue('--sb-w')).toBe('320px');
    expect(el?.hasAttribute('data-surface')).toBe(true);
  });
  test('padding on one axis sets the other to 0 instead of inheriting it', () => {
    mount(() => <Box padX="4" />);
    expect(part('ui.box')?.style.getPropertyValue('--k-pad-y')).toBe('var(--space-0)');
  });
  test('Stack always sets its own gap, so a nested stack never inherits one', () => {
    mount(() => <Stack gap="6"><Stack part="inner.stack" /></Stack>);
    expect(part('inner.stack')?.style.getPropertyValue('--k-gap')).toBe('var(--space-0)');
  });
});

describe('Button', () => {
  test('loading keeps the label in the DOM (so the width holds), shows a ring and ignores clicks', () => {
    let clicks = 0;
    mount(() => <Button loading onClick={() => clicks++}>Ship it</Button>);
    const b = part('ui.button');
    expect(b?.textContent).toContain('Ship it');
    expect(b?.getAttribute('aria-busy')).toBe('true');
    expect(b?.querySelector('[data-kit="spinner"]')?.getAttribute('aria-label')).toBe('Loading');
    b?.click();
    expect(clicks).toBe(0);
  });
  test('the busy ring is named through the provider’s t', () => {
    const t: Translate = (key) => (key === 'loading' ? 'Chargement' : englishT(key));
    mount(() => <KitProvider t={t}><Button loading>Go</Button></KitProvider>);
    expect(document.querySelector('[data-kit="spinner"]')?.getAttribute('aria-label')).toBe('Chargement');
  });
  test('an icon button is named by its label, for readers and on hover', () => {
    mount(() => <IconButton icon="settings" label="Settings" />);
    const b = part('ui.icon-button');
    expect(b?.getAttribute('aria-label')).toBe('Settings');
    expect(b?.getAttribute('title')).toBe('Settings');
  });
});

describe('Icon', () => {
  test('decorative icons are hidden from readers; labelled ones are images', () => {
    mount(() => <><Icon name="check" part="a.icon" /><Icon name="warn" label="Warning" part="b.icon" /></>);
    expect(part('a.icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(part('b.icon')?.getAttribute('role')).toBe('img');
    expect(part('b.icon')?.innerHTML).toContain('<');
  });
});

describe('Time', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  test('the past is relative, short, as v1 wrote it: now, 28m, 4h, 3d (owner, 2026-11-10)', () => {
    expect(timeLabel(now - 10_000, now, englishT)).toBe('now');
    expect(timeLabel(now - 28 * 60_000, now, englishT)).toBe('28m');
    expect(timeLabel(now - 3.6 * 3_600_000, now, englishT)).toBe('4h');
    expect(timeLabel(now - 2.6 * 86_400_000, now, englishT)).toBe('3d');
    expect(timeLabel(now - 90 * 86_400_000, now, englishT)).toBe('90d');
  });
  test('the future is absolute, never "in 18m"', () => {
    const label = timeLabel(now + 18 * 60_000, now, englishT, 'en-GB');
    expect(label).not.toMatch(/ago|in /);
    expect(label).toMatch(/\d{2}:\d{2}/);
  });
  test('renders a <time> column with a datetime and the full date on hover', () => {
    mount(() => <Time at={now - 60_000} now={now} />);
    const el = part('ui.time');
    expect(el?.tagName).toBe('TIME');
    expect(el?.getAttribute('datetime')).toBe(new Date(now - 60_000).toISOString());
    expect(el?.hasAttribute('data-column')).toBe(true);
    expect(el?.getAttribute('title')).toBeTruthy();
    expect(el?.textContent).toBe('1m');
  });
  test('the hover on a time soon says how long until it', () => {
    mount(() => <Time at={now + 18 * 60_000} now={now} />);
    expect(part('ui.time')?.getAttribute('title')).toContain('in 18 min');
  });
});

describe('Avatar', () => {
  test('initials from the first and last word', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace')).toBe('G');
    expect(initials('  ')).toBe('');
    expect(initials('jean-luc picard')).toBe('JP');
  });
  test('without a picture it shows initials and keeps its name', () => {
    mount(() => <Avatar name="Ada Lovelace" status="good" />);
    expect(part('ui.avatar')?.getAttribute('aria-label')).toBe('Ada Lovelace');
    expect(part('ui.avatar')?.textContent).toBe('AL');
  });
});
