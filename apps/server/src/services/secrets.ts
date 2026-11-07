// The secrets kernel service (v1 server/secrets.js): $WISP_HOME/secrets.json, readable by you only
// (0600), never in the database, never sent to the page. The file keeps v1's shape, { ns: { key: v } },
// so a v1 install's secrets read as they are: the service key 'ns/key' is data[ns][key] (a key without
// a '/' lives in the 'wisp' namespace). Writes go to a tmp file (0600 from the start, chmod'ed in case
// it existed) and are renamed over, one at a time, so a crash never leaves half a file.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretsService } from '@wisp/kernel';

type Data = Record<string, Record<string, string>>;

const split = (key: string): [string, string] => {
  const at = key.indexOf('/');
  return at < 0 ? ['wisp', key] : [key.slice(0, at), key.slice(at + 1)];
};

export interface FileSecrets extends SecretsService {
  readonly file: string;
  /** every pending write has landed */
  flush(): Promise<void>;
}

export function fileSecrets(home: string): FileSecrets {
  const file = path.join(home, 'secrets.json');
  let data: Promise<Data> | undefined;
  let writes: Promise<void> = Promise.resolve();
  const load = (): Promise<Data> =>
    (data ??= readFile(file, 'utf8').then(
      (t) => {
        const v: unknown = JSON.parse(t);
        return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Data) : {};
      },
      () => ({}),
    ));
  const save = (d: Data): Promise<void> => {
    const text = JSON.stringify(d, null, 2);
    writes = writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await chmod(tmp, 0o600); // an existing tmp keeps its old mode otherwise
      await rename(tmp, file);
    });
    return writes;
  };
  return {
    file,
    async get(key) {
      const [ns, k] = split(key);
      return (await load())[ns]?.[k];
    },
    async set(key, value) {
      const [ns, k] = split(key);
      const d = await load();
      (d[ns] ??= {})[k] = value;
      await save(d);
    },
    async delete(key) {
      const [ns, k] = split(key);
      const d = await load();
      const bucket = d[ns];
      if (!bucket || !(k in bucket)) return;
      delete bucket[k];
      if (!Object.keys(bucket).length) delete d[ns];
      await save(d);
    },
    async keys(prefix = '') {
      const d = await load();
      return Object.entries(d)
        .flatMap(([ns, kv]) => Object.keys(kv).map((k) => (ns === 'wisp' ? k : `${ns}/${k}`)))
        .filter((k) => k.startsWith(prefix))
        .sort();
    },
    flush: () => writes,
  };
}
