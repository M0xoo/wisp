// Bytes → lines, sans-IO (plan §3.1 rule 3): the driver feeds stdout chunks as they come and gets
// back the complete lines; nothing here reads a stream or a clock. A line may be split across chunks
// anywhere, even inside a multi-byte character, so decoding is streaming too.

export class LineSplitter {
  readonly #decoder = new TextDecoder('utf-8');
  #rest = '';

  /** the complete lines in `chunk` (plus what earlier chunks left), without their line ends */
  push(chunk: Uint8Array | string): string[] {
    const text = this.#rest + (typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true }));
    const out: string[] = [];
    let from = 0;
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', from)) {
      out.push(text.charCodeAt(at - 1) === 13 ? text.slice(from, at - 1) : text.slice(from, at));
      from = at + 1;
    }
    this.#rest = from === 0 ? text : text.slice(from);
    return out;
  }

  /** what is left once the stream ended: a last line without a newline (readline gives it too) */
  end(): string[] {
    const last = this.#rest + this.#decoder.decode();
    this.#rest = '';
    return last ? [last.endsWith('\r') ? last.slice(0, -1) : last] : [];
  }
}

/** One stream-json line as a value, or undefined for a blank or non-JSON line (v1 skipped both). */
export function jsonLine(line: string): unknown {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
