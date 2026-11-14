// The terminal: a shell prompt, an agent TUI on the alternate screen with colours, and the phone's
// key row. Each specimen feeds its own Screen; typing echoes back like a local line discipline.
import type { JSX } from 'solid-js';
import { Screen, Stack, Terminal } from '../../src/index.ts';
import { Area, Specimen } from '../frame.tsx';

const LABELS = { input: 'Terminal input', keys: 'Keys', paste: 'Paste' };

function shell(): Screen {
  const s = new Screen(80, 10);
  s.write('\x1b[32m~/code/wisp\x1b[0m on \x1b[35m main\x1b[0m\r\n$ ls\r\n');
  s.write('\x1b[1;34mapps\x1b[0m  \x1b[1;34mcrates\x1b[0m  \x1b[1;34mpackages\x1b[0m  \x1b[1;34mplugins\x1b[0m  Cargo.toml  package.json  README.md\r\n');
  s.write('$ cargo test -p wisp-kernel\r\n   \x1b[1;32mCompiling\x1b[0m wisp-kernel v2.0.0\r\n    \x1b[1;32mFinished\x1b[0m test [unoptimized] in 3.21s\r\n');
  s.write('test result: \x1b[32mok\x1b[0m. 128 passed; 0 failed\r\n$ ');
  return s;
}

function tui(): Screen {
  const s = new Screen(80, 10);
  s.write('\x1b[?1049h\x1b[48;5;236m\x1b[2J\x1b[H');
  s.write('\x1b[38;5;214m ╭──────────────────────────────────────────────╮\x1b[0m\x1b[48;5;236m\r\n');
  s.write('\x1b[38;5;214m │\x1b[0m\x1b[48;5;236m \x1b[1m✻ Welcome to the agent\x1b[22m                       \x1b[38;5;214m│\x1b[0m\x1b[48;5;236m\r\n');
  s.write('\x1b[38;5;214m ╰──────────────────────────────────────────────╯\x1b[0m\x1b[48;5;236m\r\n\r\n');
  s.write(' \x1b[38;2;120;200;255m●\x1b[39m Reading packages/ui/src/terminal/screen.ts\r\n');
  s.write(' \x1b[32m✓\x1b[39m 17 tests passed  \x1b[2m(0.9s)\x1b[22m  界面 宽字符\r\n\r\n > \x1b[7m \x1b[27m');
  return s;
}

function Echo(props: { readonly screen: Screen; readonly keyRow?: boolean; readonly lines: number }): JSX.Element {
  // a toy line discipline so typing shows: Enter starts a new prompt, Backspace rubs out
  const echo = (d: string): void => props.screen.write(d.replace(/\r/g, '\r\n$ ').replace(/\x7f/g, '\b \b'));
  return <Terminal screen={props.screen} onData={echo} labels={LABELS} lines={props.lines} {...(props.keyRow !== undefined && { keyRow: props.keyRow })} />;
}

export function TerminalGallery(): JSX.Element {
  return (
    <Area id="terminal" title="Terminal">
      <Specimen title="Terminal" note="A VT screen painted once per frame, only the rows that changed. Dark in both themes.">
        <Stack gap="6">
          <Echo screen={shell()} lines={10} />
          <Echo screen={tui()} lines={10} />
          <Echo screen={shell()} lines={6} keyRow />
        </Stack>
      </Specimen>
    </Area>
  );
}
