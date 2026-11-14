// Whose model a harness runs (v1 web/js/vendors.js), DOM-free: Anthropic, OpenAI, Google, xAI… A refusal is the
// model's answer, not the harness's: Copilot, opencode, Cursor and Antigravity can all run Claude or GPT models, so
// handing a Claude refusal to Copilot on its default could ask Anthropic's model again. `handoffTargets` only offers
// a harness whose model is known to come from another vendor, and pins that model on the hand-off.

const VENDORS: readonly (readonly [string, RegExp])[] = [
  ['anthropic', /claude|anthropic|(?:^|[/:\s_-])(?:opus|sonnet|haiku|fable)(?:$|[/:\s._-]|\d)/i],
  ['openai', /openai|chatgpt|gpt|codex|(?:^|[/:\s_-])o\d(?:$|[/:\s._-])/i],
  ['google', /gemini|gemma|google|vertex/i],
  ['xai', /grok|xai|x-ai/i],
  ['deepseek', /deepseek/i],
  ['alibaba', /qwen/i],
  ['moonshot', /kimi|moonshot/i],
  ['zhipu', /glm|zhipu|z-ai/i],
  ['mistral', /mistral|codestral|devstral/i],
  ['meta', /llama/i],
  ['cursor', /(?:^|[/:\s_-])composer/i],
];

/** What a harness runs when it isn't given a model: only the single-vendor ones are sure. */
const HOME: Readonly<Record<string, string>> = { claude: 'anthropic', codex: 'openai', grok: 'xai' };

export function vendorOf(model: string | undefined, agent: string): string {
  const m = String(model ?? '').trim();
  if (m && !/^(?:auto|default)$/i.test(m)) {
    for (const [v, re] of VENDORS) if (re.test(m)) return v;
  }
  return HOME[agent] ?? '';
}

export interface AgentLike {
  readonly id: string;
  readonly name?: string;
  readonly available?: boolean;
  readonly models?: readonly { readonly id: string }[];
}
export interface Target {
  readonly agent: string;
  readonly model: string;
  readonly vendor: string;
}

/** The harnesses a refused turn may go to, each with the model to pin (v1 handoffTargets). A harness qualifies
 * with its configured model when that model's vendor is known and different, else with the first model it lists
 * from another vendor. Unknown vendors never qualify: they might be the same one. */
export function handoffTargets(o: { from: string; fromModel?: string; vendor?: string; agents: readonly AgentLike[]; models?: Readonly<Record<string, string>>; max?: number }): Target[] {
  // the runtime's word on whose model refused, else read from the model; unknown: every other harness (backend round 6)
  const refused = o.vendor ?? vendorOf(o.fromModel, o.from);
  const ok = (v: string): boolean => !!v && v !== refused;
  const out: Target[] = [];
  if (!refused) {
    for (const a of o.agents) {
      if (a.id === o.from || a.id === 'wisp' || a.id === 'auto' || !a.available) continue;
      out.push({ agent: a.id, model: String(o.models?.[a.id] ?? ''), vendor: vendorOf(o.models?.[a.id], a.id) });
      if (out.length >= (o.max ?? 3)) break;
    }
    return out;
  }
  for (const a of o.agents) {
    if (a.id === o.from || a.id === 'wisp' || a.id === 'auto' || !a.available) continue;
    const set = String(o.models?.[a.id] ?? '');
    const own = vendorOf(set, a.id);
    if (ok(own)) out.push({ agent: a.id, model: set, vendor: own });
    else {
      const pick = (a.models ?? []).find((m) => m.id && ok(vendorOf(m.id, a.id)));
      if (pick) out.push({ agent: a.id, model: pick.id, vendor: vendorOf(pick.id, a.id) });
    }
    if (out.length >= (o.max ?? 3)) break;
  }
  return out;
}

/** The usage-limit card's one other harness (v1 limitCard): the first available that isn't this one. */
export function limitTarget(from: string, agents: readonly AgentLike[]): Target | undefined {
  const a = agents.find((x) => x.id !== from && x.id !== 'wisp' && x.id !== 'auto' && x.available);
  return a ? { agent: a.id, model: '', vendor: vendorOf('', a.id) } : undefined;
}
