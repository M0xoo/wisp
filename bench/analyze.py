"""Analyze bench/out/runs.jsonl: per-arm quality, the honesty of what agents claim, wisp-side strategies
(repair, best-of-2, escalate) and an online learning router, all replayed from the same recorded runs.

  python bench/analyze.py            -> bench/out/report.md + bench/out/report.json
"""
import json, math, random, statistics, collections, itertools, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
runs = [json.loads(l) for l in open(OUT / 'runs.jsonl') if l.strip()]
runs = [r for r in runs if not r.get('error') and r.get('attempts')]
# Latest record per (task, arm, trial) wins.
by = {}
for r in runs:
    by[(r['task'], r['arm'], r.get('trial', 1))] = r
runs = list(by.values())

ARMS = sorted({r['arm'] for r in runs})
TASKS = sorted({r['task'] for r in runs})
KIND = {r['task']: r['kind'] for r in runs}
DIFF = {r['task']: r.get('difficulty') or '' for r in runs}

# ---- cost model ----------------------------------------------------------------------------
# Claude and Grok report $; Codex / Antigravity / opencode run on subscriptions or free tiers and report
# tokens only. To compare, price their tokens at the observed $/token of the comparable Claude tier.
TIER = {'codex': 'claude-sonnet', 'gemini-argon': 'claude-sonnet', 'gemini-flash': 'claude-haiku', 'deepseek-free': None}

def toks(a):
    s = a.get('stats') or {}
    return (s.get('inputTokens') or 0) + (s.get('outputTokens') or 0)

def usd_per_out_token(arm):
    xs = [(sum((a['stats'] or {}).get('costUsd') or 0 for a in r['attempts']), sum(((a['stats'] or {}).get('outputTokens') or 0) for a in r['attempts'])) for r in runs if r['arm'] == arm]
    c, t = sum(x[0] for x in xs), sum(x[1] for x in xs)
    return c / t if t else 0

RATE = {}
def cost(r, upto=None):
    atts = r['attempts'][: (upto or len(r['attempts']))]
    reported = sum(((a.get('stats') or {}).get('costUsd') or 0) for a in atts)
    if reported or r['arm'] not in TIER:
        return reported
    tier = TIER[r['arm']]
    if not tier:
        return 0.0
    if tier not in RATE:
        RATE[tier] = usd_per_out_token(tier)
    return sum(((a.get('stats') or {}).get('outputTokens') or 0) for a in atts) * RATE[tier]

def minutes(r, upto=None):
    return sum((a.get('wallMs') or 0) for a in r['attempts'][: (upto or len(r['attempts']))]) / 60000

def wilson(k, n, z=1.96):
    if not n:
        return (0, 0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))

def pct(x):
    return f'{100 * x:.0f}%'

# ---- per-arm table -------------------------------------------------------------------------
R = {(r['task'], r['arm']): r for r in runs}  # trial 1 is the unit for the matrix
def raw_ok(r): return bool(r['attempts'][0]['hidden'].get('resolved'))
def fin_ok(r): return bool(r['attempts'][-1]['hidden'].get('resolved'))
def gate(r, i=0): return r['attempts'][i]['gate'].get('pass')
def claim_done(a): return a['claims'].get('hero') == 'done' or a['claims'].get('tests') == 'pass'

