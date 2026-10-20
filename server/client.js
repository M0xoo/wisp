// wisp client SDK: everything the web UI can do, from Node (or anything with fetch).
// Zero dependencies. Used by the `wisp` CLI and the `wisp mcp` server; importable as
// `wisp-agents/client`.
//
//   import { WispClient } from 'wisp-agents/client';
//   const wisp = await WispClient.connect();            // finds the running wisp, or starts one
//   const s = await wisp.launch({ prompt: 'fix the flaky auth test', cwd: process.cwd() });
//   const done = await wisp.wait(s.id);                  // until it finishes or asks you something
//   console.log((await wisp.presentation(s.id)).markdown);

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './util.js';

export { DEFAULT_PORT };
const BIN = fileURLToPath(new URL('../bin/wisp.js', import.meta.url));
const MAX_WAIT_CALL = 280; // seconds per long-poll; fetch gives up on headers after 300s

export const wispHome = () => process.env.WISP_HOME || path.join(os.homedir(), '.wisp');

// The running server advertises itself in ~/.wisp/server.json. Stale files (dead pid) are ignored.
export function discover(home = wispHome()) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    if (info.pid) process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

export class WispError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'WispError';
    this.status = status;
    this.body = body;
  }
}

export class WispClient {
  // url: e.g. http://127.0.0.1:4477. Defaults to WISP_PORT, then server.json, then 4477.
  constructor({ url, port } = {}) {
    const p = port || Number(process.env.WISP_PORT) || discover()?.port || DEFAULT_PORT;
    this.url = (url || `http://127.0.0.1:${p}`).replace(/\/$/, '');
  }

