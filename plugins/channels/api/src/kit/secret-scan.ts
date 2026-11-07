// Secrets in text about to leave this computer: API keys, tokens, private keys. Each hit says the
// line and what it looks like, never the secret itself. The port of v1's web/js/secret-scan.js,
// pattern for pattern: the page, the server and the channels all scrub with the same list.

const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  // Its first part is a user id in base64, so M, N or O and no - or _: that's what tells it from a dotted name.
  ['a Discord bot token', /\b[MNO][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27,}/],
  ['a Stripe key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{4,}@/i],
  // key = "value": a name that says secret, then something long enough to be one (not a placeholder).
  ['a secret value', /\b[\w-]*(api[_-]?key|secret|token|passw(or)?d|private[_-]?key)\b["']?\s*[:=]\s*["']?(?!<|\$\{|\$[A-Z_]|xxx|\*\*\*|your[_-]|example|placeholder|changeme)[A-Za-z0-9/+_.=-]{16,}/i],
];

const EVERY: readonly (readonly [string, RegExp])[] = PATTERNS.map(([what, re]) => [what, new RegExp(re.source, `${re.flags}g`)] as const);

export interface SecretHit {
  line: number;
  what: string;
}

export type RealCheck = (what: string, value: string, at: { lines: string[]; i: number; end: number; where: string | undefined }) => boolean;

/** text → one hit per line at most (the first kind that matches). `real` is asked about each match. */
export function scanSecrets(text: unknown, real?: RealCheck, where?: string): SecretHit[] {
  const out: SecretHit[] = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((l, i) => {
    const hit = real
      ? EVERY.find(([what, re]) => [...l.matchAll(re)].some((m) => real(what, m[0], { lines, i, end: (m.index ?? 0) + m[0].length, where })))
      : PATTERNS.find(([, re]) => re.test(l));
    if (hit) out.push({ line: i + 1, what: hit[0] });
  });
  return out;
}

/** Several named texts ({ where: text }) → [{ where, line, what }]. */
export function scanAll(texts: Readonly<Record<string, string>>, real?: RealCheck): (SecretHit & { where: string })[] {
  return Object.entries(texts).flatMap(([where, text]) => scanSecrets(text, real, where).map((h) => ({ where, ...h })));
}

/** The same text with every secret replaced by [redacted: what it was]. */
export function redactSecrets(text: unknown): { text: string; hits: number } {
  let hits = 0;
  let out = String(text ?? '');
  for (const [what, re] of PATTERNS) {
    out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), () => {
      hits++;
      return `[redacted: ${what}]`;
    });
  }
  return { text: out, hits };
}
