// Attachments: raw bodies streamed to disk, referenced by id from launches and replies.
// Each upload is <id>-<name> next to an <id>.json with its metadata.

import fs from 'node:fs';
import path from 'node:path';
import { MIME } from '../http/static.js';
import { bad, newId } from '../util.js';

export const MAX_UPLOAD = 500 * 1024 * 1024;

export class Uploads {
  constructor(dir) {
    this.dir = dir;
    this.byId = new Map(); // id -> { id, name, mime, size, path }
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const u = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        this.byId.set(u.id, u);
      } catch {}
    }
  }

  get(id) {
    return this.byId.get(id);
  }

  // Upload ids from a request body → their records (unknown ids are dropped).
  resolve(ids) {
    return Array.isArray(ids) ? ids.map((i) => this.byId.get(i)).filter(Boolean) : [];
  }

  async receive(req, { name, type }) {
    name = path.basename(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    const id = newId();
    const file = path.join(this.dir, `${id}-${name}`);
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_UPLOAD) {
          req.destroy();
          out.destroy();
          fs.rmSync(file, { force: true });
          reject(bad('file too large (500 MB max)', 413));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    const meta = { id, name, size, mime: type || MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', path: file };
    this.byId.set(id, meta);
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(meta));
    return meta;
  }
}
