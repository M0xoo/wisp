// v1 org.js: the whole crew as a chart of who hands work to whom. The head (the org glyph, Org and what it is, how
// many members and links, its actions, ×), a hint line, the tiers (who nobody delegates to on top, each one's
// delegates below), the members with no links under a dashed rule, arrows from a member to its delegates, and the
// column beside it. Selecting a member turns the rest into its picker: + makes one its delegate, ✓ takes it off.
// The caller owns the graph and the selection; this draws them and measures where the arrows go.
import { For, Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { Face } from './Face.tsx';

export interface OrgCard {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly avatar: string;
  readonly color?: string | undefined;
  /** one line under them: On call, Working, Asks you */
  readonly state: { readonly text: string; readonly tone?: 'live' | 'asks' | undefined };
}

export interface OrgEdge {
  readonly from: string;
  readonly to: string;
  /** an arrow of the selected member's */
  readonly on: boolean;
  /** a member on another machine: its jobs there can't reach the crew here */
  readonly off?: boolean;
  readonly tip: string;
}

export interface OrgViewProps {
  readonly title: string;
  readonly role: string;
  readonly count?: string | undefined;
  readonly actions: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly title?: string; readonly onClick: () => void }[];
  readonly close?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly hint?: { readonly text: string; readonly on: boolean } | undefined;
  readonly tiers: readonly (readonly OrgCard[])[];
  readonly alone: readonly OrgCard[];
  readonly aloneLabel: string;
  readonly edges: readonly OrgEdge[];
  readonly selected?: string | undefined;
  /** while one is selected: what each other card's button does (add it as a delegate, take it off) */
  readonly pick?: ((id: string) => 'add' | 'remove' | undefined) | undefined;
  readonly pickLabel: (id: string, how: 'add' | 'remove') => string;
  readonly onSelect: (id: string | undefined) => void;
  readonly onPick: (id: string) => void;
  /** the column beside the chart (under it on a narrow pane) */
  readonly side: JSX.Element;
}

