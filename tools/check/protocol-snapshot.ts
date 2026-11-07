// Prints the wire shapes of @wisp/protocol as JSON, or with --write saves them as
// packages/protocol/snapshots/proto-<PROTO>.json: the snapshot the protocol rule diffs against.
// Write one when a protocol version is released (the release skill), never to make a diff pass.
//
//   node tools/check/protocol-snapshot.ts            print
//   node tools/check/protocol-snapshot.ts --write    save (refuses to overwrite a different snapshot without --force)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readProtocol, SNAPSHOT_DIR } from './protocol-shape.ts';

const args = process.argv.slice(2);
const rootArg = args.find((a) => a.startsWith('--root='));
const root = resolve(rootArg ? rootArg.slice('--root='.length) : join(import.meta.dirname, '..', '..'));
const { lines: _lines, ...snap } = readProtocol(root);
const json = `${JSON.stringify(snap, null, 2)}\n`;

if (!args.includes('--write')) {
  process.stdout.write(json);
} else {
  const file = join(root, SNAPSHOT_DIR, `proto-${snap.proto}.json`);
  if (existsSync(file) && readFileSync(file, 'utf8') !== json && !args.includes('--force')) {
    process.stderr.write(`${SNAPSHOT_DIR}/proto-${snap.proto}.json exists and differs: a released snapshot is not rewritten (bump PROTO, or --force)\n`);
    process.exit(1);
  }
  mkdirSync(join(root, SNAPSHOT_DIR), { recursive: true });
  writeFileSync(file, json);
  process.stdout.write(`wrote ${SNAPSHOT_DIR}/proto-${snap.proto}.json (${Object.keys(snap.types).length} types)\n`);
}
