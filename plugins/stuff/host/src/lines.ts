// JSON lines over a child's stdio: the db worker and an app's front speak one JSON message per line.

/** Feeds chunks in, calls `fn` with each whole line's parsed JSON (a line that isn't JSON is skipped). */
export function jsonLines(fn: (msg: Record<string, unknown>) => void): (chunk: Uint8Array) => void {
  const dec = new TextDecoder();
  let rest = '';
  return (chunk) => {
    rest += dec.decode(chunk, { stream: true });
    let at = rest.indexOf('\n');
    while (at >= 0) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a stray print: not ours
      }
      if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) fn(msg as Record<string, unknown>);
    }
  };
}

export const line = (msg: unknown): string => `${JSON.stringify(msg)}\n`;
