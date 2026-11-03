// Whose model a harness runs: Anthropic, OpenAI, Google, xAI… DOM-free, shared by the server
// (runner.js #refused) and the page (turns.js refusalCard).
//
// A refusal is the model's answer, not the harness's: Copilot CLI, opencode, Cursor and
// Antigravity can all run Claude or GPT models. So handing a Claude refusal to Copilot on its
// default (often Claude) would ask Anthropic's model again. handoffTargets only offers a harness
// whose model is known to come from another vendor, and pins that model on the hand-off.

// Model id → vendor. Ids come as "claude-sonnet-4.5", "anthropic/claude-…", "openrouter/openai/gpt-5",
// "github-copilot/gpt-5", "gemini-3-pro", "o4-mini", "opus", "grok-4"…
const VENDORS = [
  ['anthropic', /claude|anthropic|(?:^|[/:\s_-])(?:opus|sonnet|haiku)(?:$|[/:\s._-]|\d)/i],
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

// What a harness runs when it isn't given a model: only the single-vendor ones are sure.
// Copilot, opencode, Cursor and Antigravity default to whatever they're set to: unknown.
const HOME = { claude: 'anthropic', codex: 'openai', grok: 'xai' };

export function vendorOf(model, agent) {
  const m = String(model || '').trim();
  if (m && !/^(?:auto|default)$/i.test(m)) {
    for (const [v, re] of VENDORS) if (re.test(m)) return v;
    return HOME[agent] || '';
  }
  return HOME[agent] || '';
}

// The harnesses a refused turn may go to, each with the model to pin: { agent, model, vendor }.
//   from / fromModel: the harness and model that refused.
//   agents: [{ id, available, models: [{ id }] }] (GET /agents).
//   models: config.defaults.models (the model each harness is set to in wisp).
// A harness qualifies with its configured model when that model's vendor is known and different,
// or else with the first model it lists from another vendor. Unknown vendors never qualify: they
// might be the same one. When the refusing vendor isn't known either, a target still needs a known
// vendor, so the card at least names what it hands to.
export function handoffTargets({ from, fromModel = '', agents = [], models = {}, max = 3 }) {
  const refused = vendorOf(fromModel, from);
  const ok = (v) => !!v && v !== refused;
  const out = [];
  for (const a of agents) {
    if (!a || a.id === from || a.id === 'wisp' || a.id === 'auto' || !a.available) continue;
    const set = String(models?.[a.id] || '');
    const own = vendorOf(set, a.id);
    if (ok(own)) {
      out.push({ agent: a.id, model: set, vendor: own });
    } else {
      // Its configured model is the same vendor, or unknown: pin one it lists from another vendor.
      const pick = (a.models || []).find((m) => m?.id && ok(vendorOf(m.id, a.id)));
      if (pick) out.push({ agent: a.id, model: pick.id, vendor: vendorOf(pick.id, a.id) });
    }
    if (out.length >= max) break;
  }
  return out;
}
