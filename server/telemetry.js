// Anonymous usage analytics + error reports, sent to PostHog over its plain HTTP API (no SDK, to
// stay dependency-free). What goes out is fixed values only — agent, model, mode, status, timings,
// counts — never prompts, paths, project names or agent output. Error messages and stacks are
// scrubbed of the home directory and truncated.
//
// Off when any of: no API key, DO_NOT_TRACK=1, WISP_TELEMETRY=0, CI, or "telemetry": "off" in
// settings. See the Telemetry section of the README.
//
// Feedback (thumbs on a result, /feedback, "Send feedback") is different: the user hands it to us
// on purpose, so it goes out even with usage stats off. Only WISP_FEEDBACK=0 or no key stops it.
// Offline, it waits in feedback-outbox.json and goes with the next feedback or the next start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// PostHog project API key: write-only, safe to ship in the client.
const KEY = process.env.WISP_POSTHOG_KEY ?? 'phc_wowwZkbP8e4zYuwT67JtX6oxdPwkMWL5kKnrUmYYXhcD';
const HOST = (process.env.WISP_POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
const FLUSH_MS = 15_000;
const MAX_QUEUE = 50;
const TIMEOUT_MS = 3000;

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const truthy = (v) => !!v && !/^(0|false|no|off)$/i.test(v);

const falsy = (v) => /^(0|false|no|off)$/i.test(v || '');

export function envDisabled(env = process.env) {
  return !KEY || truthy(env.DO_NOT_TRACK) || falsy(env.WISP_TELEMETRY) || truthy(env.CI);
}

export const feedbackAvailable = (env = process.env) => !!KEY && !falsy(env.WISP_FEEDBACK);
const FEEDBACK_MAX = 4000;
const OUTBOX_MAX = 100;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Paths in messages and stacks would leak usernames and project names: wisp's own files keep
// their package-relative path, anything else is cut down to its file name.
export function scrub(text = '', { home = os.homedir(), root = ROOT } = {}) {
  let s = String(text).split(root).join('<wisp>');
  if (home) s = s.split(home).join('~');
  // Any other absolute path keeps only its file name.
  return s
    .replace(/(?<![\w<>~.:/\\-])(?:~|[A-Za-z]:)?[/\\](?:[^\s'"`():/\\]+[/\\])+([^\s'"`():/\\]*)/g, (m, base) => `…/${base}`)
    .slice(0, 500);
}

function frames(stack = '') {
  return String(stack)
    .split('\n')
    .slice(1, 30)
    .map((l) => l.trim().match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/))
    .filter(Boolean)
    .map(([, fn, file, line, col]) => ({ platform: 'custom', lang: 'javascript', function: fn || '?', filename: scrub(file.replace(/^file:\/\//, '')), lineno: +line, colno: +col, in_app: file.includes(ROOT) && !file.includes('node_modules') }))
    .reverse(); // PostHog wants the innermost frame last
}

export class Telemetry {
  constructor(store, { shell = process.versions.electron ? 'electron' : 'browser', post } = {}) {
    this.store = store;
    this.queue = [];
    this.pendingFile = path.join(store.home, 'telemetry-pending.json');
    this.outboxFile = path.join(store.home, 'feedback-outbox.json');
    if (post) this.post = post;
    this.common = {
      $lib: 'wisp',
      $process_person_profile: false, // anonymous events: no person profiles
      version: VERSION,
      os: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron || undefined,
      shell,
    };
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
    this.#sendPending();
    this.#sendOutbox();
  }

  get enabled() {
    return !envDisabled() && this.store.config.defaults.telemetry !== 'off';
  }

  track(event, props = {}) {
    if (!this.enabled) return;
    if (!this.store.config.telemetryId) {
      this.store.config.telemetryId = randomUUID(); // random per install, not tied to the machine or user
      this.store.saveConfig();
    }
    this.queue.push({ event, timestamp: new Date().toISOString(), properties: { ...this.common, ...props, distinct_id: this.store.config.telemetryId } });
    if (this.queue.length >= MAX_QUEUE) this.flush();
  }

  // PostHog error tracking format.
  captureError(err, props = {}) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.track('$exception', {
      ...props,
      $exception_list: [{ type: props.type || e.name || 'Error', value: scrub(e.message), mechanism: { handled: props.handled ?? true, synthetic: false }, stacktrace: { type: 'raw', frames: frames(e.stack) } }],
    });
  }

  // Thumbs on a turn ('turn_rated') or a written note ('feedback'). Resolves true once PostHog has
  // it; false means it's kept in the outbox and retried.
  async feedback(event, props = {}) {
    if (!feedbackAvailable()) return false;
    // With usage stats off, a fresh id per message so feedback can't be tied to anything else.
    const id = (this.enabled && this.store.config.telemetryId) || randomUUID();
    const text = props.text ? String(props.text).split(os.homedir()).join('~').slice(0, FEEDBACK_MAX) : undefined;
    const ev = { event, timestamp: new Date().toISOString(), properties: { ...this.common, ...props, text, distinct_id: id } };
    const batch = [...this.#outbox(), ev].slice(-OUTBOX_MAX);
    const ok = await this.post(batch);
    try {
      if (ok) fs.rmSync(this.outboxFile, { force: true });
      else fs.writeFileSync(this.outboxFile, JSON.stringify(batch));
    } catch {}
    return ok;
  }

  #outbox() {
    try {
      const list = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async post(batch) {
    try {
      const res = await fetch(`${HOST}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: KEY, batch }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async flush() {
    if (!this.queue.length) return;
    await this.post(this.queue.splice(0)); // offline or blocked: drop it, telemetry must never get in the way
  }

  // Shutdown and crashes leave no time for a request: write what's queued to disk (sync) and
  // send it on the next start.
  persist() {
    clearInterval(this.timer);
    if (!this.queue.length) return;
    try {
      fs.writeFileSync(this.pendingFile, JSON.stringify(this.queue.splice(0)));
    } catch {}
  }

  crashed(err) {
    if (!this.enabled) return;
    this.captureError(err, { handled: false, type: err?.name || 'UncaughtException' });
    this.persist();
  }

  #sendOutbox() {
    const batch = this.#outbox();
    if (!batch.length || !feedbackAvailable()) return;
    this.post(batch).then((ok) => ok && fs.rmSync(this.outboxFile, { force: true }));
  }

  #sendPending() {
    try {
      const pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
      fs.rmSync(this.pendingFile, { force: true });
      if (this.enabled && Array.isArray(pending)) this.queue.push(...pending.slice(-200));
    } catch {}
  }
}
