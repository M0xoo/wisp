// Sharing a task with someone on your wisp Grid, and importing one they shared (grid/shares.js).
//
//   share    the task goes up as one bundle (server/bundle.js): task.json (its turns, harness,
//            model, team, connectors and skills, every secret in it redacted) and its work: a git
//            bundle of its branch and uncommitted changes (git.js packWork, as a move packs it),
//            or a folder-less task's files. The grid keeps it at <grid>/s/<id>, optionally behind a
//            passkey; sharing it again updates the same link.
//   peek     a link pasted in the New task box: what the card shows, asked of that grid.
//   import   a new task here with those turns as its history (every harness hears them first,
//            handoff.js), its work in a worktree of your checkout of the same repo (cloned when you
//            have none), the same harness and model when they're here (else the nearest, runHere),
//            their connectors added (a command one switched off until you've looked at it), their
//            skills for its agent, its delegates' runs as its subagents' sessions, and the crew
//            members it delegated to on your crew (crew-share.js), so its team works as it did.
//
// Only wisp signed in to a grid shares or imports: the grid asks for a device token (or the cloud
// wisp's own secret) on everything but the read-only page.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, listAgents } from '../adapters/index.js';
import { packDir, unpackTo } from '../bundle.js';
import { normalizeConnector } from '../connectors.js';
import { SKILL_DIRS, handleOf } from '../crew.js';
import { applyImport, exportCrew, parseCrewFile, planImport } from '../crew-share.js';
import { git, packWork, repoRoot, unpackWork } from '../git.js';
import { gridJson, target } from '../grid-client.js';
import { textMentions } from '../mentions.js';
import { redactSecrets } from '../secret-scan.js';
import { normalizeTeam } from '../subagents.js';
import { workdir } from '../runner.js';
import { bad, MODES, newId, truncate } from '../util.js';
import { parseSkillMd } from '../../web/js/skill-md.js';
import { checkout } from './places.js';
import { gridTargets } from './publish.js';

export const TASK_FILE = 1; // wispTask
const MAX = 100 * 1024 * 1024; // the grid says its own limit (413)
const FILES_MAX = 50 * 1024 * 1024; // a folder-less task's files
const EDITS_MAX = 200_000; // characters of captured edits per turn
// A share link: <grid>/s/<16 characters>.
export const SHARE_LINK = /^(https?:\/\/[^/\s]+)\/s\/([A-Za-z0-9_-]{16})\/?$/;

// "https://grid.example.com/s/abc…" → { origin, id }, or null.
export function parseShareLink(url) {
  const m = SHARE_LINK.exec(String(url || '').trim());
  return m && { origin: m[1].toLowerCase(), id: m[2] };
}

