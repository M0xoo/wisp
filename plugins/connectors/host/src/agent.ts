// The agent's tools (wisp.mcp's wisp_connectors, wisp_connector_add, wisp_connector_signin), as v1's
// /internal/connectors routes answered them. Only the user's own tasks change connectors: not a
// subagent, nor a crew member's job. Secret values never pass through the agent: it names the keys,
// the user fills them in on a card. A capped task never gets here: agent:capped denies connectors:*.

import type { Connector, SigninAsk } from '@wisp-plugin/connectors-api';
import { connectorView, normalizeConnector, type Body } from './model.ts';
import type { Connectors } from './service.ts';

const READY = 'Tasks get it from their next turn: harnesses load MCP servers when a turn starts, so this turn can’t call it yet.';

/** What the tools need to know of the task asking (from runtime.get). */
export interface Asker {
  agent: string;
  /** a subagent or a crew member's job */
  delegated: boolean;
}

export class AgentTools {
  readonly #c: Connectors;

  constructor(c: Connectors) {
    this.#c = c;
  }

  #named(name: unknown): Connector {
    const want = String(name || '').trim().toLowerCase();
    const x = this.#c.list().find((y) => y.name === want || y.id === want);
    if (!x) throw new Error(`No connector called “${String(name)}”. List them with wisp_connectors.`);
    return x;
  }

  state(x: Connector): string {
    const v = connectorView(x, (k) => this.#c.has(x.id, k));
    const missing = this.#c.missing(x);
    if (x.enabled === false) return 'off';
    if (missing.length) return `needs ${missing.map((k) => k.split(':')[1]).join(', ')} from the user (wisp_connector_signin)`;
    const t = x.test;
    if (t?.ok) {
      const n = t.count ?? 0;
      return `works: ${n} tool${n === 1 ? '' : 's'}${t.tools?.length ? ` (${t.tools.slice(0, 8).join(', ')}${n > 8 ? ', …' : ''})` : ''}`;
    }
    if (t?.auth) return 'needs the user to sign in (wisp_connector_signin)';
    if (t) return `fails: ${t.error ?? ''}`;
    return v.signedIn ? 'signed in, not checked yet' : 'not checked yet';
  }

  line(x: Connector): string {
    return `- **${x.name}** · ${x.transport === 'local' ? `local: \`${[x.command, ...(x.args || [])].join(' ')}\`` : `remote: ${x.url ?? ''}`}${x.oauth ? ' · signed in' : ''} · ${this.state(x)}`;
  }

  list(): { text: string } {
    const all = this.#c.list();
    return { text: all.length ? `The user's connectors (MCP servers every task gets; not in Plan mode, not Cursor or Antigravity):\n\n${all.map((x) => this.line(x)).join('\n')}` : 'The user has no connectors yet. Add one with wisp_connector_add.' };
  }

  static #onlyTheUser(s: Asker): void {
    if (s.delegated) throw new Error('Only a task the user started can change their connectors; a subagent or a crew member’s job can’t. Tell the user what to add instead.');
  }

  /** → the text, and the connector when one was added (the caller tests it when it has no keys to wait for) */
  add(s: Asker, body: Body): { connector: Connector } {
    AgentTools.#onlyTheUser(s);
    // Names only: a value here would sit in this task's transcript.
    for (const field of ['env', 'headers'] as const) {
      const v = body[field];
      if (v && !Array.isArray(v)) throw new Error(`${field}: give the names only, like ["API_KEY"]. The user types the values on the card wisp_connector_signin shows, so they never pass through you.`);
    }
    const names = (v: unknown): { key: unknown }[] => (Array.isArray(v) ? v.map((key: unknown) => ({ key })) : []);
    const { connector } = normalizeConnector({ ...body, env: names(body['env']), headers: names(body['headers']) }, this.#c.list());
    this.#c.save(connector);
    return { connector };
  }

  added(x: Connector): { text: string } {
    return { text: `Added ${x.name} to the user's connectors (Settings → Connectors).\n\n${this.line(x)}\n\n${/needs/.test(this.state(x)) ? 'Next: call wisp_connector_signin so the user can sign in or give the keys.' : READY}` };
  }

  /** A card in the task: Sign in (OAuth) or a box per key; wisp.mcp waits on it like ask_user. */
  signin(s: Asker, body: Body): { text: string } | { ask: SigninAsk } {
    AgentTools.#onlyTheUser(s);
    const x = this.#named(body['name']);
    const keys = this.#c.missing(x);
    if (!keys.length && x.test?.ok) return { text: `${x.name} already works: ${this.state(x)}. ${READY}` };
    if (!keys.length && x.transport === 'local') return { text: `${x.name} has no keys to ask for, and ${this.state(x)}. Check its command with the user.` };
    const kind = keys.length ? 'keys' : 'signin';
    const names = keys.map((k) => k.split(':')[1]);
    const all = [...(x.env || []).map((key) => ({ key, field: 'env' as const })), ...(x.headers || []).map((key) => ({ key, field: 'headers' as const }))];
    return {
      ask: {
        question: kind === 'signin' ? `Sign in to ${x.name}` : `${x.name} needs ${names.join(' and ')}`,
        context: String(body['why'] || '').slice(0, 400),
        options: ['Skip'],
        connector: { id: x.id, name: x.name, kind, keys: all.map((k) => ({ ...k, set: !keys.includes(`${k.field === 'env' ? 'env' : 'header'}:${k.key}`) })) },
      },
    };
  }
}
