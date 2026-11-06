// Is there a secret in an app about to go on a public link (services/publish.js)? scanAll finds
// what looks like one, but in a working web app plenty of that is meant to be there: a Firebase
// config, a Mapbox token, a library that parses PEM, a README's placeholder. Publish stops the
// app with no way round, so here a match counts only if it would really hurt to publish it.

import { scanAll } from './secret-scan.js';

const PLACEHOLDER = /x{6}|\*{3}|example|placeholder|changeme|your[-_]|dummy|sample|fake|redacted|1234567|abcdefg/i;
// Made to sit in a web page: Stripe publishable keys, Mapbox public tokens, PostHog, Supabase.
const PUBLIC_KEY = /^(pk_(live|test)_|pk\.|phc_|sb_publishable_)/;
const PUBLIC_NAME = /public|publishable|anon|csrf|xsrf/i;
// The Google and JWT rules run first and have said their piece on a value shaped like theirs.
const JUDGED = /^(AIza|eyJ)/;
// Google's browser keys are restricted by site, and Firebase and Maps put them in the page.
const GOOGLE_PAGE_KEY = /firebase|authdomain|maps\.googleapis|maps\/api|google\.maps/i;
const DATA_FILE = /\.(json|ya?ml|toml|ini|cfg|conf|properties|txt|md|csv|xml)$/i;
const DATABASE = /\.(sqlite3?|db)$/i;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|example\.|host\b|db\b)/i;
const WORD_PASSWORD = /^(pass|password|passwd|secret|admin|root|test|user)$/i;

const looksRandom = (v) => /\d/.test(v) && /[a-z]/i.test(v) && new Set(v).size >= 8;

function jwtIsPublic(value) {
  try {
    const { role, sub } = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    return role === 'anon' || sub === '1234567890'; // Supabase's anon key; jwt.io's sample
  } catch {
    return false;
  }
}

// A private key's marker alone is a library's constant: a real one has its body after it.
function hasKeyBody({ lines, i, end }) {
  return /^(\\r)?\\n[A-Za-z0-9+/]{40}/.test(lines[i].slice(end)) || /^\s*["'`]?[A-Za-z0-9+/=]{40,}/.test(lines[i + 1] || '');
}

function urlPasswordIsReal(value, { lines, i, end }) {
  const password = value.slice(value.lastIndexOf(':') + 1, -1);
  return !/[<{$%]/.test(password) && !WORD_PASSWORD.test(password) && !LOCAL_HOST.test(lines[i].slice(end));
}

function secretValueIsReal(found, { where }) {
  const at = found.search(/[:=]/);
  const name = found.slice(0, at);
  const after = found.slice(at + 1).trimStart();
  const value = after.replace(/^["']/, '');
  if (PUBLIC_NAME.test(name) || PUBLIC_KEY.test(value) || JUDGED.test(value)) return false;
  // In code an unquoted value is another name (token = res.data.accessToken), not a secret.
  if (after === value && !DATA_FILE.test(where)) return false;
  return looksRandom(value);
}

export function realSecret(what, value, at) {
  if (PLACEHOLDER.test(value)) return false;
  if (what === 'a private key') return hasKeyBody(at);
  if (what === 'a Google API key') return !GOOGLE_PAGE_KEY.test(at.lines.slice(Math.max(0, at.i - 3), at.i + 4).join('\n'));
  if (what === 'a JSON Web Token') return !jwtIsPublic(value);
  if (what === 'a password in a URL') return urlPasswordIsReal(value, at);
  if (what === 'an OpenAI API key') return looksRandom(value);
  if (what === 'a secret value') return secretValueIsReal(value, at);
  return true;
}

// [{ path, data }] → [{ where, line, what }]. Binary files have no text to hide in, but for a
// database, which a seed can be and which a visitor can download.
export function scanApp(files) {
  const texts = {};
  for (const { path, data } of files) {
    const db = DATABASE.test(path);
    if (db || !data.subarray(0, 8000).includes(0)) texts[path] = data.toString(db ? 'latin1' : 'utf8');
  }
  return scanAll(texts, realSecret);
}

// The refusal: where and what kind, never the value, so it's safe in a toast, a log or a transcript.
export function secretsFound(found) {
  const named = found.slice(0, 3).map((h) => `${h.where} line ${h.line} looks like ${h.what}`);
  const more = found.length - named.length;
  return `${named.join(', ')}${more ? ` and ${more} more` : ''}, and this link is public. Take ${found.length === 1 ? 'it' : 'them'} out of the app, then publish again.`;
}
