// A run's tool list as the turn keeps it (v1 server/budget.js toolSet): { hash, list }, for the
// account comparison. Pure, so the runtime and the page can both call it: an api package holds no
// node: imports, so the hash is a small SHA-1 here (the same 12 hex digits v1's node:crypto gave,
// so hashes stored by v1 still match).

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

/** SHA-1 of a string's UTF-8 bytes, as hex. */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] ?? 0) | ((bytes[i] ?? 0) << (24 - (i % 4) * 8));
  words[len >> 2] = (words[len >> 2] ?? 0) | (0x80 << (24 - (len % 4) * 8));
  words[words.length - 1] = len * 8;
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 80; t++) w[t] = t < 16 ? (words[off + t] ?? 0) : rotl((w[t - 3] ?? 0) ^ (w[t - 8] ?? 0) ^ (w[t - 14] ?? 0) ^ (w[t - 16] ?? 0), 1);
    let [a, b, c, d, e] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotl(a, 5) + f + e + k + (w[t] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = next;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * A run's tool list (Claude Code's system/init tools) as turn.details.tools. wisp's own MCP tools
 * are left out (they change with the task), so the hash only moves when the account's own tools
 * do. `seen` (hashes earlier turns of this task stored the list under) drops the list from repeats.
 */
export function toolSet(list: readonly unknown[] | null | undefined, seen: readonly string[] = []): { hash: string; list?: string[] } {
  const names = [...new Set((list ?? []).map(String).filter((n) => n && !/^mcp__wisp__/.test(n)))].sort();
  const hash = sha1Hex(names.join('\n')).slice(0, 12);
  return seen.includes(hash) ? { hash } : { hash, list: names };
}