arm_rows = []
for arm in ARMS:
    rs = [r for r in runs if r['arm'] == arm]
    n = len(rs)
    k1 = sum(raw_ok(r) for r in rs)
    k2 = sum(fin_ok(r) for r in rs)
    fails = [r for r in rs if not raw_ok(r)]
    false_done = sum(claim_done(r['attempts'][0]) for r in fails)
    gated = [r for r in rs if gate(r) is not None]
    gp = [r for r in gated if gate(r)]
    row = {
        'arm': arm, 'n': n, 'resolved': k1 / n if n else 0, 'ci': wilson(k1, n), 'with_repair': k2 / n if n else 0,
        'by_kind': {k: (sum(raw_ok(r) for r in rs if r['kind'] == k), sum(1 for r in rs if r['kind'] == k)) for k in ('swe', 'wisp', 'hb')},
        'usd': sum(cost(r, 1) for r in rs) / n if n else 0,
        'usd_reported': all(((a.get('stats') or {}).get('costUsd') is not None) for r in rs for a in r['attempts'][:1]),
        'tokens_k': statistics.median([toks(r['attempts'][0]) for r in rs]) / 1000 if rs else 0,
        'min_median': statistics.median([r['attempts'][0]['wallMs'] / 60000 for r in rs]) if rs else 0,
        'false_done': false_done / len(fails) if fails else 0, 'fails': len(fails),
        'gate_precision': (sum(raw_ok(r) for r in gp) / len(gp)) if gp else None, 'gate_pass': len(gp), 'gated': len(gated),
        'repairs': sum(len(r['attempts']) > 1 for r in rs), 'repair_fixed': sum(len(r['attempts']) > 1 and not raw_ok(r) and fin_ok(r) for r in rs),
        'repair_broke': sum(len(r['attempts']) > 1 and raw_ok(r) and not fin_ok(r) for r in rs),
        'timeouts': sum(r['attempts'][0].get('timedOut') for r in rs), 'errors': sum(r['attempts'][0].get('isError') for r in rs),
        'leaks': sum(bool(a.get('leaks')) for r in rs for a in r['attempts']),
        'lines_median': statistics.median([r['attempts'][0]['diff']['added'] + r['attempts'][0]['diff']['removed'] for r in rs]) if rs else 0,
    }
    arm_rows.append(row)
arm_rows.sort(key=lambda x: -x['resolved'])

# ---- strategies over complete tasks --------------------------------------------------------
complete = [t for t in TASKS if all((t, a) in R for a in ARMS)]

def single(arm, repair):
    out = []
    for t in complete:
        r = R[(t, arm)]
        upto = None if repair else 1
        ok = fin_ok(r) if repair else raw_ok(r)
        out.append((ok, cost(r, upto), minutes(r, upto)))
    return out

def visible_ok(r):
    """What wisp can see after a run: its gate when the task has tests, else the agent's own claim."""
    g = r['attempts'][-1]['gate'].get('pass')
    return g if g is not None else claim_done(r['attempts'][-1])

def best_of_2(a, b):
    out = []
    for t in complete:
        ra, rb = R[(t, a)], R[(t, b)]
        va, vb = visible_ok(ra), visible_ok(rb)
        pick = ra if va or not vb else rb  # prefer a passing check; a first on ties
        out.append((fin_ok(pick), cost(ra) + cost(rb), max(minutes(ra), minutes(rb))))
    return out

def escalate(a, b):
    out = []
    for t in complete:
        ra, rb = R[(t, a)], R[(t, b)]
        if visible_ok(ra):
            out.append((fin_ok(ra), cost(ra), minutes(ra)))
        else:
            out.append((fin_ok(rb), cost(ra) + cost(rb), minutes(ra) + minutes(rb)))
    return out

def summarize(name, xs):
    n = len(xs)
    k = sum(x[0] for x in xs)
    return {'strategy': name, 'n': n, 'resolved': k / n if n else 0, 'ci': wilson(k, n), 'usd': sum(x[1] for x in xs) / n if n else 0,
            'min': sum(x[2] for x in xs) / n if n else 0, 'usd_per_solve': (sum(x[1] for x in xs) / k) if k else None}

strategies = []
if complete:
    for a in ARMS:
        strategies.append(summarize(f'{a}', single(a, False)))
        strategies.append(summarize(f'{a} + repair', single(a, True)))
    top = [x['arm'] for x in arm_rows[:4]]
    for a, b in itertools.combinations(top, 2):
        strategies.append(summarize(f'best-of-2 {a} | {b}', best_of_2(a, b)))
    cheap = sorted(ARMS, key=lambda a: next(x['usd'] for x in arm_rows if x['arm'] == a))[:3]
    for a in cheap:
        for b in top[:2]:
            if a != b:
                strategies.append(summarize(f'escalate {a} → {b}', escalate(a, b)))
    oracle = [(any(fin_ok(R[(t, a)]) for a in ARMS), 0, 0) for t in complete]
    strategies.append(summarize('oracle (any arm, hindsight)', oracle))
strategies.sort(key=lambda s: (-s['resolved'], s['usd']))

# ---- online learning router ----------------------------------------------------------------
# Actions = each arm with wisp's repair, plus escalations cheap→strong. Context = benchmark source ×
# difficulty bucket. Thompson sampling on Beta posteriors, utility = V·p − $ − m·minutes.
def ctx(t):
    d = DIFF[t]
    b = 'easy' if d in ('<15 min fix', 'easy') else 'hard' if d in ('1-4 hours', '>4 hours', 'hard') else 'medium'
    return f'{KIND[t]}:{b}'

