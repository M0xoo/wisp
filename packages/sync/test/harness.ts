// Shared test helpers for the client half of sync. The server half and its simulator moved to Rust
// (crates/wisp-sync); the end-to-end property tests run there against the real server.
import type { PeerInfo } from '@wisp/protocol';

export const PEER: PeerInfo = { peer: 'laptop', name: 'laptop', build: 'test', version: '2.0.0', proto_min: 2, proto_max: 2, plugins: [] };

/** A small seeded PRNG (mulberry32), so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
