// Secrets this wisp keeps (a cloud computer's sign-in token, …): $WISP_HOME/secrets.json, readable
// by you only. Never in config.json, never sent to the page, never in a spell.

import fs from 'node:fs';
import path from 'node:path';

export class Secrets {
  constructor(home) {
    this.file = path.join(home, 'secrets.json');
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {}
  }

  get(ns, key) {
    return this.data[ns]?.[key] ?? null;
  }

  set(ns, key, value) {
    (this.data[ns] ||= {})[key] = value;
    this.#save();
  }

  delete(ns, key) {
    if (!this.data[ns] || !(key in this.data[ns])) return;
    delete this.data[ns][key];
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // an existing tmp keeps its mode otherwise
    fs.renameSync(tmp, this.file);
  }
}
