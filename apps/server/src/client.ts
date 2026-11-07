// wisp client SDK: everything the web UI can do, from Node (or anything with fetch). Zero dependencies.
// Used by the `wisp` CLI and the MCP server; importable as `wisp-agents/client`. It speaks v1's HTTP
// API, which v2 keeps, so it works against either.
//
//   import { WispClient } from 'wisp-agents/client';
//   const wisp = await WispClient.connect();            // finds the running wisp, or starts one
//   const s = await wisp.launch({ prompt: 'fix the flaky auth test', cwd: process.cwd() });
//   const done = await wisp.wait(s.id);                  // until it finishes or asks you something
//   console.log((await wisp.presentation(s.id)).markdown);
//
// The shapes it sends and gets back are in client-types.ts, re-exported from here.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageRoot } from './cli/root.ts';
import { DEFAULT_PORT } from './meta.ts';
import type { Btw, Config, CrewMember, Health, Launched, LaunchOptions, MergeResult, Presentation, PullRequest, Recipe, ReplyOptions, ReplyResult, ServerInfo, Session, SessionFilter, SessionSummary, Usage, WaitResult, WispEvent } from './client-types.ts';

export type * from './client-types.ts';
export { DEFAULT_PORT };

const MAX_WAIT_CALL = 280; // seconds per long-poll; fetch gives up on headers after 300s
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Env = Record<string, string | undefined>;

/** What `--try subagents=haiku,skills=off` (repeatable) changes in the second run, as compare[] takes it. */
export interface TryChange {
  subagentModel?: string;
  skills?: 'off';
}

export function tryRuns(list: readonly string[]): TryChange {
  const out: TryChange = {};
  for (const x of list.flatMap((v) => String(v).split(',')).filter(Boolean)) {
    const [key, value] = x.split('=');
    if (key === 'subagents' && (value === 'haiku' || value === 'sonnet' || value === 'task')) out.subagentModel = value === 'task' ? '' : value;
    else if (key === 'skills' && value === 'off') out.skills = 'off';
    else throw new Error('Use --try subagents=haiku|sonnet|task or --try skills=off');
  }
  return out;
}

export interface TryFlags {
  agent?: string | null | undefined;
  compare?: unknown;
  mode?: string | null | undefined;
  worktree?: boolean | undefined;
}

/** Why `--try` can't go with these flags, or null. Said here: nothing has to start to refuse it. */
export function tryProblem({ agent, compare, mode, worktree }: TryFlags): string | null {
  if (!agent || agent === 'auto') return '--try needs --agent: pick a harness first';
  if (compare) return '--try is its own comparison: leave out --compare';
  if (mode === 'plan') return '--try needs edits to compare, so it doesn’t run in Plan mode';
  if (worktree === false) return '--try keeps a worktree per run: leave out --no-worktree';
  return null;
}

export const wispHome = (env: Env = process.env): string => env['WISP_HOME'] || path.join(os.homedir(), '.wisp');

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The running server advertises itself in ~/.wisp/server.json. A stale file (dead pid) is ignored. */
export function discover(home: string = wispHome()): ServerInfo | null {
  try {
    const info: unknown = JSON.parse(readFileSync(path.join(home, 'server.json'), 'utf8'));
    if (!isRecord(info) || typeof info['port'] !== 'number') return null;
    if (typeof info['pid'] === 'number' && info['pid']) process.kill(info['pid'], 0);
    return info as ServerInfo;
  } catch {
    return null;
  }
}

export class WispError extends Error {
  /** the HTTP status, 0 when no server answered */
  readonly status: number;
  readonly body: unknown;
  /** v2's error shape: { code, message, retry } */
  readonly code: string | undefined;
  readonly retry: boolean | undefined;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'WispError';
    this.status = status;
    this.body = body;
    const e = isRecord(body) && isRecord(body['error']) ? body['error'] : body;
    this.code = isRecord(e) && typeof e['code'] === 'string' ? e['code'] : undefined;
    this.retry = isRecord(e) && typeof e['retry'] === 'boolean' ? e['retry'] : undefined;
  }
}

/** v1 answers { error: 'text' }, v2 { error: { code, message, retry } } (or the shape at the top). */
function errorMessage(json: unknown, fallback: string): string {
  if (!isRecord(json)) return fallback;
  const e = json['error'];
  if (typeof e === 'string' && e) return e;
  if (isRecord(e) && typeof e['message'] === 'string') return e['message'];
  return typeof json['message'] === 'string' && json['message'] ? json['message'] : fallback;
}