interface Box {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** From the bottom of the one who delegates to the top of its delegate; a delegate on the same row or above goes
 *  round the side (v1 route, simplified). */
export function edgePath(a: Box, b: Box): string {
  if (b.top >= a.bottom - 1) {
    const dy = Math.max(24, (b.top - a.bottom) / 2);
    return `M${a.x} ${a.bottom}C${a.x} ${a.bottom + dy} ${b.x} ${b.top - dy} ${b.x} ${b.top}`;
  }
  const right = b.left >= a.right;
  const sx = right ? a.right : a.left;
  const ex = right ? b.left : b.right;
  const ay = (a.top + a.bottom) / 2;
  const by = (b.top + b.bottom) / 2;
  const dx = Math.max(30, Math.abs(ex - sx) / 2) * (right ? 1 : -1);
  return `M${sx} ${ay}C${sx + dx} ${ay} ${ex - dx} ${by} ${ex} ${by}`;
}

function Card(props: { readonly c: OrgCard; readonly p: OrgViewProps }): JSX.Element {
  const sel = (): boolean => props.p.selected === props.c.id;
  const how = (): 'add' | 'remove' | undefined => (props.p.selected && !sel() ? props.p.pick?.(props.c.id) : undefined);
  return (
    <div
      data-kit="org-card"
      data-part="org.card"
      data-m={props.c.id}
      data-sel={flag(sel())}
      data-dim={flag(!!props.p.selected && !sel())}
      data-picked={flag(how() === 'remove')}
      role="button"
      tabIndex={0}
      aria-pressed={sel()}
      onClick={() => props.p.onSelect(sel() ? undefined : props.c.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        props.p.onSelect(sel() ? undefined : props.c.id);
      }}
    >
      <div data-kit="org-face">
        <Face avatar={props.c.avatar} name={props.c.name} {...(props.c.color !== undefined && { color: props.c.color })} size="card" part="crew.avatar" />
        <span data-kit="org-who">
          <b>{props.c.name}</b>
          <small>{props.c.role}</small>
        </span>
        <span data-kit="org-st" data-tone={props.c.state.tone} title={props.c.state.text}>
          {props.c.state.text}
        </span>
      </div>
      <Show when={how()}>
        {(h) => (
          <button
            type="button"
            data-kit="org-pick"
            title={props.p.pickLabel(props.c.id, h())}
            aria-label={props.p.pickLabel(props.c.id, h())}
            onClick={(e) => {
              e.stopPropagation();
              props.p.onPick(props.c.id);
            }}
          >
            <Icon name={h() === 'remove' ? 'check' : 'plus'} size="sm" />
          </button>
        )}
      </Show>
    </div>
  );
}

// size-ok: one view, its parts share the measured boxes
export function OrgView(props: OrgViewProps): JSX.Element {
  const [paths, setPaths] = createSignal<{ d: string; e: OrgEdge }[]>([]);
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  let graphEl: HTMLDivElement | undefined;
  const measure = (): void => {
    const g = graphEl;
    if (!g) return;
    const box = g.getBoundingClientRect();
    const at = new Map<string, Box>();
    for (const c of g.querySelectorAll<HTMLElement>('[data-kit="org-card"]')) {
      const r = c.getBoundingClientRect();
      const left = r.left - box.left;
      const right = r.right - box.left;
      at.set(c.dataset['m'] ?? '', { x: (left + right) / 2, left, right, top: r.top - box.top, bottom: r.bottom - box.top });
    }
    setSize({ w: box.width, h: box.height });
    setPaths(props.edges.flatMap((e) => {
      const a = at.get(e.from);
      const b = at.get(e.to);
      return a && b ? [{ d: edgePath(a, b), e }] : [];
    }));
  };
  const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure());
  onCleanup(() => ro?.disconnect());
  // the arrows follow the graph: a link made or taken off, a member added, the selection
  createEffect(() => {
    void props.edges;
    void props.tiers;
    void props.alone;
    void props.selected;
    requestAnimationFrame(measure);
  });
  return (
    <section data-kit="org-view" data-part="org.page" data-sel={flag(!!props.selected)}>
      <header data-kit="sf-top" data-part="org.head">
        <span data-kit="org-ic">
          <Icon name="org" />
        </span>
        <div data-kit="sf-who">
          <h2 data-kit="sf-title">{props.title}</h2>
          <span data-kit="sf-role">{props.role}</span>
        </div>
        <span data-kit="sf-state">{props.count}</span>
        <span data-kit="sf-acts">
          <For each={props.actions}>
            {(a) => (
              <button type="button" data-kit="sf-ghost" data-a={a.id} title={a.title} onClick={() => a.onClick()}>
                <Icon name={a.icon} size="sm" />
                <span>{a.label}</span>
              </button>
            )}
          </For>
          <Show when={props.close}>
            {(x) => (
              <button type="button" data-kit="icon-button" data-variant="ghost" data-size="sm" title={x().label} aria-label={x().label} onClick={() => x().onClick()}>
                <Icon name="x" size="md" />
              </button>
            )}
          </Show>
        </span>
      </header>
      <div data-kit="org-body">
        <div data-kit="org-chart" data-part="org.chart">
          <Show when={props.hint}>
            {(h) => (
              <p data-kit="org-hint" data-on={flag(h().on)}>
                <span>{h().text}</span>
              </p>
            )}
          </Show>
          <div
            data-kit="org-graph"
            ref={(el) => {
              graphEl = el;
              ro?.observe(el);
              requestAnimationFrame(measure);
            }}
          >
            <svg data-kit="org-edges" width={size().w} height={size().h} aria-hidden="true">
              <defs>
                <marker id="orgArr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path data-kit="org-arr" d="M0 0L8 4L0 8z" />
                </marker>
                <marker id="orgArrOn" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path data-kit="org-arr" data-on="" d="M0 0L8 4L0 8z" />
                </marker>
              </defs>
              <For each={paths()}>
                {(p) => (
                  <g data-kit="org-edge" data-on={flag(p.e.on)} data-off={flag(p.e.off)} data-dim={flag(!!props.selected && !p.e.on)} data-from={p.e.from} data-to={p.e.to}>
                    <title>{p.e.tip}</title>
                    <path data-kit="org-line" d={p.d} marker-end={p.e.on ? 'url(#orgArrOn)' : 'url(#orgArr)'} />
                  </g>
                )}
              </For>
            </svg>
            <div data-kit="org-tiers">
              <For each={props.tiers}>
                {(tier) => (
                  <div data-kit="org-tier" data-layout="wrap">
                    <For each={tier}>{(c) => <Card c={c} p={props} />}</For>
                  </div>
                )}
              </For>
              <Show when={props.alone.length > 0}>
                <div data-kit="org-alone" data-part="org.alone">
                  <h5>{props.aloneLabel}</h5>
                  <div data-kit="org-row-cards" data-layout="wrap">
                    <For each={props.alone}>{(c) => <Card c={c} p={props} />}</For>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </div>
        <aside data-kit="org-side" data-part="org.details">
          {props.side}
        </aside>
      </div>
    </section>
  );
}

