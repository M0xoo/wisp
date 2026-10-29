// A folder as one request body, for publishing an app to a grid (services/publish.js →
// grid/sites.js). Both ends are wisp, so no tar: each file is a 4-byte length, a JSON header
// ({ path, size }) and its bytes. Nothing here imports Node's net or wisp: the grid reads it too.

import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 5000;

// Every file under dir, relative paths with forward slashes.
export function packDir(dir, { maxBytes = Infinity } = {}) {
  const parts = [];
  let size = 0;
  let files = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        const data = fs.readFileSync(abs);
        size += data.length;
        if (++files > MAX_FILES || size > maxBytes) throw Object.assign(new Error('too big'), { tooBig: true });
        const head = Buffer.from(JSON.stringify({ path: r, size: data.length }));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(head.length);
        parts.push(len, head, data);
      }
    }
  };
  walk(dir, '');
  return { body: Buffer.concat(parts), size, files };
}

// A file's path from a bundle, or null when it would land outside the folder.
export function bundlePath(p) {
  if (typeof p !== 'string' || !p || p.length > 400 || /[\x00-\x1f\\]/.test(p) || p.startsWith('/')) return null;
  const parts = p.split('/');
  return parts.every((x) => x && x !== '.' && x !== '..') ? parts.join('/') : null;
}

// Write a bundle into dir (which it makes). Throws on anything malformed.
export function unpackTo(buf, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let at = 0;
  let files = 0;
  let size = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('The bundle ends early.');
    const n = buf.readUInt32BE(at);
    at += 4;
    if (n > 2048 || at + n > buf.length) throw new Error('A file header in the bundle is broken.');
    let head;
    try {
      head = JSON.parse(buf.subarray(at, at + n).toString('utf8'));
    } catch {
      throw new Error('A file header in the bundle is broken.');
    }
    at += n;
    const rel = bundlePath(head.path);
    const len = Number(head.size);
    if (!rel || !Number.isInteger(len) || len < 0 || at + len > buf.length) throw new Error(`The bundle has a bad file: ${String(head.path).slice(0, 80)}`);
    if (++files > MAX_FILES) throw new Error(`More than ${MAX_FILES} files.`);
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf.subarray(at, at + len), { flag: 'wx' });
    at += len;
    size += len;
  }
  return { files, size };
}
