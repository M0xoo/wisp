// What a terminal printed, kept so a page that opens later sees the screen (v1 pty.js keep()).
// Chunks are joined and cut to KEEP only when read or when twice too long: cutting on every chunk
// copied the whole megabyte each time.

export const KEEP = 1 << 20; // characters replayed to a page that attaches later

export class Screen {
  #chunks: string[] = [];
  #kept = 0;
  readonly #limit: number;

  constructor(limit = KEEP) {
    this.#limit = limit;
  }

  push(text: string): void {
    if (!text) return;
    this.#chunks.push(text);
    this.#kept += text.length;
    if (this.#kept > 2 * this.#limit) this.read();
  }

  /**
   * Everything kept, at most `limit` characters. Cut from the start of a line or an escape sequence
   * near the limit, so a replay doesn't begin with half of one printed as text.
   */
  read(): string {
    let out = this.#chunks.length === 1 ? (this.#chunks[0] ?? '') : this.#chunks.join('');
    if (out.length > this.#limit) {
      const from = out.length - this.#limit;
      const near = out.slice(from, from + 4096).search(/[\n\x1b]/);
      out = out.slice(near < 0 ? from : from + near + (out[from + near] === '\n' ? 1 : 0));
    }
    this.#chunks = out ? [out] : [];
    this.#kept = out.length;
    return out;
  }
}