/** One person in the side column: their face and name (selects them), and maybe a × that unlinks. */
export function OrgPerson(props: {
  readonly name: string;
  readonly sub: string;
  readonly avatar?: string;
  readonly color?: string | undefined;
  readonly logo?: string | undefined;
  readonly title?: string;
  readonly onPick?: (() => void) | undefined;
  readonly unlink?: { readonly label: string; readonly onClick: () => void } | undefined;
}): JSX.Element {
  const inner = (): JSX.Element => (
    <>
      <Show when={props.avatar !== undefined} fallback={<span data-kit="org-logo">{props.logo ? <img src={props.logo} alt="" /> : <Icon name="agent" size="sm" />}</span>}>
        <Face avatar={props.avatar ?? ''} name={props.name} {...(props.color !== undefined && { color: props.color })} size="xs" />
      </Show>
      <span>
        <b>{props.name}</b>
        <small>{props.sub}</small>
      </span>
    </>
  );
  return (
    <div data-kit="org-row">
      <Show when={props.onPick} fallback={<span data-kit="org-person">{inner()}</span>}>
        {(go) => (
          <button type="button" data-kit="org-person" title={props.title} onClick={() => go()()}>
            {inner()}
          </button>
        )}
      </Show>
      <Show when={props.unlink}>
        {(u) => (
          <button type="button" data-kit="icon-button" data-variant="ghost" data-size="sm" data-part="org.unlink" title={u().label} aria-label={u().label} onClick={() => u().onClick()}>
            <Icon name="x" size="sm" />
          </button>
        )}
      </Show>
    </div>
  );
}

/** A section of the side column (v1 .cv-sec.org-sec): its heading (and a count), then what's in it. */
export function OrgSection(props: { readonly title: string; readonly count?: number | undefined; readonly note?: boolean; readonly children?: JSX.Element }): JSX.Element {
  return (
    <div data-kit="org-sec" data-note={flag(props.note)}>
      <Show when={props.title}>
        <h5>
          {props.title}
          <Show when={props.count}>{(n) => <small>{n()}</small>}</Show>
        </h5>
      </Show>
      {props.children}
    </div>
  );
}

/** The selected member at the top of the side column: face, name, role, state, Open thread and Edit…. */
export function OrgMe(props: {
  readonly name: string;
  readonly role: string;
  readonly avatar: string;
  readonly color?: string | undefined;
  readonly state: OrgCard['state'];
  readonly actions: readonly { readonly icon: IconName; readonly label: string; readonly onClick: () => void }[];
}): JSX.Element {
  return (
    <>
      <div data-kit="org-me">
        <Face avatar={props.avatar} name={props.name} {...(props.color !== undefined && { color: props.color })} size="lg" />
        <div data-kit="org-who">
          <b>{props.name}</b>
          <small>{props.role}</small>
        </div>
      </div>
      <p data-kit="org-st" data-tone={props.state.tone}>
        {props.state.text}
      </p>
      <div data-kit="org-acts">
        <For each={props.actions}>
          {(a) => (
            <button type="button" data-kit="sf-ghost" onClick={() => a.onClick()}>
              <Icon name={a.icon} size="sm" />
              <span>{a.label}</span>
            </button>
          )}
        </For>
      </div>
    </>
  );
}