  // Connect to the running wisp; with start (default), launch a headless one if none answers.
  static async connect({ url, port, start = true, timeoutMs = 15_000 } = {}) {
    const client = new WispClient({ url, port });
    if (await client.ping()) return client;
    if (!start) throw new WispError(`wisp is not running at ${client.url}`, 0);
    const child = spawn(process.execPath, [BIN, '--no-open', '--port', new URL(client.url).port || String(DEFAULT_PORT)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await client.ping()) return client;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new WispError(`wisp did not start at ${client.url}`, 0);
  }

  async request(method, p, body, { raw = false, signal } = {}) {
    const isBuf = body instanceof Uint8Array || body instanceof ArrayBuffer;
    const res = await fetch(`${this.url}/api${p}`, {
      method,
      signal,
      headers: body === undefined ? {} : { 'content-type': isBuf ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
    });
    if (raw && res.ok) return res;
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    if (!res.ok) throw new WispError(json.error || res.statusText, res.status, json);
    return json;
  }

  async ping() {
    try {
      return (await this.health()).ok === true;
    } catch {
      return false;
    }
  }

  health = () => this.request('GET', '/health');
  agents = () => this.request('GET', '/agents');
  config = () => this.request('GET', '/config');
  updateConfig = (patch) => this.request('PATCH', '/config', patch);

  projects = () => this.request('GET', '/projects');
  addProject = (dir, { name } = {}) => this.request('POST', '/projects', { path: path.resolve(dir), name });
  removeProject = (id) => this.request('DELETE', `/projects/${id}`);

  // filter: { state, cwd, project, archived, limit }
  sessions(filter = {}) {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    return this.request('GET', `/sessions${q.size ? `?${q}` : ''}`);
  }
  session = (id) => this.request('GET', `/sessions/${id}`);
  presentation = (id, { turn } = {}) => this.request('GET', `/sessions/${id}/presentation${turn !== undefined ? `?turn=${encodeURIComponent(turn)}` : ''}`);
  update = (id, patch) => this.request('PATCH', `/sessions/${id}`, patch); // { title, state, unread, archived }
  remove = (id) => this.request('DELETE', `/sessions/${id}`);
  stop = (id) => this.request('POST', `/sessions/${id}/stop`, {});
  answer = (id, text) => this.request('POST', `/sessions/${id}/answer`, { text });
  revert = (id, fileOrOpts, opts = {}) => {
    const body = typeof fileOrOpts === 'string' ? { file: fileOrOpts, ...opts } : fileOrOpts || {};
    return this.request('POST', `/sessions/${id}/revert`, body);
  };
  rollback = (id, { turnId, restore = false } = {}) => this.request('POST', `/sessions/${id}/rollback`, { turnId, restore });
  exec = (id, cmdOrOpts, opts = {}) => {
    const body = typeof cmdOrOpts === 'string' ? { command: cmdOrOpts, ...opts } : cmdOrOpts || {};
    return this.request('POST', `/sessions/${id}/exec`, body);
  };
  takeover = (id, { open = false } = {}) => this.request(open ? 'POST' : 'GET', `/sessions/${id}/takeover`, open ? {} : undefined);

  // { prompt, cwd, agent, mode, model, effort, attachments: [uploadId] }. Missing agent/mode/model
  // fall back to the launcher's remembered defaults, like `wisp "…"` does; effort only if given.
  // worktree: true/false overrides the default (on in git repos). compare: [{ agent, model, effort }]
  // runs the same task on more harnesses at once, each in its own worktree. subagents:
  // [{ name, agent, model, effort, use }] (or preset: a saved team's id) the lead can delegate to.
  // also: more folders the same task works in (each git repo gets its own worktree and PR).
  async launch({ prompt, cwd = process.cwd(), also, agent, mode, model, effort, attachments, worktree, compare, subagents, preset } = {}) {
    if (!agent || !mode || model === undefined) {
      const { defaults = {} } = await this.config();
      agent ||= defaults.agent || 'auto';
      mode ||= defaults.mode || 'auto';
      model ??= defaults.models?.[agent] ?? (agent === defaults.agent ? defaults.model || '' : '');
    }
    return this.request('POST', '/sessions', { prompt, cwd: path.resolve(cwd), also: also?.length ? also.map((d) => path.resolve(d)) : undefined, agent, mode, model, effort, attachments, worktree, compare, subagents, preset });
  }

  // Ship it: commit the session's worktree, push its branch, open (or update) the PR.
  ship = (id, { title, body, draft } = {}) => this.request('POST', `/sessions/${id}/ship`, { title, body, draft });
  merge = (id) => this.request('POST', `/sessions/${id}/merge`, {});

  // Recipes: saved prompts with {params}. key is the id or the name.
  recipes = () => this.request('GET', '/recipes');
  saveRecipe = (recipe) => this.request(recipe.id ? 'PATCH' : 'POST', `/recipes${recipe.id ? `/${recipe.id}` : ''}`, recipe);
  runRecipe = (key, { params, words, cwd = process.cwd(), agent, model, effort, mode } = {}) =>
    this.request('POST', `/recipes/${encodeURIComponent(key)}/run`, { params, words, cwd: path.resolve(cwd), agent, model, effort, mode });
  triggers = () => this.request('GET', '/triggers');
  usage = ({ days } = {}) => this.request('GET', `/usage${days ? `?days=${days}` : ''}`);

  // A follow-up. If the agent is blocked on ask_user, this answers it. queue: wait for the
  // current run instead of interrupting it (default: the user's setting). agent / model / effort:
  // run it, and the follow-ups after it, on another harness, model or thinking level.
  reply = (id, text, { attachments, queue, mode, agent, model, effort } = {}) => this.request('POST', `/sessions/${id}/reply`, { text, attachments, queue, mode, agent, model, effort });

  // Upload a file (path, Buffer or Uint8Array) to attach to a launch or reply. Returns { id, … }.
  async upload(file, { name, type } = {}) {
    const data = typeof file === 'string' ? fs.readFileSync(file) : file;
    name ||= typeof file === 'string' ? path.basename(file) : 'file';
    const q = new URLSearchParams({ name, ...(type ? { type } : {}) });
    return this.request('POST', `/uploads?${q}`, data);
  }

  // Resolve once the session needs you: finished (review/done) or waiting on a question.
  // Returns the session summary plus { timedOut } when timeoutMs runs out first.
  async wait(id, { timeoutMs = 30 * 60_000, signal } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const s = await this.request('GET', `/sessions/${id}/wait?timeout=${Math.min(left, MAX_WAIT_CALL)}`, undefined, { signal });
      if (!s.timedOut || left <= MAX_WAIT_CALL) return s;
    }
  }

  // Live server events (the same stream the UI uses), as an async iterator of { event, data }.
  // Events: summary, activity, turn, finished, removed, config, ping.
  async *events({ signal } = {}) {
    const res = await this.request('GET', '/events', undefined, { raw: true, signal });
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1] || 'message';
        const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        try {
          yield { event, data: data ? JSON.parse(data) : null };
        } catch {
          yield { event, data };
        }
      }
    }
  }
}
