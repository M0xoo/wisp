#!/usr/bin/env node
// Publishes the Android bundle to Google Play through its API (androidpublisher v3), for
// .github/workflows/android.yml. Node built-ins only: the service account key never leaves this
// process for a third-party action.
//   node scripts/play.mjs notes                                  # the "What's new" text
//   PLAY_SERVICE_ACCOUNT_JSON='{…}' node scripts/play.mjs upload <aab> <versionCode> <versionName> [promoteTrack]
// upload puts the bundle on internal testing; with promoteTrack (a version bump) it also puts the
// same build on that track, in a second edit so a refused promotion (a personal account's
// production gate) still leaves the internal release out.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'dev.trywisp.mobile';
export const NOTES_MAX = 500; // Play's limit per language
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com';

// What's new: mobile/whatsnew.txt when it has text (written by hand for a release), else the
// headlines of the newest CHANGELOG.md entries about the phone app, whole lines up to 500 chars.
export function whatsNew(changelog, override = '') {
  const own = String(override || '').replace(/\r\n?/g, '\n').trim();
  if (own) return cut(own.split('\n'));
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const heads = [];
  let sections = 0;
  for (const l of lines) {
    if (l.startsWith('## [')) { if (++sections > 2) break; continue; } // Unreleased + the last release
    const m = /^- \*\*(.+?)\*\*/.exec(l);
    if (m && /\b(phone|android|mobile|the app)\b/i.test(l)) heads.push(`- ${m[1].replace(/\.$/, '')}`);
  }
  return cut(heads.length ? heads : ['Fixes and improvements.']);
}

function cut(lines) {
  let out = '';
  for (const l of lines) {
    const next = out ? `${out}\n${l}` : l;
    if (next.length > NOTES_MAX) break;
    out = next;
  }
  return out || lines[0].slice(0, NOTES_MAX - 1) + '…';
}

// A service account's OAuth token: a signed JWT traded at its token_uri.
export async function token(key, fetchImpl = fetch) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(body), key.private_key).toString('base64url');
  const res = await fetchImpl(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${body}.${sig}` }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Google sign-in failed (${res.status}): ${json.error_description || json.error || 'no token'}`);
  return json.access_token;
}

export function client(accessToken, { api = API, pkg = PACKAGE, fetchImpl = fetch } = {}) {
  const call = async (method, path, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...headers },
      body: body === undefined ? undefined : headers['content-type'] === 'application/json' ? JSON.stringify(body) : body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Play ${method} ${path.split('?')[0]} failed (${res.status}): ${json.error?.message || 'no details'}`);
    return json;
  };
  const app = `/androidpublisher/v3/applications/${pkg}`;
  return {
    // Every change is an edit: open, change, commit (or it's dropped).
    async edit(fn) {
      const { id } = await call('POST', `${app}/edits`, {});
      await fn({
        uploadBundle: (bytes) => call('POST', `/upload${app}/edits/${id}/bundles?uploadType=media`, bytes, { 'content-type': 'application/octet-stream' }),
        setTrack: (track, release) => call('PUT', `${app}/edits/${id}/tracks/${track}`, { track, releases: [release] }),
      });
      return call('POST', `${app}/edits/${id}:commit`);
    },
  };
}

export function release(versionCode, versionName, notes) {
  return {
    name: `${versionCode} (${versionName})`,
    versionCodes: [String(versionCode)],
    status: 'completed',
    releaseNotes: [{ language: 'en-US', text: notes }],
  };
}

export async function publish({ key, aab, versionCode, versionName, notes, promote, api, fetchImpl = fetch, log = console.log }) {
  const play = client(await token(key, fetchImpl), { api, fetchImpl });
  const rel = release(versionCode, versionName, notes);
  await play.edit(async (e) => {
    const up = await e.uploadBundle(fs.readFileSync(aab));
    if (String(up.versionCode) !== String(versionCode)) throw new Error(`Play read versionCode ${up.versionCode}, expected ${versionCode}`);
    await e.setTrack('internal', rel);
  });
  log(`Internal testing: ${rel.name}`);
  if (!promote) return;
  await play.edit((e) => e.setTrack(promote, rel));
  log(`${promote}: ${rel.name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, aab, versionCode, versionName, promote] = process.argv.slice(2);
  const read = (p) => { try { return fs.readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };
  const notes = whatsNew(read('../CHANGELOG.md'), read('../mobile/whatsnew.txt'));
  if (cmd === 'notes') {
    process.stdout.write(notes + '\n');
  } else if (cmd === 'upload' && aab && versionCode && versionName) {
    const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON;
    if (!raw) { console.error('PLAY_SERVICE_ACCOUNT_JSON is not set.'); process.exit(1); }
    publish({ key: JSON.parse(raw), aab, versionCode, versionName, notes, promote })
      .catch((err) => { console.error(err.message); process.exit(1); });
  } else {
    console.error('usage: play.mjs notes | upload <aab> <versionCode> <versionName> [promoteTrack]');
    process.exit(1);
  }
}
