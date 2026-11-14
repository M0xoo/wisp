import type { Finding, Severity } from './types.ts';

export function finding(file: string, line: number, rule: string, message: string, severity: Severity = 'error'): Finding {
  return { file, line, rule, message, severity };
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

/** `file:line rule message`; warnings say `warn:<rule>` so a grep for errors stays simple. */
export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line} ${f.severity === 'warn' ? `warn:${f.rule}` : f.rule} ${f.message}`;
}
