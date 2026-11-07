// A harness that turned a task down (v1 server/refusal.js), not one that failed or got it wrong. The
// task then offers to hand the same prompt, with what it has seen, to another of your harnesses
// (turn.refusal). Never by itself. Conservative on purpose: a false card is noise on a finished task.
// Only the API's own word (stop_reason "refusal"), the CLI's usage-policy error, or a short answer
// that opens by declining, from a run that changed no file.

const POLICY = /appears to violate (?:our|the) usage polic|violat\w* (?:our|anthropic'?s?|openai'?s?) usage polic|flagged as (?:potentially )?violating (?:our )?usage polic|invalid_prompt\b.*usage polic|stop_reason["']?\s*[:=]\s*["']?refusal/i;

// "I can't help with that", "I'm sorry, but I won't write…": a verb of helping, not "I can't find the file".
const CANT = String.raw`(?:can(?:'|’)?t|cannot|won(?:'|’)t|will not|am not able to|(?:'|’)m not able to|am unable to|(?:'|’)m unable to|must decline to|have to decline to)`;
const HELP = String.raw`(?:help|assist|provide|create|write|build|make|do|comply|support|continue|reverse[- ]engineer|work on|produce|generate|implement)`;
const DECLINE = new RegExp(String.raw`^(?:(?:I(?:'|’)m|I am)\s+(?:sorry|afraid)|sorry|I apologi[sz]e|unfortunately)?[,.!]?\s*(?:but\s+)?I\s+${CANT}\s+${HELP}\b`, 'i');
const DECLINE_SHORT = 600; // a real answer that mentions what it can't do is longer than this

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

export interface Refusal {
  kind: 'policy' | 'declined';
  line: string;
}

export function refusalOf({ text = '', stopReason = '', isError = false, changes = 0 }: { text?: unknown; stopReason?: unknown; isError?: boolean; changes?: number } = {}): Refusal | null {
  const t = String(text ?? '').trim();
  const line = clip(t.split('\n').find((l) => l.trim()) ?? '');
  if (stopReason === 'refusal') return { kind: 'policy', line };
  if (POLICY.test(t)) return { kind: 'policy', line };
  if (isError || changes > 0 || !t || t.length > DECLINE_SHORT) return null;
  // Markdown a model may open with (a heading, bold) doesn't hide the sentence.
  const plain = t.replace(/^[#>*_\s`-]+/, '').replace(/\*\*/g, '');
  return DECLINE.test(plain) ? { kind: 'declined', line } : null;
}