def action_outcome(act, t):
    kind, a, b = act
    if kind == 'single':
        r = R[(t, a)]
        return fin_ok(r), visible_ok(r), cost(r), minutes(r)
    ra, rb = R[(t, a)], R[(t, b)]
    if visible_ok(ra):
        return fin_ok(ra), True, cost(ra), minutes(ra)
    return fin_ok(rb), visible_ok(rb), cost(ra) + cost(rb), minutes(ra) + minutes(rb)

def actions(arms):
    acts = [('single', a, None) for a in arms]
    cheap = [a for a in arms if a in ('claude-haiku', 'gemini-flash', 'deepseek-free', 'codex')]
    strong = [a for a in arms if a in ('claude-opus', 'claude-sonnet', 'codex', 'gemini-argon')]
    acts += [('escalate', a, b) for a in cheap for b in strong if a != b]
    return acts

def simulate(V=5.0, m=0.05, signal='hidden', perms=300, prior=None, hide=None, hide_until=0, family_prior=None, seed=1):
    """Returns mean solved rate, $/task and the policy's regret vs the best fixed action in hindsight."""
    rng = random.Random(seed)
    totals = []
    adopt = []
    for p in range(perms):
        order = complete[:]
        rng.shuffle(order)
        post = collections.defaultdict(lambda: [1.0, 1.0])
        if prior:
            for k, (a, b) in prior.items():
                post[k] = [a, b]
        cst = collections.defaultdict(lambda: [0.0, 0])  # running $ and minutes per action
        solved = spent = 0.0
        picks_new = []
        for i, t in enumerate(order):
            arms = [a for a in ARMS if not (hide and a == hide and i < hide_until)]
            acts = actions(arms)
            if hide and i == hide_until and family_prior:
                for c in {ctx(x) for x in complete}:
                    for act in acts:
                        if hide in (act[1], act[2]):
                            src = (c, (act[0], family_prior if act[1] == hide else act[1], family_prior if act[2] == hide else act[2]))
                            if src in post:
                                a0, b0 = post[src]
                                s = min(1.0, 8.0 / (a0 + b0))  # inherit the family's rate, at most 8 pseudo-counts
                                post[(c, act)] = [1 + (a0 - 1) * s, 1 + (b0 - 1) * s]
            best, bu = None, -1e9
            for act in acts:
                a, b = post[(ctx(t), act)]
                theta = rng.betavariate(a, b)
                c, n = cst[act]
                ec = c / n if n else 0.5
                em = cst[('min', act)][0] / n if n else 10
                u = V * theta - ec - m * em
                if u > bu:
                    best, bu = act, u
            ok, vis, usd, mins = action_outcome(best, t)
            reward = ok if signal == 'hidden' else vis
            post[(ctx(t), best)][0 if reward else 1] += 1
            cst[best][0] += usd; cst[best][1] += 1
            cst[('min', best)][0] += mins
            solved += ok
            spent += usd
            if hide:
                picks_new.append(hide in (best[1], best[2]) if i >= hide_until else None)
        totals.append((solved / len(order), spent / len(order)))
        if hide:
            adopt.append(picks_new)
    res = {'resolved': statistics.mean(x[0] for x in totals), 'usd': statistics.mean(x[1] for x in totals)}
    if hide:
        tail = [x for run in adopt for x in run[hide_until:] if x is not None]
        res['new_arm_share_after'] = sum(tail) / len(tail) if tail else 0
    return res

def fixed(act):
    xs = [action_outcome(act, t) for t in complete]
    return {'resolved': sum(x[0] for x in xs) / len(xs), 'usd': sum(x[2] for x in xs) / len(xs)}

