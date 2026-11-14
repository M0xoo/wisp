// A transport that talks to the mock peer in memory, frame by frame, like the HTTP one does: for tests
// that run the real client (and shell) against the mock without a server.
import type { Frame, Transport } from '@wisp/client';
import type { ClientMessage } from '@wisp/protocol';
import type { MockPeer } from './mock-peer.ts';

export function memTransport(peer: MockPeer): Transport {
  let clientId = '';
  return {
    kind: 'mem',
    async *connect(params, signal): AsyncGenerator<Frame> {
      const frames: Frame[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const conn = peer.connect(params, (f) => {
        frames.push(f);
        wake?.();
      });
      clientId = conn.clientId;
      signal.addEventListener('abort', () => {
        closed = true;
        conn.close();
        wake?.();
      });
      while (!closed) {
        const f = frames.shift();
        if (f) yield f;
        else await new Promise<void>((r) => (wake = r));
      }
    },
    async post(m: ClientMessage) {
      peer.receive(clientId, m);
    },
  };
}