export interface CrewListRow {
  readonly id: string;
  readonly name: string;
  readonly role?: string | undefined;
  readonly avatar: string;
  readonly color?: string | undefined;
  /** the line under them: what they're doing, or when they next check in */
  readonly sub: string;
  readonly tone?: 'live' | 'asks' | undefined;
  /** jobs at work (a count pill), else when they last did something */
  readonly live?: number | undefined;
  readonly time?: string | undefined;
  readonly paused?: boolean | undefined;
}

/** v1 #secCrew (the phone's list, with no rail): a folding Crew heading with Org and +, then a row per member that
 *  opens their thread, or a dashed row to add the first one. */
export function CrewListSection(props: {
  readonly name: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly org?: { readonly label: string; readonly title: string; readonly on: boolean; readonly onClick: () => void } | undefined;
  readonly add: { readonly label: string; readonly onClick: () => void };
  readonly rows: readonly CrewListRow[];
  readonly empty: { readonly title: string; readonly sub: string };
  readonly openLabel: (name: string) => string;
  readonly onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <section data-kit="f-group" data-crew="" data-part="section.crew" data-collapsed={flag(props.collapsed)}>
      <h4 data-kit="sec-toggle" data-part="section.heading" role="button" tabindex="0" aria-expanded={!props.collapsed} onClick={() => props.onToggle()}>
        <Icon name="chevron" />
        <span data-kit="sec-name" data-text="control">
          {props.name}
        </span>
        <span data-kit="sec-n">{props.count || ''}</span>
      </h4>
      <Show when={props.org}>
        {(o) => (
          <button type="button" data-kit="cr-org" data-part="crew.org" data-on={flag(o().on)} aria-pressed={o().on} title={o().title} onClick={() => o().onClick()}>
            <Icon name="org" size="sm" />
            <span>{o().label}</span>
          </button>
        )}
      </Show>
      <button type="button" data-kit="cr-add" data-part="crew.add" title={props.add.label} aria-label={props.add.label} onClick={() => props.add.onClick()}>
        <Icon name="plus" size="sm" />
      </button>
      <Show when={!props.collapsed}>
        <div data-kit="cr-list">
          <Show
            when={props.rows.length > 0}
            fallback={
              <button type="button" data-kit="cr-row" data-empty="" onClick={() => props.add.onClick()}>
                <Icon name="plus" size="sm" />
                <span data-kit="cr-main">
                  <b>{props.empty.title}</b>
                  <span data-kit="cr-sub">{props.empty.sub}</span>
                </span>
              </button>
            }
          >
            <For each={props.rows}>
              {(m) => (
                <div data-kit="cr-row" data-part="crew.row" data-paused={flag(m.paused)} role="button" tabindex="0" title={props.openLabel(m.name)} onClick={() => props.onOpen(m.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), props.onOpen(m.id))}>
                  <Face avatar={m.avatar} name={m.name} {...(m.color !== undefined && { color: m.color })} size="row" part="crew.avatar" />
                  <span data-kit="cr-main">
                    <span data-kit="cr-top">
                      <b data-kit="cr-name">{m.name}</b>
                      <Show when={m.role}>{(r) => <span data-kit="cr-role">{r()}</span>}</Show>
                    </span>
                    <span data-kit="cr-sub" data-tone={m.tone} title={m.sub}>
                      {m.sub}
                    </span>
                  </span>
                  <span data-kit="cr-side">
                    <Show when={m.live} fallback={<Show when={m.time}>{(tm) => <span>{tm()}</span>}</Show>}>
                      {(n) => <span data-kit="cr-n">{n()}</span>}
                    </Show>
                    <Icon name="chevron" size="sm" />
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </section>
  );
}
