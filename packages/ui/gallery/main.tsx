// `npm run gallery` in packages/ui. ?theme=light|dark picks the theme (default: the OS's).
import '../src/css/index.css';
import { render } from 'solid-js/web';
import { createSignal, type JSX } from 'solid-js';
import { Box, Button, Heading, Inline, Stack, Text } from '../src/index.ts';
import { ContentGallery } from './sections/content.tsx';
import { RichGallery } from './sections/rich.tsx';
import { ControlsGallery } from './sections/controls.tsx';
import { CompositesGallery } from './sections/composites.tsx';
import { SettingsGallery } from './sections/settings.tsx';
import { BlocksGallery } from './sections/blocks.tsx';
import { ShellGallery } from './sections/shell.tsx';
import { TerminalGallery } from './sections/terminal.tsx';

type Theme = 'light' | 'dark' | 'system';

function initialTheme(): Theme {
  const t = new URLSearchParams(window.location.search).get('theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(t: Theme): void {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function Gallery(): JSX.Element {
  const [theme, setTheme] = createSignal<Theme>(initialTheme());
  applyTheme(theme());
  const cycle = (): void => {
    const next: Theme = theme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };
  return (
    <Box as="main" part="gallery.page" padX="7" padY="8">
      <Stack gap="9">
        <Inline gap="6" justify="between">
          <Stack gap="1">
            <Heading level={1}>wisp kit</Heading>
            <Text tone="muted">Every @wisp/ui component in every state.</Text>
          </Stack>
          <Button variant="secondary" size="sm" icon={theme() === 'dark' ? 'moon' : 'sun'} onClick={cycle} part="gallery.theme">
            {theme() === 'system' ? 'Theme: system' : theme() === 'dark' ? 'Theme: dark' : 'Theme: light'}
          </Button>
        </Inline>
        <ContentGallery />
        <RichGallery />
        <ControlsGallery />
        <CompositesGallery />
        <SettingsGallery />
        <BlocksGallery />
        <ShellGallery />
        <TerminalGallery />
      </Stack>
    </Box>
  );
}

const root = document.getElementById('root');
if (root) render(() => <Gallery />, root);
