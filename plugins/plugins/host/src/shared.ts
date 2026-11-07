// A shared file from a link (v1 routes/spells.js fetchShared): any https URL to the JSON, or
// gist:<id> (the first *.<kind>.json in it). Also what a request body names: { spell }, { text },
// { url }. HTTP goes out through the kernel's net service only.

import type { Source } from '@wisp-plugin/plugins-api';
import { bad, messageOf } from './errors.ts';

const MAX_BYTES = 512 * 1024;
export const MAX_OPEN = 20;

export type Fetch = (url: string, init: { headers: Record<string, string>; timeoutMs: number }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw bad(`That isn't JSON: ${messageOf(err)}`);
  }
}

interface GistFile {
  filename: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

/** kind 'spell' (*.spell.json), 'plugin' (*.plugin.json) or 'crew' (*.crew.json, wisp.crew). */
export async function fetchShared(fetch: Fetch, src: unknown, kind = 'spell'): Promise<{ json: unknown; source: Omit<Source, 'at'> }> {
  const s = String(src || '').trim();
  const gist = /^gist:([a-f0-9]{6,64})$/i.exec(s) || /^https:\/\/gist\.github\.com\/(?:[\w-]+\/)?([a-f0-9]{6,64})\/?$/i.exec(s);
  const what = kind === 'crew' ? 'file' : kind;
  const get = async (url: string, api: boolean): Promise<string> => {
    const res = await fetch(url, { headers: { accept: api ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'wisp' }, timeoutMs: 15_000 });
    if (!res.ok) throw bad(`Couldn't fetch ${url}: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw bad(`That ${what} is bigger than 512 KB.`);
    return text;
  };
  if (gist?.[1]) {
    const g = parseJson(await get(`https://api.github.com/gists/${gist[1]}`, true)) as { files?: Record<string, GistFile>; owner?: { login?: string } };
    const files = Object.values(g.files ?? {});
    const file = files.find((f) => f.filename.toLowerCase().endsWith(`.${kind}.json`)) ?? files.find((f) => /\.json$/i.test(f.filename));
    if (!file) throw bad(`That gist has no .${kind}.json file.`);
    const text = file.truncated && file.raw_url ? await get(file.raw_url, false) : String(file.content ?? '');
    return { json: parseJson(text), source: { kind: 'gist', url: `gist:${gist[1]}`, owner: g.owner?.login ?? '' } };
  }
  if (!/^https:\/\//i.test(s)) throw bad(`A ${kind === 'crew' ? 'crew' : kind} link is an https URL or gist:<id>.`);
  return { json: parseJson(await get(s, false)), source: { kind: 'url', url: s } };
}

/** Links to open: only http(s), at most MAX_OPEN. */
export function openable(urls: unknown): string[] {
  const list = (Array.isArray(urls) ? urls : [urls]).map(String).filter((u) => /^https?:\/\/[^\s"']+$/i.test(u));
  if (!list.length) throw bad('Nothing to open: only http(s) links.');
  return list.slice(0, MAX_OPEN);
}

/** How the default browser opens a link, per platform (v1 openUrls). */
export function openCommand(platform: string, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  return ['xdg-open', [url]];
}
