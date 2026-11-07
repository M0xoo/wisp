// Secrets in text: the patterns of v1's web/js/secret-scan.js, which normalizeConnector checks a
// command or URL against (a token pasted there would sit in the store, not in the secrets file). A
// private copy until a shared text package holds the one list (see the report: channels and git have
// one too).

const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a Discord bot token', /\b[MNO][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27,}/],
  ['a Stripe key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{4,}@/i],
  ['a secret value', /\b[\w-]*(api[_-]?key|secret|token|passw(or)?d|private[_-]?key)\b["']?\s*[:=]\s*["']?(?!<|\$\{|\$[A-Z_]|xxx|\*\*\*|your[_-]|example|placeholder|changeme)[A-Za-z0-9/+_.=-]{16,}/i],
];

/** text → one hit per line at most (the first kind that matches it): what it looks like, never the secret. */
export function scanSecrets(text: string): { line: number; what: string }[] {
  const out: { line: number; what: string }[] = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    const hit = PATTERNS.find(([, re]) => re.test(l));
    if (hit) out.push({ line: i + 1, what: hit[0] });
  });
  return out;
}
