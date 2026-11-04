// What a goal's checker said and did, to read afterwards like a task. A check is a side run
// (quick.js), not a task: up to 5 judges a round and 50 rounds kept would be hundreds of sessions
// that every list, summary and start walks through. So each run is a small file of its own,
// ~/.wisp/goal-runs/<task>/<run>.json, holding one turn in the shape a task's turn has, which the
// page renders with the task's transcript (web/js/features/goal-run.js). Nothing here touches the
// task list, Needs you, search, notifications or usage.
//
// A record: { id, task, turnId, round, name, agent, model?, effort?, crew?, status, end?, verdict?,
//             why?, next?, evidence?, turn: { id, prompt, status, startedAt, endedAt?, activity, raw, trimmed? } }
// status: running · done · stopped · error
// end: how a run with no verdict ended: timeout · stopped · error · nojson · interrupted (wisp restarted)

import fs from 'node:fs';
import path from 'node:path';
import { stepOf, stepOutput } from './runner.js';
import { clip, newId, writeJsonAtomic } from './util.js';

// The prompt embeds the diff (20 KB at most), the task and the agent's claim, so it stays whole in
// practice. The steps keep their latest, like a turn: the end of a run is what tells how it went.
const MAX_PROMPT = 40_000;
const MAX_STEPS = 200;
const MAX_STEP_BYTES = 120_000;
const MAX_EVIDENCE = 8;
const SAVE_MS = 500;
const ID = /^[a-f0-9]{12}$/;

const sizeOf = (a) => (a.label?.length || 0) + (a.detail?.length || 0) + (a.output?.length || 0);

// The runs a goal's checks point at.
export const refsOf = (g) => (g?.checks || []).flatMap((c) => [c.run, ...(c.votes || []).map((v) => v.run)]).filter(Boolean);

export class GoalRuns {
  // onChange({ sessionId, run, item?, update?, done? }): a step came in, changed, or the run ended.
  constructor({ store, onChange }) {
    this.store = store;
    this.onChange = onChange;
    this.active = new Map(); // id -> the record of a run under way
    this.timers = new Map();
  }

  #file(task, id) {
    return path.join(this.store.goalRuns, task, `${id}.json`);
  }

  start(session, { turnId, round, prompt, ...who }) {
    const id = newId();
    const rec = { id, task: session.id, turnId, round, ...who, status: 'running', turn: { id, prompt: String(prompt).slice(0, MAX_PROMPT), status: 'running', startedAt: Date.now(), activity: [], raw: '' } };
    this.active.set(id, rec);
    this.#save(rec, { now: true });
    return rec;
  }

  // An event of its run (askJson's onEvent).
  event(rec, e) {
    if (!this.active.has(rec.id)) return;
    const t = rec.turn;
    switch (e.type) {
      case 'tool':
      case 'tool_error':
      case 'text':
        return this.#step(rec, stepOf(e));
      case 'thinking':
        if (e.text) this.#step(rec, stepOf({ type: 'text', text: e.text }));
        return;
      case 'blocked':
        return this.#step(rec, { t: Date.now(), kind: 'answer', label: `Refused: ${clip(String(e.detail || e.tool || 'a tool'), 120)}` });
      case 'tool_output': {
        const item = stepOutput(t.activity, e);
        if (!item) return;
        this.#fit(t);
        this.#save(rec);
        return this.onChange?.({ sessionId: rec.task, run: rec.id, item, update: true });
      }
      case 'timeout':
        rec.end = 'timeout';
        return;
      case 'result':
        t.raw = e.isError ? '' : e.text || '';
        if (e.isError) {
          rec.end ||= e.stopped ? 'stopped' : 'error';
          if (e.text && !e.stopped) this.#step(rec, stepOf({ type: 'tool_error', name: 'The run', text: String(e.text).slice(0, 2000) }));
        }
    }
  }

  // v: what the checker's reply came to ({ verdict, why, next, progress, evidence }), or null.
  finish(rec, v) {
    if (!this.active.has(rec.id)) return;
    const t = rec.turn;
    if (v) {
      const evidence = (Array.isArray(v.evidence) ? v.evidence : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_EVIDENCE).map((x) => clip(x.trim(), 400));
      Object.assign(rec, { verdict: v.verdict, why: v.why, ...(v.next && { next: v.next }), ...(v.progress != null && { progress: v.progress }), ...(evidence.length && { evidence }) });
    } else {
      rec.verdict = 'unchecked';
      rec.end ||= 'nojson';
      t.raw = ''; // not an answer the page can show as one: its last message stays a message
    }
    rec.status = rec.end === 'timeout' || rec.end === 'stopped' ? 'stopped' : rec.end === 'error' ? 'error' : 'done';
    Object.assign(t, { status: rec.status, endedAt: Date.now() });
    this.active.delete(rec.id);
    this.#save(rec, { now: true });
    this.onChange?.({ sessionId: rec.task, run: rec.id, done: true });
  }

  // The record, as it stands. One the disk says is running but nobody is: wisp restarted under it.
  read(task, id) {
    if (!ID.test(String(id))) return null;
    const live = this.active.get(id);
    if (live) return live.task === task ? structuredClone(live) : null;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(this.#file(task, id), 'utf8'));
    } catch {
      return null;
    }
    if (rec.status === 'running') {
      Object.assign(rec, { status: 'stopped', end: 'interrupted', verdict: 'unchecked' });
      rec.turn.status = 'stopped';
    }
    return rec;
  }

  // Everything of the task's but these and what's under way goes.
  keep(task, refs) {
    const dir = path.join(this.store.goalRuns, task);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const kept = new Set(refs);
    for (const f of names) {
      const id = f.replace(/\.json$/, '');
      if (kept.has(id) || this.active.has(id)) continue;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  #step(rec, item) {
    rec.turn.activity.push(item);
    this.#fit(rec.turn);
    this.#save(rec);
    this.onChange?.({ sessionId: rec.task, run: rec.id, item });
  }

  // The oldest steps go past the cap; the transcript says how many.
  #fit(t) {
    let bytes = t.activity.reduce((n, a) => n + sizeOf(a), 0);
    while (t.activity.length > 1 && (t.activity.length > MAX_STEPS || bytes > MAX_STEP_BYTES)) {
      bytes -= sizeOf(t.activity.shift());
      t.trimmed = (t.trimmed || 0) + 1;
    }
  }

  // A stopped or crashed run keeps what it got: it's written as it goes, not only at the end.
  #save(rec, { now = false } = {}) {
    const write = () => {
      this.timers.delete(rec.id);
      if (!this.store.get(rec.task)) return; // deleted under it: its folder went with it
      const file = this.#file(rec.task, rec.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, rec);
    };
    if (now) {
      clearTimeout(this.timers.get(rec.id));
      return write();
    }
    if (this.timers.has(rec.id)) return;
    const t = setTimeout(write, SAVE_MS);
    t.unref?.();
    this.timers.set(rec.id, t);
  }
}