router = {}
if len(complete) >= 6:
    for V in (1.0, 5.0, 50.0):
        best_fixed = max(actions(ARMS), key=lambda a: V * fixed(a)['resolved'] - fixed(a)['usd'])
        router[f'V={V:g}'] = {
            'router_hidden_signal': simulate(V=V, signal='hidden'),
            'router_visible_signal': simulate(V=V, signal='visible'),
            'best_fixed_in_hindsight': {'action': ' → '.join(x for x in best_fixed[1:] if x), **fixed(best_fixed)},
        }
    # Leave-one-source-out priors: what shipped defaults (learned on the other benchmarks) buy a new user.
    for held in ('wisp', 'hb', 'swe'):
        train = [t for t in complete if KIND[t] != held]
        test = [t for t in complete if KIND[t] == held]
        if not test or not train:
            continue
        prior = collections.defaultdict(lambda: [1.0, 1.0])
        for t in train:
            for act in actions(ARMS):
                ok = action_outcome(act, t)[0]
                key = (f'{held}:' + ctx(t).split(':')[1], act)  # map onto the held-out source's contexts
                prior[key][0 if ok else 1] += 1
        capped = {k: [1 + (a - 1) * min(1, 20 / (a + b)), 1 + (b - 1) * min(1, 20 / (a + b))] for k, (a, b) in prior.items()}
        saved = complete[:]
        complete[:] = test
        router[f'cold start on {held}'] = {'uniform_prior': simulate(V=5.0, prior=None, perms=200), 'shipped_prior': simulate(V=5.0, prior=capped, perms=200)}
        complete[:] = saved
    # A new model appears halfway: how fast does the router pick it up, with and without a family prior?
    for new, fam in (('claude-opus', 'claude-sonnet'), ('codex', None), ('gemini-argon', 'gemini-flash')):
        if new in ARMS:
            k = len(complete) // 3
            router[f'new arm {new} after {k} tasks'] = {'no_prior': simulate(V=5.0, hide=new, hide_until=k, perms=200), 'family_prior': simulate(V=5.0, hide=new, hide_until=k, family_prior=fam, perms=200) if fam else None}

# ---- write ---------------------------------------------------------------------------------
report = {'runs': len(runs), 'tasks': len(TASKS), 'complete_tasks': len(complete), 'arms': arm_rows, 'strategies': strategies, 'router': router,
          'tasks_by_kind': collections.Counter(KIND[t] for t in TASKS), 'complete_by_kind': collections.Counter(KIND[t] for t in complete), 'rates': RATE}
(OUT / 'report.json').write_text(json.dumps(report, indent=1, default=str))

L = [f'# wisp-bench report\n\n{len(runs)} runs · {len(TASKS)} tasks ({dict(report["tasks_by_kind"])}) · {len(complete)} tasks complete across all {len(ARMS)} arms\n']
L.append('## Arms (first attempt, hidden tests)\n\n| arm | n | solved | 95% CI | +repair | swe | wisp | hb | $/task | med min | med tok k | false "done" on failures | gate precision | leaks |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for x in arm_rows:
    bk = x['by_kind']
    L.append(f"| {x['arm']} | {x['n']} | {pct(x['resolved'])} | {pct(x['ci'][0])}–{pct(x['ci'][1])} | {pct(x['with_repair'])} | {bk['swe'][0]}/{bk['swe'][1]} | {bk['wisp'][0]}/{bk['wisp'][1]} | {bk['hb'][0]}/{bk['hb'][1]} | {x['usd']:.2f}{'' if x['usd_reported'] else '*'} | {x['min_median']:.1f} | {x['tokens_k']:.0f} | {pct(x['false_done'])} of {x['fails']} | {'' if x['gate_precision'] is None else pct(x['gate_precision'])} ({x['gate_pass']}/{x['gated']}) | {x['leaks']} |")
L.append('\n\\* estimated from tokens at the comparable Claude tier\'s $/token (subscription/free harnesses report no $).\n')
L.append('## Strategies on tasks every arm finished\n\n| strategy | solved | 95% CI | $/task | min/task | $/solve |\n|---|---|---|---|---|---|')
for s in strategies:
    L.append(f"| {s['strategy']} | {pct(s['resolved'])} | {pct(s['ci'][0])}–{pct(s['ci'][1])} | {s['usd']:.2f} | {s['min']:.1f} | {'' if s['usd_per_solve'] is None else f'{s["usd_per_solve"]:.2f}'} |")
L.append('\n## Learning router (simulated online over random task orders)\n')
for k, v in router.items():
    L.append(f'- **{k}**: ' + '; '.join(f'{kk}: ' + (', '.join(f'{a}={b:.3f}' if isinstance(b, float) else f'{a}={b}' for a, b in vv.items()) if isinstance(vv, dict) else str(vv)) for kk, vv in v.items()))
(OUT / 'report.md').write_text('\n'.join(L) + '\n')
print('\n'.join(L))