// Every string in v with its secrets redacted. → { value, hits }
export function redactDeep(v) {
  let hits = 0;
  const walk = (x) => {
    if (typeof x === 'string') {
      const r = redactSecrets(x);
      hits += r.hits;
      return r.text;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return { value: walk(v), hits };
}

// A turn as it's shared: what it asked and reported, and the files it touched. Nothing that only
// makes sense here (checkpoints, attachments' files, side questions, comments). Its delegations
// point at the shared run (task.runs[key]) and that run's turn: runOf(sessionId, turnId) → { run, turn }.
export function shareTurn(t, runOf = () => null) {
  let budget = EDITS_MAX;
  const changes = (t.changes || []).map(({ file, op, edits, reverted }) => {
    const text = JSON.stringify(edits || []);
    const keep = text.length <= budget;
    if (keep) budget -= text.length;
    return { file, ...(op && { op }), ...(reverted && { reverted }), edits: keep ? edits || [] : [] };
  });
  return {
    id: t.id,
    prompt: textMentions(t.prompt || ''),
    agent: t.agent || '',
    model: t.model || '',
    effort: t.effort || '',
    mode: t.mode || '',
    status: t.status === 'running' || t.status === 'held' ? 'stopped' : t.status || 'done',
    startedAt: t.startedAt || null,
    endedAt: t.endedAt || null,
    presentation: t.presentation || null,
    raw: truncate(t.raw || '', 20_000),
    changes,
    ...(t.stats && { stats: t.stats }),
    ...(t.rolledBackAt && { rolledBackAt: t.rolledBackAt }),
    ...(t.delegations?.length && {
      delegations: t.delegations.map((d) => ({ id: d.id, name: d.name, member: d.member || d.name, ...(d.crew && { crew: true }), agent: d.agent || '', model: d.model || '', effort: d.effort || '', prompt: textMentions(d.prompt || ''), startedAt: d.startedAt || null, ...runOf(d.sessionId, d.turnId) })),
    }),
  };
}

// The runs a task delegated, as shared: each subagent's session (by its slot, so the lead's team
// resumes it after an import) and each job a crew member did for it (by ~<name>-<n>: a job is the
// member's own task, so only the turn it ran for this lead goes). → { runs, runOf }
export function shareRuns(s, { get, crewKey = () => '' }) {
  const runs = {};
  const at = new Map(); // session id → { key, turns: [its turn ids, as shared] }
  for (const [slot, cid] of Object.entries(s.children || {})) {
    const c = get(cid);
    if (!c || !/^[\w.#-]{1,40}$/.test(slot)) continue;
    const turns = c.turns.filter((x) => x.status !== 'held');
    at.set(cid, { key: slot, ids: turns.map((x) => x.id) });
    runs[slot] = { name: slot, member: c.member || slot, agent: c.agent, model: c.model || '', effort: c.effort || '', turns };
  }
  let n = 0;
  for (const d of s.turns.flatMap((t) => t.delegations || [])) {
    if (!d.crew || at.has(`${d.sessionId}:${d.turnId}`)) continue;
    const job = get(d.sessionId);
    const turn = job?.turns.find((x) => x.id === d.turnId);
    if (!turn) continue;
    const key = `~${String(d.name || 'crew').replace(/[^\w.-]+/g, '-').slice(0, 30)}-${++n}`;
    at.set(`${d.sessionId}:${d.turnId}`, { key, ids: [turn.id] });
    runs[key] = { name: d.name, member: d.member || d.name, crew: crewKey(d.crew), agent: job.agent, model: job.model || '', effort: job.effort || '', title: job.title, turns: [turn] };
  }
  const runOf = (sid, tid) => {
    const r = at.get(`${sid}:${tid}`) || at.get(sid);
    return r ? { run: r.key, turn: Math.max(0, r.ids.indexOf(tid)) } : {};
  };
  for (const r of Object.values(runs)) r.turns = r.turns.map((t) => shareTurn(t, runOf));
  return { runs, runOf };
}

// The skills a turn's agent used ("Using the release-notes skill") that live in your own skill
// folders, not the project's (those come with the work).
export function usedSkills(turns, home = os.homedir()) {
  const names = new Set();
  for (const t of turns) for (const a of t.activity || []) {
    const m = /^Using the ([a-z0-9][a-z0-9-]{0,63}) skill$/.exec(a?.label || '');
    if (m) names.add(m[1]);
  }
  const out = [];
  for (const name of names) {
    for (const d of SKILL_DIRS) {
      const file = path.join(home, d, name, 'SKILL.md');
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const s = parseSkillMd(text);
      if (s?.body) out.push({ kind: 'skill', name, description: s.description || `The ${name} skill`, body: s.body });
      break;
    }
  }
  return out;
}

// Where a shared run carries on here (here: listAgents(), available ones). The same harness and
// model when this computer has them; that harness's nearest model (claude-opus-4-1 → opus) or its
// default when it doesn't offer that one; else `fallback`'s harness (the lead's), else the first
// installed. → { agent, model, effort, note } (note: what changed, for the import's notes).
export function runHere(here, want = {}, fallback = null) {
  const name = (id) => here.find((x) => x.id === id)?.name || adapters[id]?.name || id;
  const a = here.find((x) => x.id === want.agent);
  if (a) {
    const ids = (a.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    const model = String(want.model || '');
    const effort = !want.effort || !a.efforts?.length || a.efforts.includes(want.effort) ? want.effort || '' : '';
    if (!model || !ids.length || ids.includes(model)) return { agent: a.id, model, effort, note: '' }; // no list to check it against: it's tried as it is
    const near = ids.find((id) => model.toLowerCase().includes(id.toLowerCase()));
    if (near) return { agent: a.id, model: near, effort, note: '' };
    return { agent: a.id, model: '', effort: '', note: `${model} isn’t one of ${a.name}’s models here: it runs on ${a.name}’s default model` };
  }
  const f = fallback && here.some((x) => x.id === fallback.agent) ? fallback : { agent: here[0].id, model: '', effort: '' };
  return { agent: f.agent, model: f.model || '', effort: f.effort || '', note: `${name(want.agent) || 'Its harness'} isn’t installed here: ${name(f.agent)}${f.model ? ` (${f.model})` : ''} carries it on` };
}

// The crew key a shared run belongs to (its member's blueprint), or ''.
const runOfMember = (task, key) => task.runs?.[key]?.crew || '';

// A connector as shared: what it is, never its secrets (config only has the keys' names).
const shareConnector = (c) => ({ name: c.name, transport: c.transport, ...(c.transport === 'local' ? { command: c.command, args: c.args || [] } : { url: c.url }), env: c.env || [], headers: c.headers || [] });

// "https://user:token@github.com/a/b.git" → "https://github.com/a/b.git".
const cleanRemote = (u) => String(u || '').replace(/^(https?:\/\/)[^@/]+@/i, '$1');

export function createShare(app, { env = process.env } = {}) {
  const { store, runner } = app;
  const targets = () => gridTargets(app, env);

  const ask = async (t, method, p, opts = {}) => {
    let r;
    try {
      r = await gridJson(`${t.grid}${p}`, { method, timeout: 120_000, ...opts, headers: { authorization: t.auth, ...opts.headers } });
    } catch (err) {
      throw bad(`Couldn’t reach ${t.host}: ${err.message}`, 502);
    }
    if (r.status === 404 && !r.body?.error) throw bad(`${t.host} doesn’t share tasks yet (its wisp Grid is older).`, 409);
    if (r.status >= 400) throw Object.assign(bad(r.body.error || `${t.host} said ${r.status}.`, r.status === 401 && !r.body.locked ? 409 : r.status >= 500 ? 502 : r.status), r.body.locked ? { locked: true, from: r.body.from } : {});
    return r.body;
  };
  // Raw bytes back (the pack): gridJson reads text, so this asks with node's http directly.
  const fetchPack = async (t, id, passkey) => {
    const { lib, opts } = target(`${t.grid}/api/shares/${id}/pack`);
    return new Promise((resolve, reject) => {
      const req = lib.request({ ...opts, path: `/api/shares/${id}/pack`, method: 'GET', timeout: 300_000, headers: { authorization: t.auth, ...(passkey && { 'x-wisp-passkey': encodeURIComponent(passkey) }) } }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX) req.destroy(bad('That shared task is too big to import.', 413));
          else chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            let j = {};
            try {
              j = JSON.parse(buf.toString('utf8'));
            } catch {}
            return reject(Object.assign(bad(j.error || `${t.host} said ${res.statusCode}.`, res.statusCode), j.locked ? { locked: true } : {}));
          }
          resolve(buf);
        });
      });
      req.on('timeout', () => req.destroy(bad(`${t.host} didn’t answer in time.`, 504)));
      req.on('error', (err) => reject(Object.assign(err, { status: err.status || 502 })));
      req.end();
    });
  };

  // The grid a task goes to: the one it went to before, else the first you're signed in to.
  const pick = (id, was) => {
    const all = targets();
    const t = id ? all.find((x) => x.id === id) : all.find((x) => x.id === was?.account) || all.find((x) => x.host === was?.host) || all[0];
    if (!t) throw bad(all.length ? 'That grid isn’t signed in any more: Settings → Cloud.' : 'Sign in to a wisp Grid first (Settings → Cloud): tasks are shared with the people on it.', 409);
    return t;
  };
  // The grid a link is on, if this wisp is signed in to it. Links to other grids are never fetched.
  const gridOf = (link) => {
    const at = parseShareLink(link);
    if (!at) throw bad('That isn’t a link to a shared task.');
    const t = targets().find((x) => x.grid.toLowerCase() === at.origin);
    if (!t) throw bad(`Sign in to ${new URL(at.origin).host} first (Settings → Cloud): shared tasks open in wisp for the people on that grid.`, 409);
    return { t, id: at.id };
  };

  const shareable = (s) => {
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to share a task.');
    if (s.parentId || s.delegated) throw bad('A subagent’s run is shared with its lead’s task.');
    if (s.kind) throw bad('A spell is shared from Settings → Spells.');
    if (!s.turns.some((t) => t.status !== 'running' && t.status !== 'held')) throw bad('Nothing to share yet: wait for the first turn to finish.', 409);
  };

  // What a share would carry, for the dialog: where it goes, the work, connectors and skills.
  async function preview(s) {
    shareable(s);
    const scratch = store.isScratch(s.cwd);
    const root = scratch ? null : await repoRoot(workdir(s));
    const remote = root ? cleanRemote(await git(root, ['remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => '')) : '';
    const crewKit = (s.crew && app.crew?.get(s.crew.id)?.kit) || [];
    return {
      targets: targets().map(({ id, host, handle }) => ({ id, host, handle })),
      shared: s.shared || null,
      work: scratch ? { kind: 'files' } : root ? { kind: 'git', repo: remote, branch: s.worktree?.branch || '' } : null,
      connectors: (store.config.connectors || []).filter((c) => c.enabled !== false).map((c) => c.name),
      skills: [...crewKit.filter((k) => k.on !== false).map((k) => k.name), ...usedSkills(s.turns).map((k) => k.name)],
      // Its delegates: subagent runs and crew members' jobs (each goes, as a page of its own).
      delegates: Object.keys(s.children || {}).length + s.turns.flatMap((t) => t.delegations || []).filter((d) => d.crew).length,
      crew: [...new Set([...(s.subagents || []).filter((m) => m.crew).map((m) => m.crew), ...s.turns.flatMap((t) => (t.delegations || []).filter((d) => d.crew).map((d) => d.crew))])].map((id) => app.crew?.get(id)?.name).filter(Boolean),
      also: (s.also || []).length,
    };
  }

  // Share (or update) task s. passkey: '' for anyone with the link, else what opens it.
  // work: false leaves the files behind (the conversation alone).
  async function share(s, { passkey = '', work = true, account } = {}) {
    shareable(s);
    if (typeof passkey !== 'string' || passkey.length > 128) throw bad('A passkey is at most 128 characters.');
    const t = pick(account, s.shared);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-share-'));
    const notes = [];
    try {
      // The crew members it delegated to (or could), as blueprints (crew-share.js): who they are,
      // never their log or folder. key: what the shared team and runs call them.
      const crewIds = [...new Set([...(s.subagents || []).filter((m) => m.crew).map((m) => m.crew), ...s.turns.flatMap((t) => (t.delegations || []).filter((d) => d.crew).map((d) => d.crew))])].filter((id) => app.crew?.get(id));
      const crewOut = crewIds.length ? exportCrew(app.crew, crewIds, { kit: true, notebook: false, team: false }) : null;
      const crewKey = (id) => crewOut?.bundle.members[crewIds.indexOf(id)]?.key || '';
      const { runs, runOf } = shareRuns(s, { get: (id) => store.get(id) || runner.crewChild?.(id), crewKey });
      const turns = s.turns.filter((x) => x.status !== 'held').map((t) => shareTurn(t, runOf));
      const crewKit = ((s.crew && app.crew?.get(s.crew.id)?.kit) || []).filter((k) => k.on !== false).map(({ kind, name, description, body }) => ({ kind, name, ...(description && { description }), body }));
      const kit = [...crewKit, ...usedSkills(s.turns).filter((k) => !crewKit.some((c) => c.name === k.name))];
      let workInfo = null;
      if (work && store.isScratch(s.cwd)) {
        if (fs.existsSync(s.cwd)) {
          try {
            const packed = packDir(s.cwd, { maxBytes: FILES_MAX });
            if (packed.files) {
              unpackTo(packed.body, path.join(dir, 'files'));
              workInfo = { kind: 'files', files: packed.files };
            }
          } catch (err) {
            if (!err.tooBig) throw err;
            notes.push('Its files are over 50 MB, so only the conversation went');
          }
        }
      } else if (work) {
        const root = await repoRoot(workdir(s));
        const file = path.join(dir, 'work.bundle');
        const pack = root && (await packWork(workdir(s), s.worktree, file).catch((err) => notes.push(`Its work couldn’t be packed (${err.message}), so only the conversation went`)));
        if (pack && typeof pack === 'object') {
          const remote = cleanRemote(await git(root, ['remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => ''));
          const sub = path.relative(root, s.cwd);
          workInfo = { kind: 'git', repo: remote, name: path.basename(root), sub: sub && !sub.startsWith('..') ? sub.split(path.sep).join('/') : '', branch: pack.branch, changed: new Set(turns.flatMap((x) => x.changes.map((c) => c.file))).size, pack };
        }
        if ((s.also || []).length) notes.push('Its other folders stay here: only the main one’s work went');
      }
      const task = {
        wispTask: TASK_FILE,
        title: s.title,
        agent: s.agent,
        model: s.model || '',
        effort: s.effort || '',
        mode: s.mode,
        subagents: (s.subagents || []).map(({ upstream, machine, place, ...m }) => (m.crew ? { crew: crewKey(m.crew), name: m.name, label: m.label || m.name, role: m.role || '', use: m.use || '' } : m)).filter((m) => m.crew !== ''),
        turns,
        runs,
        ...(crewOut && { crew: crewOut.bundle }),
        connectors: (store.config.connectors || []).filter((c) => c.enabled !== false).map(shareConnector),
        kit,
        work: workInfo,
        sharedAt: Date.now(),
      };
      const { value, hits } = redactDeep(task);
      if (hits) notes.push(`${hits} secret${hits === 1 ? '' : 's'} in the conversation ${hits === 1 ? 'was' : 'were'} replaced with [redacted]`);
      fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(value));
      let packed;
      try {
        packed = packDir(dir, { maxBytes: MAX });
      } catch (err) {
        if (err.tooBig) throw bad('That task is too big to share (100 MB at most). Share it without its work.', 413);
        throw err;
      }
      const out = await ask(t, 'PUT', `/api/shares/mine/${encodeURIComponent(s.id)}`, { raw: packed.body, headers: { 'x-wisp-passkey': encodeURIComponent(passkey) } });
      s.shared = { id: out.id, url: out.url, account: t.id, host: t.host, locked: !!out.locked, work: !!workInfo, at: Date.now() };
      store.save(s);
      app.sessionChanged(s);
      app.telemetry?.track('task_share', { locked: !!passkey, work: workInfo?.kind || 'none', turns: turns.length, again: !!out.createdAt && out.createdAt !== out.updatedAt });
      return { ...s.shared, notes };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function unshare(s) {
    if (!s.shared) throw bad('That task isn’t shared.', 404);
    const t = targets().find((x) => x.id === s.shared.account) || targets().find((x) => x.host === s.shared.host);
    if (!t) throw bad(`You’re signed out of ${s.shared.host}, so the link still works: sign in again (Settings → Cloud) to stop sharing it.`, 409);
    await ask(t, 'DELETE', `/api/shares/mine/${encodeURIComponent(s.id)}`);
    delete s.shared;
    store.save(s);
    app.sessionChanged(s);
    return { ok: true };
  }

  // The card for a pasted link: who shared it and what it carries, and what importing would do here.
  async function peek(link, { passkey = '' } = {}) {
    const { t, id } = gridOf(link);
    let card;
    try {
      card = await ask(t, 'GET', `/api/shares/${id}`, { headers: passkey ? { 'x-wisp-passkey': encodeURIComponent(passkey) } : {} });
    } catch (err) {
      if (err.locked) return { id, url: link, host: t.host, locked: true, open: false, from: err.from || null, wrong: !!passkey };
      throw err;
    }
    const here = (await listAgents()).filter((x) => x.available && x.id !== 'wisp' && adapters[x.id]);
    const mine = new Set((store.config.connectors || []).map((c) => c.name));
    const crewHere = new Set((app.crew?.list || []).map((m) => handleOf(m.name)));
    // What it would run on here: the same, or what stands in for it and why (the card says so,
    // and its runner button picks another).
    const run = here.length ? runHere(here, { agent: card.agent, model: card.model, effort: card.effort }) : null;
    return {
      ...card,
      host: t.host,
      open: true,
      run,
      newConnectors: (card.connectors || []).filter((n) => !mine.has(n)),
      newCrew: (card.crew || []).filter((n) => !crewHere.has(handleOf(n))),
      imported: store.all().find((s) => s.sharedFrom?.id === id && !s.archived)?.id || null,
    };
  }

  // Add their connectors you don't have (by name). A remote one is on; one that runs a command on
  // this computer, or needs keys, starts switched off: Settings → Connectors says what it runs.
  function addConnectors(list) {
    const have = (store.config.connectors ||= []);
    const added = [];
    for (const c of Array.isArray(list) ? list.slice(0, 40) : []) {
      if (!c || have.some((x) => x.name === c.name)) continue;
      try {
        const { connector } = normalizeConnector({ name: c.name, transport: c.transport, ...(c.transport === 'local' ? { command: c.command, args: Array.isArray(c.args) ? c.args : [] } : { url: c.url }), env: (c.env || []).map((key) => ({ key })), headers: (c.headers || []).map((key) => ({ key })) }, have);
        connector.enabled = connector.transport === 'remote' && !connector.env.length && !connector.headers.length;
        have.push(connector);
        added.push(connector);
      } catch (err) {
        console.warn(`wisp: shared connector ${c.name}: ${err.message}`);
      }
    }
    if (added.length) {
      app.configChanged();
      app.broadcast?.('connectors', {});
    }
    return added;
  }

  // Their crew members (a crew file, crew-share.js) → key → the member here. One of yours with the
  // same name and brief is them already; the rest join paused, and the ones with nothing of their
  // own to start them (no schedule, no triggers) are resumed at once so the lead can delegate.
  function importCrew(file, here, notes) {
    const out = new Map();
    if (!file || !app.crew || !app.triggers) return out;
    let members;
    try {
      ({ members } = parseCrewFile(file));
    } catch (err) {
      notes.push(`Their crew members couldn’t come: ${err.message}`);
      return out;
    }
    const fresh = [];
    for (const bp of members) {
      const have = app.crew.list.find((m) => handleOf(m.name) === handleOf(bp.name) && (m.brief || '') === bp.brief);
      if (have) out.set(bp.key, have);
      else fresh.push(bp);
    }
    if (!fresh.length) return out;
    try {
      const plan = planImport(fresh, { crew: app.crew, agents: here });
      for (const p of plan) for (const n of p.notes) notes.push(`${p.name}: ${n}`);
      const made = applyImport(plan.map((p) => ({ ...p, needsProject: false })), { crew: app.crew, triggers: app.triggers });
      made.forEach((m, i) => {
        out.set(plan[i].key, m);
        if (!plan[i].cron && !plan[i].on.length) app.crew.update(m, { paused: false });
      });
      app.crew.changed?.();
      const paused = made.filter((m) => m.paused).map((m) => m.name);
      notes.push(`${made.map((m) => m.name).join(', ')} joined your crew${paused.length ? ` (${paused.join(', ')} paused: ${paused.length === 1 ? 'it has' : 'they have'} a schedule or triggers; resume on the Crew page)` : ''}`);
    } catch (err) {
      notes.push(`Their crew members couldn’t join yours: ${err.message}`);
    }
    return out;
  }

  // Import the shared task at link. prompt: its first follow-up here ('' waits for you).
  // connectors: false leaves theirs out. Resolves { session, notes }.
  // run: { agent, model, effort } picked on the card for the lead. crew: false leaves their crew
  // members out (their runs still come, as history).
  async function importShare(link, { passkey = '', prompt = '', mode, connectors = true, crew = true, run = null } = {}) {
    const { t, id } = gridOf(link);
    const card = await ask(t, 'GET', `/api/shares/${id}`, { headers: passkey ? { 'x-wisp-passkey': encodeURIComponent(passkey) } : {} }).catch((err) => {
      throw err.locked ? bad(passkey ? 'That passkey isn’t right.' : 'This task is locked: type its passkey.', 403) : err;
    });
    const buf = await fetchPack(t, id, passkey);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-import-'));
    const notes = [];
    try {
      unpackTo(buf, dir);
      const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
      if (task?.wispTask !== TASK_FILE || !Array.isArray(task.turns)) throw bad(task?.wispTask > TASK_FILE ? 'That task was shared from a newer wisp: update wisp to import it.' : 'That isn’t a task wisp can import.');
      const here = (await listAgents()).filter((x) => x.available && x.id !== 'wisp' && adapters[x.id]);
      if (!here.length) throw bad('No coding agent is installed here to carry it on.', 409);
      // The lead: what you picked on the card, else the harness and model it ran on when they're here.
      const lead = runHere(here, run?.agent && here.some((x) => x.id === run.agent) ? { agent: run.agent, model: run.model || '', effort: run.effort || '' } : { agent: task.agent, model: task.model, effort: task.effort });
      if (lead.note && !run?.agent) notes.push(lead.note);
      const sid = newId();
      const title = String(task.title || card.title || 'Shared task').slice(0, 200);
      // Where its work goes.
      let cwd;
      let worktree = null;
      const w = task.work;
      if (w?.kind === 'git' && w.pack && fs.existsSync(path.join(dir, 'work.bundle'))) {
        let repoDir;
        if (w.repo) repoDir = (await checkout(store, w.repo).catch((err) => notes.push(`Couldn’t get ${w.repo} (${err.message}): its work is in a folder of its own`)))?.dir;
        if (!repoDir) {
          // No repo to clone (or it failed): a repo of its own, from the bundle alone.
          repoDir = path.join(store.home, 'shared', `${(w.name || 'task').replace(/[^\w.-]+/g, '-').slice(0, 40)}-${sid}`);
          fs.mkdirSync(repoDir, { recursive: true });
          await git(repoDir, ['init', '--quiet']);
        }
        worktree = await unpackWork({ cwd: repoDir, home: store.home, id: sid, title, pack: { ...w.pack, prereq: !!w.pack.prereq && !!w.repo }, file: path.join(dir, 'work.bundle') }).catch((err) => {
          notes.push(`Its work couldn’t be unpacked (${err.message}): you have the conversation`);
          return null;
        });
        cwd = worktree ? (w.sub ? path.join(worktree.path, ...w.sub.split('/')) : worktree.cwd) : repoDir;
        if (worktree && !fs.existsSync(cwd)) cwd = worktree.cwd;
        if (worktree) worktree.cwd = cwd;
      } else {
        cwd = store.scratchDir(sid);
        if (w?.kind === 'files' && fs.existsSync(path.join(dir, 'files'))) fs.cpSync(path.join(dir, 'files'), cwd, { recursive: true });
      }
      const added = connectors ? addConnectors(task.connectors) : [];
      const off = added.filter((c) => !c.enabled);
      if (off.length) notes.push(`${off.map((c) => c.name).join(', ')} ${off.length === 1 ? 'was' : 'were'} added switched off: check ${off.length === 1 ? 'it' : 'them'} in Settings → Connectors, add any keys, then turn ${off.length === 1 ? 'it' : 'them'} on`);
      const kit = (Array.isArray(task.kit) ? task.kit : []).filter((k) => k && (k.kind === 'skill' || k.kind === 'rules') && typeof k.body === 'string').slice(0, 24).map((k) => ({ kind: k.kind, name: String(k.name).slice(0, 64), ...(k.description && { description: String(k.description).slice(0, 1024) }), body: k.body.slice(0, 50_000) }));
      const from = card.from || {};
      // Their crew members it delegated to: yours now (paused when they have a schedule or
      // triggers of their own), or one of yours already, the same name and brief.
      const memberOf = crew ? importCrew(task.crew, here, notes) : new Map();
      // Its team: the same subagents (on what's here) and the crew members that came along.
      const team = normalizeTeam(
        (Array.isArray(task.subagents) ? task.subagents : []).flatMap((m) => {
          if (!m || typeof m !== 'object') return [];
          if (m.crew !== undefined) {
            const mm = memberOf.get(m.crew);
            return mm ? [{ crew: mm.id, name: mm.name, label: m.label || mm.name, role: mm.role, agent: mm.agent, use: m.use || '' }] : [];
          }
          const r = runHere(here, m, lead);
          if (r.note) notes.push(`@${m.name}: ${r.note}`);
          return [{ ...m, agent: r.agent, model: r.model, effort: r.effort }];
        }),
        adapters,
      );
      // Its delegated runs, as subagent sessions of the new lead: their own history, so the lead's
      // report links open them, and a subagent the lead delegates to again carries on from there.
      const mode0 = MODES.has(mode) ? mode : MODES.has(task.mode) ? task.mode : 'auto';
      const shared = (x) => ({ ...x, id: newId(), activity: [], shared: true, checkpoint: null, attachments: [] });
      const children = {};
      const runIds = new Map(); // run key → { id, turns: [new turn ids] }
      for (const [key, r] of Object.entries(task.runs && typeof task.runs === 'object' ? task.runs : {}).slice(0, 40)) {
        if (!/^~?[\w.#-]{1,44}$/.test(key) || !Array.isArray(r?.turns) || !r.turns.length) continue;
        const on = r.crew && memberOf.get(r.crew) ? { agent: memberOf.get(r.crew).agent, model: memberOf.get(r.crew).model || '', effort: memberOf.get(r.crew).effort || '' } : runHere(here, r, lead);
        const agentId = adapters[on.agent] && on.agent !== 'auto' ? on.agent : lead.agent;
        const hist = r.turns.filter((x) => x && typeof x.prompt === 'string').map(shared);
        const child = runner.create({ prompt: '', cwd, agent: agentId, model: on.model || '', effort: on.effort || '', mode: mode0, parentId: sid, member: String(r.name || key).slice(0, 40), history: hist, title: String(r.title || r.name || key).slice(0, 200), idle: true });
        children[key] = child.id;
        runIds.set(key, { id: child.id, turns: hist.map((x) => x.id) });
      }
      const relink = (x) => ({
        ...x,
        ...(Array.isArray(x.delegations) && {
          delegations: x.delegations.map((d) => {
            const r = runIds.get(d.run);
            const { run: _, turn, ...rest } = d;
            const mm = d.crew ? memberOf.get(runOfMember(task, d.run)) : null;
            delete rest.crew;
            return { ...rest, id: newId(), ...(mm && { crew: mm.id }), sessionId: r?.id || '', turnId: r?.turns[turn || 0] || '' };
          }),
        }),
      });
      const history = task.turns.filter((x) => x && typeof x === 'object' && typeof x.prompt === 'string').map((x) => relink(shared(x)));
      const text = String(prompt || '').trim();
      const session = runner.create({
        id: sid,
        prompt: text,
        cwd,
        agent: lead.agent,
        model: lead.model,
        effort: lead.effort,
        mode: mode0,
        worktree,
        subagents: team,
        history,
        title,
        sharedFrom: { id, url: card.url || link, host: t.host, handle: from.handle || '', name: from.name || from.handle || '', title, ...(kit.length && { kit }), at: Date.now() },
        idle: !text,
      });
      if (Object.keys(children).length) {
        session.children = { ...(session.children || {}), ...children };
        store.save(session);
      }
      app.sessionChanged?.(session);
      app.telemetry?.track('task_import', { work: w?.kind || 'none', turns: history.length, switched: lead.agent !== task.agent, model: lead.model === (task.model || ''), connectors: added.length, skills: kit.length, runs: runIds.size, crew: memberOf.size, prompt: !!text });
      return { session, notes, connectors: added.map((c) => ({ name: c.name, enabled: c.enabled })), crew: [...new Set([...memberOf.values()])].map((m) => ({ id: m.id, name: m.name, paused: !!m.paused })) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { targets: () => targets().map(({ id, host, handle }) => ({ id, host, handle })), preview, share, unshare, peek, importShare };
}
