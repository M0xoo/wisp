// Writing app folders and hand-made bundle entries, for the publishing tests.

import fs from 'node:fs';
import path from 'node:path';

export function write(dir: string, files: Record<string, string>): string {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

// One file entry by hand: a 4-byte length, a JSON header, the bytes.
export function entry(head: unknown, data = ''): Buffer {
  const h = Buffer.from(JSON.stringify(head));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return Buffer.concat([len, h, Buffer.from(data)]);
}