export type RequestBody = Uint8Array | ArrayBuffer | object;

export interface RequestOptions {
  signal?: AbortSignal | undefined;
}

export interface ClientOptions {
  /** e.g. http://127.0.0.1:4477. Defaults to WISP_PORT, then server.json, then 4477. */
  url?: string | undefined;
  port?: number | undefined;
  /** sent as a bearer token; defaults to WISP_TOKEN, then server.json's when it is that server */
  token?: string | undefined;
}

export interface ConnectOptions extends ClientOptions {
  /** launch a headless wisp if none answers (default true) */
  start?: boolean;
  timeoutMs?: number;
}

// The local server's token goes only to that server: never to a url someone else passed in.
function tokenFor(url: string, explicit: string | undefined, info: ServerInfo | null): string | undefined {
  if (explicit) return explicit;
  if (process.env['WISP_TOKEN']) return process.env['WISP_TOKEN'];
  if (!info?.token) return undefined;
  const u = new URL(url);
  return LOOPBACK.has(u.hostname) && Number(u.port || 80) === info.port ? info.token : undefined;
}

export class WispClient {
  readonly url: string;
  #token: string | undefined;

  constructor({ url, port, token }: ClientOptions = {}) {
    const info = discover();
    const p = port || Number(process.env['WISP_PORT']) || info?.port || DEFAULT_PORT;
    this.url = (url || `http://127.0.0.1:${p}`).replace(/\/$/, '');
    this.#token = tokenFor(this.url, token, info);
  }

