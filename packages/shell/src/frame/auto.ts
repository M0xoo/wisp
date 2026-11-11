// The launcher's Auto (v1 web/js/auto-preview.js, launcher.js), DOM-free: what Auto would run for the prompt
// (`router.preview`, asked after a pause in typing) and, when you pick your own harness after it showed one, the
// `autoOverride` the new task carries so Auto learns from it (backend round 4: runtime reports it to the router).

/** What `router.preview` answers: a pick, or nothing Auto may use can run (`pick: null`). */
export interface AutoPreview {
  readonly pick: { readonly agent: string; readonly model: string; readonly effort: string; readonly key: string; readonly label: string } | null;
  readonly type?: string;
  readonly why: string;
  readonly chance?: number;
  readonly usd?: number;
}

/** v1 waits this long after the last key before asking. */
export const PREVIEW_DEBOUNCE = 300;

/** The runner chip under Auto: the preview's harness and its model · level, or the default harness. */
export function autoPick(p: AutoPreview | undefined): { agent: string; label: string } | undefined {
  if (!p?.pick) return undefined;
  // v1 shortLabel: the router's label leads with the harness ("Codex · GPT-5 · High"), the logo says that
  return { agent: p.pick.agent, label: p.pick.model ? p.pick.label.split(' · ').slice(1).join(' · ') : p.pick.label };
}

/** Your pick differs from what Auto showed: a harness of your own, or a model of your own on its harness. */
export function overrideOf(p: AutoPreview | undefined, chose: { agent: string; model: string }): { key: string; type?: string } | undefined {
  if (!p?.pick || chose.agent === 'auto' || !chose.agent) return undefined;
  const same = chose.agent === p.pick.agent && (!chose.model || chose.model === p.pick.model);
  return same ? undefined : { key: p.pick.key, ...(p.type && { type: p.type }) };
}

/** How Auto picked a task's run (`ext["wisp.router"].route`), what the row's logo tip says. */
export interface RouteSeen {
  readonly goal?: string;
  readonly type?: string;
  readonly label?: string;
  readonly chance?: number;
  readonly n?: number;
  readonly usd?: number;
  readonly why?: string;
  readonly trying?: boolean;
  readonly explored?: boolean;
  readonly pinned?: boolean;
  readonly switched?: boolean;
  readonly suggest?: { readonly label?: string } | null;
}

/** The route on a session row, unless you moved the task to another harness since (v1 feed.js). */
export function routeOf(body: Readonly<Record<string, unknown>> | undefined): RouteSeen | undefined {
  const ext = body?.['ext'] as Readonly<Record<string, unknown>> | undefined;
  const r = (ext?.['wisp.router'] as { route?: RouteSeen } | undefined)?.route;
  return r && typeof r === 'object' && !r.switched ? r : undefined;
}

type T = (k: string, vars?: Readonly<Record<string, string | number>>) => string;

/** v1 runners.js routeTip: "Auto · Balanced → Sonnet · High · 82% on your bugfix tasks (12) · ~$0.40". */
export function routeTip(r: RouteSeen, t: T): string {
  const goal = t(`shell.auto.goal.${r.goal === 'cheap' || r.goal === 'best' ? r.goal : 'balanced'}`);
  const pct = Math.round((r.chance ?? 0) * 100);
  const record = r.n ? t('shell.auto.record', { pct, type: r.type ?? '', n: r.n }) : t('shell.auto.expected', { pct, type: r.type ?? '' });
  const parts = r.why ? r.why.split(' · ').filter((x) => x !== 'as previewed' && !/ thinking for /.test(x)) : [r.trying ? t('shell.auto.trying') : r.explored ? t('shell.auto.explored') : record];
  const pinned = r.pinned || r.why?.includes('as previewed');
  return [
    `${t('shell.auto.head', { goal, label: r.label ?? '' })}${pinned ? t('shell.auto.previewed') : ''}`,
    ...parts,
    ...(r.usd ? [t('shell.auto.usd', { usd: r.usd.toFixed(2) })] : []),
    ...(r.suggest?.label ? [t('shell.auto.suggest', { label: r.suggest.label })] : []),
  ].join(' · ');
}
