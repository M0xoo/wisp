// Type-level test, checked by `npm run typecheck` (tsc includes test/): kit components reject
// class and style, and token props reject values off the scale. Each @ts-expect-error fails the
// typecheck if the line ever starts compiling.
import { expect, test } from 'vitest';
import { Box, Button, Grid, Icon, IconButton, Inline, Scroll, Stack, Text, Heading, Menu } from '../src/index.ts';

export function Examples() {
  return (
    <>
      {/* @ts-expect-error class is not a prop */}
      <Box class="x" />
      {/* @ts-expect-error className is not a prop */}
      <Box className="x" />
      {/* @ts-expect-error classList is not a prop */}
      <Stack classList={{ x: true }} />
      {/* @ts-expect-error style is not a prop */}
      <Inline style={{ color: 'red' }} />
      {/* @ts-expect-error style is not a prop, even as a string */}
      <Text style="color: red">x</Text>
      {/* @ts-expect-error class is not a prop on a button */}
      <Button class="primary">Go</Button>
      {/* @ts-expect-error style is not a prop on an icon */}
      <Icon name="check" style={{ width: '13px' }} />
      {/* @ts-expect-error vars take custom properties only, never plain properties */}
      <Box vars={{ width: '320px' }} />
      {/* @ts-expect-error gap comes from the scale: 13 is not a step */}
      <Stack gap={13} />
      {/* @ts-expect-error '13' is not a step either */}
      <Stack gap="13" />
      {/* @ts-expect-error a tone that doesn't exist */}
      <Text tone="purple">x</Text>
      {/* @ts-expect-error a font size off the scale */}
      <Heading size="15px">x</Heading>
      {/* @ts-expect-error an icon that isn't in the set */}
      <Icon name="unicorn" />
      {/* @ts-expect-error an icon-only button needs a label */}
      <IconButton icon="x" />
      {/* @ts-expect-error a part name is namespaced: "button" alone is refused */}
      <Button part="button">Go</Button>
      {/* @ts-expect-error an icon-only menu trigger needs an aria-label */}
      <Menu items={[]} onSelect={() => {}} trigger={{ icon: 'dots' }} />
      {/* @ts-expect-error a grid min width is a Size token */}
      <Grid min="300px" />
      {/* @ts-expect-error radius from the scale only */}
      <Scroll radius="lg" />
      {/* These compile: tokens, custom properties, namespaced parts. */}
      <Box vars={{ '--sb-w': '320px' }} pad="4" radius="lg" surface="surface" part="list.row" />
      <Stack gap="4" />
      <Grid min="dialog-sm" gap="6" />
      <Menu items={[]} onSelect={() => {}} trigger={{ icon: 'dots', 'aria-label': 'More' }} />
    </>
  );
}

test('the type-level checks live in the typecheck', () => {
  expect(typeof Examples).toBe('function');
});
