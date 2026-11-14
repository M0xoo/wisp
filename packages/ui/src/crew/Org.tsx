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
  /** where you put each member, x from the chart's middle and y from its top (v1 /crew-layout); with none placed, the
   *  tiers lay themselves out. Members not placed yet go in rows under the rest. */
  readonly layout?: Readonly<Record<string, Spot>> | undefined;
  /** a card dragged to a new spot (with a mouse from anywhere on it, on touch once it's selected): every card's spot */
  readonly onMove?: ((layout: Record<string, Spot>) => void) | undefined;
  /** a link drawn from a card's handle onto another card */
  readonly onLink?: ((from: string, to: string) => void) | undefined;
  /** the handle's name (a screen reader's, and its tip) */
  readonly handleLabel?: ((name: string) => string) | undefined;
}

export interface Spot {
  readonly x: number;
  readonly y: number;
}

/** The free chart's gaps (v1 org.js GAP and the row step). */
const FREE_GAP = 18;
const FREE_ROW = 22;

/** Where each card sits in the free chart (v1 placeFree): placed ones at their spot, the rest in rows under them,
 *  centred; nothing cut off on the left (the shift holds while the width does). Pure: sizes in, left/top out. */
export function placeFree(
  ids: readonly string[],
  layout: Readonly<Record<string, Spot>>,
  o: { w: number; cw: number; ch: number; shift?: number },
): { at: Map<string, { left: number; top: number }>; shift: number; height: number; minWidth: number } {
  const spot = new Map<string, Spot>(ids.filter((id) => layout[id]).map((id) => [id, layout[id] as Spot]));
  const rest = ids.filter((id) => !spot.has(id));
  if (rest.length) {
    const y0 = spot.size ? Math.max(...[...spot.values()].map((p) => p.y)) + o.ch + 40 : 0;
    const per = Math.max(1, Math.floor((o.w + FREE_GAP) / (o.cw + FREE_GAP)));
    rest.forEach((id, i) => {
      const n = Math.min(per, rest.length - Math.floor(i / per) * per);
      spot.set(id, { x: -(n * o.cw + (n - 1) * FREE_GAP) / 2 + (i % per) * (o.cw + FREE_GAP), y: y0 + Math.floor(i / per) * (o.ch + FREE_ROW) });
    });
  }
  const xs = [...spot.values()].map((p) => p.x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs) + o.cw;
  const shift = Math.max(o.shift ?? o.w / 2, -lo);
  const at = new Map([...spot].map(([id, p]) => [id, { left: Math.round(p.x + shift), top: Math.round(p.y) }]));
  return { at, shift, height: Math.max(...[...spot.values()].map((p) => p.y)) + o.ch, minWidth: hi + shift > o.w ? hi + shift : 0 };
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

function Card(props: { readonly c: OrgCard; readonly p: OrgViewProps; readonly over?: boolean; readonly lifted?: boolean }): JSX.Element {
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
      data-drop={props.over ? ((props.p.edges.some((x) => x.to === props.c.id && x.from === props.p.selected) ? 'no' : 'ok') as string) : undefined}
      data-lifted={flag(props.lifted)}
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
      <Show when={props.p.onLink}>
        <span data-kit="org-port" role="presentation" title={props.p.handleLabel?.(props.c.name)} data-from={props.c.id} />
      </Show>
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

// size-ok: one view, its parts share the measured boxes and the pointer's drags
export function OrgView(props: OrgViewProps): JSX.Element {
  const [paths, setPaths] = createSignal<{ d: string; e: OrgEdge }[]>([]);
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  // a link being drawn from a card's handle (graph coordinates), the card it's over; a card being moved
  const [temp, setTemp] = createSignal<{ x0: number; y0: number; x: number; y: number } | undefined>();
  const [over, setOver] = createSignal<string | undefined>();
  const [moving, setMoving] = createSignal<string | undefined>();
  // the spots while a drag holds them (the tiers pinned where they sat, then the card moved), until the owner's arrive
  const [held, setHeld] = createSignal<Readonly<Record<string, Spot>> | undefined>();
  createEffect(() => {
    void props.layout;
    setHeld(undefined);
  });
  const cards = (): OrgCard[] => [...props.tiers.flat(), ...props.alone];
  const spots = (): Readonly<Record<string, Spot>> => held() ?? props.layout ?? {};
  const free = (): boolean => cards().some((c) => spots()[c.id]);
  let graphEl: HTMLDivElement | undefined;
  let freeEl: HTMLDivElement | undefined;
  let shift: { w: number; at: number } | undefined;
  const cardEls = (): HTMLElement[] => [...(graphEl?.querySelectorAll<HTMLElement>('[data-kit="org-card"]') ?? [])];
  const place = (): void => {
    const box = freeEl;
    if (!box || !graphEl) return;
    const els = [...box.querySelectorAll<HTMLElement>(':scope > [data-kit="org-card"]')];
    const first = els[0];
    if (!first) return;
    const w = graphEl.clientWidth;
    const out = placeFree(
      els.map((e) => e.dataset['m'] ?? ''),
      spots(),
      { w, cw: first.offsetWidth, ch: first.offsetHeight, ...(shift && shift.w === w && { shift: shift.at }) },
    );
    shift = { w, at: out.shift };
    for (const e of els) {
      const at = out.at.get(e.dataset['m'] ?? '');
      if (!at || e.dataset['m'] === moving()) continue;
      e.style.setProperty('left', `${at.left}px`);
      e.style.setProperty('top', `${at.top}px`);
    }
    box.style.setProperty('height', `${out.height}px`);
    box.style.setProperty('min-width', out.minWidth ? `${out.minWidth}px` : '');
  };
  const measure = (): void => {
    const g = graphEl;
    if (!g) return;
    if (free()) place();
    const box = g.getBoundingClientRect();
    const at = new Map<string, Box>();
    for (const c of cardEls()) {
      const r = c.getBoundingClientRect();
      const left = r.left - box.left;
      const right = r.right - box.left;
      at.set(c.dataset['m'] ?? '', { x: (left + right) / 2, left, right, top: r.top - box.top, bottom: r.bottom - box.top });
    }
    setSize({ w: box.width, h: box.height });
    setPaths(
      props.edges.flatMap((e) => {
        const a = at.get(e.from);
        const b = at.get(e.to);
        return a && b ? [{ d: edgePath(a, b), e }] : [];
      }),
    );
  };
  const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure());
  onCleanup(() => ro?.disconnect());
  // the arrows follow the graph: a link made or taken off, a member added, the selection, a spot
  createEffect(() => {
    void props.edges;
    void props.tiers;
    void props.alone;
    void props.selected;
    void spots();
    requestAnimationFrame(measure);
  });
  // Every card as it sits now, as spots (x from the middle): what a move saves (v1 where()).
  const where = (moved?: { id: string; left: number; top: number }): Record<string, Spot> => {
    const out: Record<string, Spot> = {};
    const g = graphEl?.getBoundingClientRect();
    const f = freeEl?.getBoundingClientRect() ?? g;
    if (!g || !f) return out;
    const mid = shift?.at ?? g.width / 2;
    for (const c of cardEls()) {
      const id = c.dataset['m'] ?? '';
      const r = c.getBoundingClientRect();
      const left = moved?.id === id ? moved.left : r.left - f.left;
      const top = moved?.id === id ? moved.top : r.top - f.top;
      out[id] = { x: Math.round(left - (freeEl ? mid : g.width / 2)), y: Math.round(top) };
    }
    return out;
  };
  // A card dragged to a new spot: it follows the pointer, arrows and all, and is saved on release (Escape-free: a
  // cancelled pointer puts it back).
  const onCardDown = (e: PointerEvent): void => {
    const card = (e.target as Element).closest<HTMLElement>('[data-kit="org-card"]');
    if (!card || e.button !== 0 || !props.onMove || (e.target as Element).closest('button, [data-kit="org-port"]')) return;
    const id = card.dataset['m'] ?? '';
    if (e.pointerType === 'touch' && props.selected !== id) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let m: { el: HTMLElement; l0: number; t0: number; left: number; top: number; room: number } | undefined;
    const go = (ev: PointerEvent): void => {
      if (!m) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        if (!free()) setHeld(where()); // the tiers pinned where they sit, into the free chart
        measure();
        const el = graphEl?.querySelector<HTMLElement>(`[data-kit="org-card"][data-m="${CSS.escape(id)}"]`);
        if (!el) return;
        const left = parseFloat(el.style.left) || 0;
        const top = parseFloat(el.style.top) || 0;
        m = { el, l0: left, t0: top, left, top, room: Math.max(left, (graphEl?.clientWidth ?? 0) - el.offsetWidth) };
        setMoving(id);
        getSelection()?.removeAllRanges();
      }
      ev.preventDefault();
      // kept inside the chart's width: it grows downwards, not sideways
      m.left = Math.max(0, Math.min(m.l0 + ev.clientX - x0, m.room));
      m.top = Math.max(0, m.t0 + ev.clientY - y0);
      m.el.style.setProperty('left', `${m.left}px`);
      m.el.style.setProperty('top', `${m.top}px`);
      requestAnimationFrame(measure);
    };
    const end = (ev: PointerEvent): void => {
      removeEventListener('pointermove', go);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      if (!m) return;
      const done = m;
      setMoving(undefined);
      // the click a drag ends with doesn't select the card
      card.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true });
      if (ev.type === 'pointerup') {
        const next = where({ id, left: done.left, top: done.top });
        setHeld(next);
        props.onMove?.(next);
      } else setHeld(undefined);
    };
    addEventListener('pointermove', go, { passive: false });
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  };
  // Drag from a card's handle onto another card: a link, drawn as it goes.
  const onDown = (e: PointerEvent): void => {
    const port = (e.target as Element).closest<HTMLElement>('[data-kit="org-port"]');
    if (!port) return onCardDown(e);
    if (e.button !== 0 || !props.onLink || !graphEl) return;
    const from = port.dataset['from'] ?? '';
    e.preventDefault();
    const g = graphEl.getBoundingClientRect();
    const r = port.getBoundingClientRect();
    const x0 = r.left + r.width / 2 - g.left;
    const y0 = r.top + r.height / 2 - g.top;
    setTemp({ x0, y0, x: e.clientX - g.left, y: e.clientY - g.top });
    port.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const gg = graphEl?.getBoundingClientRect() ?? g;
      setTemp({ x0, y0, x: ev.clientX - gg.left, y: ev.clientY - gg.top });
      const card = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-kit="org-card"]');
      const to = card?.dataset['m'];
      setOver(to && to !== from ? to : undefined);
    };
    const up = (): void => {
      port.removeEventListener('pointermove', move);
      const to = over();
      setTemp(undefined);
      setOver(undefined);
      if (to) props.onLink?.(from, to);
    };
    port.addEventListener('pointermove', move);
    port.addEventListener('pointerup', up, { once: true });
    port.addEventListener('pointercancel', () => (port.removeEventListener('pointermove', move), setTemp(undefined), setOver(undefined)), { once: true });
  };
  const cardOf = (c: OrgCard): JSX.Element => <Card c={c} p={props} over={over() === c.id} lifted={moving() === c.id} />;
  return (
    <section data-kit="org-view" data-part="org.page" data-sel={flag(!!props.selected)} data-dragging={flag(!!temp())} data-moving={flag(!!moving())}>
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
            data-free={flag(free())}
            onPointerDown={onDown}
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
              <Show when={temp()}>{(l) => <path data-kit="org-temp" d={`M${l().x0} ${l().y0}L${l().x} ${l().y}`} />}</Show>
            </svg>
            <Show
              when={free()}
              fallback={
                <div data-kit="org-tiers">
                  <For each={props.tiers}>
                    {(tier) => (
                      <div data-kit="org-tier" data-layout="wrap">
                        <For each={tier}>{cardOf}</For>
                      </div>
                    )}
                  </For>
                  <Show when={props.alone.length > 0}>
                    <div data-kit="org-alone" data-part="org.alone">
                      <h5>{props.aloneLabel}</h5>
                      <div data-kit="org-row-cards" data-layout="wrap">
                        <For each={props.alone}>{cardOf}</For>
                      </div>
                    </div>
                  </Show>
                </div>
              }
            >
              <div data-kit="org-free" data-part="org.free" ref={(el) => (freeEl = el)}>
                <For each={cards()}>{cardOf}</For>
              </div>
            </Show>
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
  /** the member's jobs for other tasks, as list cards, under the row (v1 .cr-jobs); none: nothing under it */
  readonly jobs?: JSX.Element | undefined;
  /** more jobs than shown: "2 more · open Ada" (v1 .cr-more), opening the member; read as it changes, so a job
   * coming or going never rebuilds the member's row */
  readonly more?: (() => string | undefined) | undefined;
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
  /** after the rows: the folded members' strip, or Show fewer (v1 .cr-strip, .cr-fewer) */
  readonly foot?: JSX.Element;
  /** the pointer or focus came in (true) or left (false): the caller holds its rows still meanwhile (v1 holding) */
  readonly onHold?: (on: boolean) => void;
}): JSX.Element {
  const hold = (on: boolean) => () => props.onHold?.(on);
  const leave = (e: FocusEvent): void => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) props.onHold?.(false);
  };
  return (
    <section
      data-kit="f-group"
      data-crew=""
      data-part="section.crew"
      data-collapsed={flag(props.collapsed)}
      onPointerEnter={hold(true)}
      onPointerLeave={hold(false)}
      onFocusIn={hold(true)}
      onFocusOut={leave}
    >
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
                <div data-kit="cr-member" data-part="crew.member">
                  <div
                    data-kit="cr-row"
                    data-part="crew.row"
                    data-paused={flag(m.paused)}
                    role="button"
                    tabindex="0"
                    title={props.openLabel(m.name)}
                    onClick={() => props.onOpen(m.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), props.onOpen(m.id))}
                  >
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
                  <Show when={m.jobs}>
                    {(jobs) => (
                      <div data-kit="cr-jobs" data-part="crew.jobs">
                        {jobs()}
                      </div>
                    )}
                  </Show>
                  <Show when={m.more?.()}>
                    {(more) => (
                      <button type="button" data-kit="cr-more" data-part="crew.more" onClick={() => props.onOpen(m.id)}>
                        {more()}
                      </button>
                    )}
                  </Show>
                </div>
              )}
            </For>
            {props.foot}
          </Show>
        </div>
      </Show>
    </section>
  );
}