  /** Connect to the running wisp; with start (default), launch a headless one if none answers. */
  static async connect({ start = true, timeoutMs = 15_000, ...opts }: ConnectOptions = {}): Promise<WispClient> {
    const client = new WispClient(opts);
    if (await client.ping()) return client;
    if (!start) throw new WispError(`wisp is not running at ${client.url}`, 0);
    const child = spawn(process.execPath, [packageRoot().bin, '--no-open', '--port', new URL(client.url).port || String(DEFAULT_PORT)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // an Electron app using this SDK: its execPath is Electron
    });
    child.unref();
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await client.ping()) {
        // The server it started wrote server.json (and its token) as it came up.
        client.#token = tokenFor(client.url, opts.token, discover());
        return client;
      }
      await sleep(150);
    }
    throw new WispError(`wisp did not start at ${client.url}`, 0);
  }

  async request(method: string, p: string, body: RequestBody | undefined, opts: RequestOptions & { raw: true }): Promise<Response>;
  async request<T = unknown>(method: string, p: string, body?: RequestBody, opts?: RequestOptions & { raw?: false }): Promise<T>;
  async request(method: string, p: string, body?: RequestBody, { raw = false, signal }: RequestOptions & { raw?: boolean } = {}): Promise<unknown> {
    // wisp takes only JSON on anything but a read, a body-less DELETE included.
    const sent = body === undefined && method !== 'GET' && method !== 'HEAD' ? {} : body;
    const isBuf = sent instanceof Uint8Array || sent instanceof ArrayBuffer;
    const headers: Record<string, string> = {};
    if (sent !== undefined) headers['content-type'] = isBuf ? 'application/octet-stream' : 'application/json';
    if (this.#token) headers['authorization'] = `Bearer ${this.#token}`;
    const init: RequestInit = { method, headers };
    if (signal) init.signal = signal;
    if (sent !== undefined) init.body = isBuf ? sent : JSON.stringify(sent);
    const res = await fetch(`${this.url}/api${p}`, init);
    if (raw && res.ok) return res;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    if (!res.ok) throw new WispError(errorMessage(json, res.statusText), res.status, json);
    return json;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.health()).ok === true;
    } catch {
      return false;
    }
  }

  health = (): Promise<Health> => this.request('GET', '/health');
  agents = (): Promise<unknown[]> => this.request('GET', '/agents');
  config = (): Promise<Config> => this.request('GET', '/config');
  machines = (): Promise<unknown> => this.request('GET', '/machines');
  updateConfig = (patch: object): Promise<Config> => this.request('PATCH', '/config', patch);

  projects = (): Promise<unknown[]> => this.request('GET', '/projects');
  addProject = (dir: string, { name }: { name?: string } = {}): Promise<unknown> => this.request('POST', '/projects', { path: path.resolve(dir), name });
  removeProject = (id: string): Promise<unknown> => this.request('DELETE', `/projects/${id}`);

  // The crew. A member is found by id, name or @handle.
  crew = (): Promise<CrewMember[]> => this.request('GET', '/crew');
  crewMember = (id: string): Promise<CrewMember> => this.request('GET', `/crew/${encodeURIComponent(id)}`);
  addCrew = (member: object): Promise<CrewMember> => this.request('POST', '/crew', member); // { name, role, brief, cwd, agent, …, checkin }
  updateCrew = (id: string, patch: object): Promise<CrewMember> => this.request('PATCH', `/crew/${encodeURIComponent(id)}`, patch);
  removeCrew = (id: string): Promise<unknown> => this.request('DELETE', `/crew/${encodeURIComponent(id)}`);
  importCrew = <T = unknown>(body: object): Promise<T> => this.request('POST', '/crew/import', body); // { text | url, choices, dryRun }
  exportCrew = <T = unknown>(body: object): Promise<T> => this.request('POST', '/crew/export', body); // { ids, kit, notebook, team, gist }

  sessions(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]): [string, string] => [k, String(v)]));
    return this.request('GET', `/sessions${q.size ? `?${q}` : ''}`);
  }
  session = (id: string): Promise<Session> => this.request('GET', `/sessions/${id}`);
  presentation = (id: string, { turn }: { turn?: string | number } = {}): Promise<Presentation> =>
    this.request('GET', `/sessions/${id}/presentation${turn !== undefined ? `?turn=${encodeURIComponent(turn)}` : ''}`);
  update = (id: string, patch: object): Promise<SessionSummary> => this.request('PATCH', `/sessions/${id}`, patch); // { title, state, unread, archived, forLater }
  remove = (id: string): Promise<unknown> => this.request('DELETE', `/sessions/${id}`);
  stop = (id: string): Promise<unknown> => this.request('POST', `/sessions/${id}/stop`, {});
  answer = (id: string, text: string): Promise<unknown> => this.request('POST', `/sessions/${id}/answer`, { text });
  revert = (id: string, fileOrOpts?: string | object, opts: object = {}): Promise<{ reverted: boolean } & Record<string, unknown>> => {
    const body = typeof fileOrOpts === 'string' ? { file: fileOrOpts, ...opts } : fileOrOpts || {};
    return this.request('POST', `/sessions/${id}/revert`, body);
  };
  rollback = (id: string, { turnId, restore = false }: { turnId?: string; restore?: boolean } = {}): Promise<{ rolledBack: boolean } & Record<string, unknown>> =>
    this.request('POST', `/sessions/${id}/rollback`, { turnId, restore });
  exec = (id: string, cmdOrOpts?: string | object, opts: object = {}): Promise<{ exitCode: number; output: string } & Record<string, unknown>> => {
    const body = typeof cmdOrOpts === 'string' ? { command: cmdOrOpts, ...opts } : cmdOrOpts || {};
    return this.request('POST', `/sessions/${id}/exec`, body);
  };
  takeover = (id: string, { open = false }: { open?: boolean } = {}): Promise<unknown> => this.request(open ? 'POST' : 'GET', `/sessions/${id}/takeover`, open ? {} : undefined);

  /**
   * Launch a task. Missing agent/mode/model fall back to the launcher's remembered defaults, like
   * `wisp "…"` does; effort only if given. See LaunchOptions for the rest.
   */
  async launch(opts: LaunchOptions): Promise<Launched> {
    let { agent, mode, model, compare } = opts;
    if (!agent || !mode || model === undefined) {
      const defaults = (await this.config()).defaults ?? {};
      agent ||= defaults.agent || 'auto';
      mode ||= defaults.mode || 'auto';
      model ??= defaults.models?.[agent] ?? (agent === defaults.agent ? defaults.model || '' : '');
    }
    const lead = model;
    if (opts.trial) compare = compare?.map((c) => ({ ...c, model: c.model ?? lead })); // a copy of the lead: its model as the launch settled it
    const { prompt, effort, attachments, worktree, subagents, preset, kind, machine, confirmLimit, subagentModel, skills, trial } = opts;
    const also = opts.also?.length ? opts.also.map((d) => path.resolve(d)) : undefined;
    return this.request('POST', '/sessions', { prompt, cwd: path.resolve(opts.cwd ?? process.cwd()), also, agent, mode, model, effort, attachments, worktree, compare, subagents, preset, kind, machine, confirmLimit, subagentModel, skills, trial });
  }

  // Ship it: commit the session's worktree, push its branch, open (or update) the PR.
  ship = (id: string, { title, body, draft }: { title?: string; body?: string; draft?: boolean } = {}): Promise<PullRequest> => this.request('POST', `/sessions/${id}/ship`, { title, body, draft });
  merge = (id: string): Promise<MergeResult> => this.request('POST', `/sessions/${id}/merge`, {});

  // Recipes: saved prompts with {params}. key is the id or the name.
  recipes = (): Promise<Recipe[]> => this.request('GET', '/recipes');
  saveRecipe = (recipe: Partial<Recipe>): Promise<Recipe> => this.request(recipe.id ? 'PATCH' : 'POST', `/recipes${recipe.id ? `/${recipe.id}` : ''}`, recipe);
  runRecipe = (key: string, { cwd = process.cwd(), ...rest }: { params?: Record<string, string>; words?: string[]; cwd?: string; agent?: string | undefined; model?: string | undefined; effort?: string | undefined; mode?: string | undefined } = {}): Promise<Launched> =>
    this.request('POST', `/recipes/${encodeURIComponent(key)}/run`, { params: rest.params, words: rest.words, cwd: path.resolve(cwd), agent: rest.agent, model: rest.model, effort: rest.effort, mode: rest.mode });
  triggers = (): Promise<unknown[]> => this.request('GET', '/triggers');
  usage = ({ days }: { days?: number } = {}): Promise<Usage> => this.request('GET', `/usage${days ? `?days=${days}` : ''}`);

  // A follow-up. If the agent is blocked on ask_user, this answers it. queue: wait for the current run
  // instead of interrupting it (default: the user's setting). agent / model / effort: run it, and the
  // follow-ups after it, on another harness, model or thinking level.
  reply = (id: string, text: string, opts: ReplyOptions = {}): Promise<ReplyResult> =>
    this.request('POST', `/sessions/${id}/reply`, { text, attachments: opts.attachments, queue: opts.queue, mode: opts.mode, agent: opts.agent, model: opts.model, effort: opts.effort, confirmLimit: opts.confirmLimit });

  /**
   * A side question (/btw): a read-only run of its own answers it while the task's run carries on.
   * Resolves once it's answered (status stays running if timeoutMs runs out first), or at once with wait: false.
   */
  async btw(id: string, text: string, { attachments, wait = true, timeoutMs = 6 * 60_000 }: { attachments?: string[]; wait?: boolean; timeoutMs?: number } = {}): Promise<Btw> {
    const q = await this.request<Btw>('POST', `/sessions/${id}/btw`, { text, attachments });
    return wait ? this.btwAnswer(id, q.id, { timeoutMs }) : q;
  }

  async btwAnswer(id: string, btwId: string, { timeoutMs = 6 * 60_000 }: { timeoutMs?: number } = {}): Promise<Btw> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.session(id);
      const b = s.turns.flatMap((t) => t.btw ?? []).find((x) => x.id === btwId);
      if (!b) return { id: btwId, status: 'error', error: 'It was dismissed.' };
      if (b.status !== 'running' || Date.now() > end) return b;
      await sleep(1500);
    }
  }

  /** Upload a file (path, Buffer or Uint8Array) to attach to a launch or reply. Returns { id, … }. */
  async upload(file: string | Uint8Array, { name, type }: { name?: string; type?: string } = {}): Promise<{ id: string } & Record<string, unknown>> {
    const data = typeof file === 'string' ? await readFile(file) : file;
    const q = new URLSearchParams({ name: name || (typeof file === 'string' ? path.basename(file) : 'file'), ...(type ? { type } : {}) });
    return this.request('POST', `/uploads?${q}`, data);
  }

  /** Resolve once the session needs you: finished (review/done) or waiting on a question; { timedOut } when timeoutMs runs out first. */
  async wait(id: string, { timeoutMs = 30 * 60_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const s = await this.request<WaitResult>('GET', `/sessions/${id}/wait?timeout=${Math.min(left, MAX_WAIT_CALL)}`, undefined, { signal });
      if (!s.timedOut || left <= MAX_WAIT_CALL) return s;
    }
  }

  /** Live server events (the stream the UI uses) as { event, data }: summary, activity, turn, finished, removed, config, ping. */
  async *events({ signal }: { signal?: AbortSignal } = {}): AsyncGenerator<WispEvent> {
    const res = await this.request('GET', '/events', undefined, { raw: true, signal });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        yield parseFrame(frame);
      }
    }
  }
}

export function parseFrame(frame: string): WispEvent {
  const event = /^event: (.*)$/m.exec(frame)?.[1] || 'message';
  const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
  try {
    return { event, data: data ? (JSON.parse(data) as unknown) : null };
  } catch {
    return { event, data };
  }
}
