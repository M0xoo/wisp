"""SWE-bench Verified, run natively (no Docker): prepare a workdir with its own venv, grade with hidden tests,
and run wisp's visible gate. Uses swebench 3.x specs and log parsers.

  python swe.py select N            -> writes bench/out/swe-pick.json
  python swe.py prepare ID DEST     -> history-free snapshot at base_commit + .venv
  python swe.py validate ID         -> F2P fails at base, F2P+P2P pass with the gold patch
  python swe.py hidden ID DIR       -> grade DIR with the hidden test patch (restores DIR after)
  python swe.py gate ID DIR         -> wisp's visible check: no regressions in visible tests, agent's tests pass
"""
import json, os, re, subprocess, sys, shutil, random, tempfile
from pathlib import Path
from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS
from swebench.harness.log_parsers import MAP_REPO_TO_PARSER
from swebench.harness.test_spec.python import get_test_directives

HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
CACHE = Path('/tmp/wb/repos')
DATA = Path.home() / '.wisp-bench-private' / 'verified.jsonl'
REPOS = {'django/django', 'sympy/sympy', 'pytest-dev/pytest'}
PY_OK = {'3.8', '3.9', '3.10', '3.11'}
TEST_TIMEOUT = 1200

def rows():
    return {r['instance_id']: r for r in map(json.loads, open(DATA))}

def spec(inst):
    return MAP_REPO_VERSION_TO_SPECS[inst['repo']][inst['version']]

def sh(cmd, cwd=None, env=None, timeout=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, env=env, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f'{cmd} failed ({p.returncode}): {p.stderr[-2000:]}{p.stdout[-1000:]}')
    return p

def mirror(repo):
    d = CACHE / (repo.replace('/', '__') + '.git')
    if not d.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        sh(['git', 'clone', '-q', '--bare', f'https://github.com/{repo}.git', str(d)])
    return d

def venv_env(d):
    env = dict(os.environ)
    env['VIRTUAL_ENV'] = str(Path(d) / '.venv')
    env['PATH'] = f"{Path(d) / '.venv' / 'bin'}:{env['PATH']}"
    env.pop('PYTHONPATH', None)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env

def prepare(iid, dest):
    inst = rows()[iid]
    s = spec(inst)
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    m = mirror(inst['repo'])
    # History-free snapshot: the agent can't `git log` its way to the real fix.
    sh(f"git --git-dir={m} archive {inst['base_commit']} | tar -x -C {dest}")
    sh(['git', 'init', '-q'], cwd=dest)
    (dest / '.git' / 'info' / 'exclude').write_text('.venv/\n*.egg-info/\n__pycache__/\n.pytest_cache/\n')
    sh(['git', 'add', '-A'], cwd=dest)
    sh(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@wisp', 'commit', '-qm', 'base'], cwd=dest)
    sh(['uv', 'venv', '-q', '-p', s['python'], str(dest / '.venv')])
    env = venv_env(dest)
    env['SETUPTOOLS_SCM_PRETEND_VERSION'] = f"{inst['version']}.0" if inst['version'].count('.') == 1 else inst['version']
    pkgs = list(s.get('pip_packages', []))
    if inst['repo'] == 'sympy/sympy':
        pkgs = pkgs or ['mpmath==1.3.0']
    if inst['repo'] == 'pytest-dev/pytest':
        pkgs += ['setuptools<70', 'setuptools_scm<8', 'wheel']
    if inst['repo'] in ('django/django', 'sympy/sympy'):
        pkgs += ['setuptools<70', 'wheel']
    if pkgs:
        sh(['uv', 'pip', 'install', '-q', '--python', str(dest / '.venv' / 'bin' / 'python'), *pkgs], env=env)
    sh(['uv', 'pip', 'install', '-q', '--python', str(dest / '.venv' / 'bin' / 'python'), '--no-build-isolation', '-e', str(dest)], env=env)
    return inst

def test_files(patch):
    return re.findall(r'diff --git a/.* b/(.*)', patch)

def run_tests(inst, d, directives):
    s = spec(inst)
    cmd = f"{s['test_cmd']} {' '.join(directives)}"
    try:
        p = sh(cmd, cwd=d, env=venv_env(d), timeout=TEST_TIMEOUT, check=False)
        log = p.stdout + '\n' + p.stderr
    except subprocess.TimeoutExpired as e:
        log = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
    return MAP_REPO_TO_PARSER[inst['repo']](log, None), log

def apply(d, patch, reverse=False):
    with tempfile.NamedTemporaryFile('w', suffix='.diff', delete=False) as f:
        f.write(patch)
    args = ['git', 'apply', '-v'] + (['-R'] if reverse else []) + [f.name]
    p = sh(args, cwd=d, check=False)
    if p.returncode:  # fall back to patch(1), like the swebench harness does
        p = sh(f"patch --batch --fuzz=5 -p1 {'-R ' if reverse else ''}-i {f.name}", cwd=d, check=False)
    return p.returncode == 0

def passed(st):
    return st in ('PASSED', 'XFAIL')

def grade(inst, d):
    """Hidden grading in place: reset the test files the test patch touches, apply it, run, restore."""
    d = Path(d)
    files = test_files(inst['test_patch'])
    saved = {f: (d / f).read_bytes() if (d / f).exists() else None for f in files}
    try:
        for f in files:
            sh(['git', 'checkout', 'HEAD', '--', f], cwd=d, check=False)  # HEAD = base snapshot
        if not apply(d, inst['test_patch']):
            return {'resolved': False, 'error': 'test patch did not apply'}
        status, log = run_tests(inst, d, get_test_directives(inst))
    finally:
        for f, b in saved.items():
            if b is None:
                (d / f).unlink(missing_ok=True)
            else:
                (d / f).write_bytes(b)
    f2p = json.loads(inst['FAIL_TO_PASS'])
    p2p = json.loads(inst['PASS_TO_PASS'])
    f2p_ok = [t for t in f2p if passed(status.get(t, 'MISSING'))]
    p2p_ok = [t for t in p2p if passed(status.get(t, 'MISSING'))]
    return {
        'resolved': len(f2p_ok) == len(f2p) and len(p2p_ok) == len(p2p),
        'f2p': [len(f2p_ok), len(f2p)],
        'p2p': [len(p2p_ok), len(p2p)],
        'f2p_failed': [t for t in f2p if t not in f2p_ok][:10],
        'p2p_failed': [t for t in p2p if t not in p2p_ok][:10],
        'log_tail': log[-1500:] if len(f2p_ok) < len(f2p) and not status else '',
    }

def changed(d):
    sh(['git', 'add', '-A', '-N'], cwd=d, check=False)
    out = sh(['git', 'diff', '--name-only', 'HEAD'], cwd=d, check=False).stdout.split()
    return out

def is_test(f):
    return bool(re.search(r'(^|/)(tests?|testing)(/|$)|(^|/)test_[^/]*\.py$|_tests?\.py$', f)) and f.endswith('.py')

def to_directive(inst, f):
    if inst['repo'] == 'django/django':
        f = f[:-3] if f.endswith('.py') else f
        f = f[len('tests/'):] if f.startswith('tests/') else f
        return f.replace('/', '.')
    return f

def gate(inst, d, base=None):
    """What wisp itself can check without the hidden tests: the existing tests near the change keep
    passing (visible = the pre-existing versions of the test files the task touches) and the tests
    the agent added or edited pass."""
    d = Path(d)
    visible = [f for f in test_files(inst['test_patch']) if f.endswith('.py')]
    agent_tests = [f for f in changed(d) if is_test(f) and (d / f).exists()]
    files = sorted(set(visible) | set(agent_tests))
    files = [f for f in files if (d / f).exists()]
    if inst['repo'] == 'django/django':  # runtests wants modules, not files
        files = [f for f in files if f.startswith('tests/')]
    status, log = run_tests(inst, d, [to_directive(inst, f) for f in files])
    base = base or {}
    regress = [t for t, st in status.items() if not passed(st) and passed(base.get(t, '')) ]
    new_fail = [t for t, st in status.items() if not passed(st) and t not in base and st != 'SKIPPED']
    ran = len(status)
    ok = ran > 0 and not regress and not new_fail
    return {'pass': ok, 'ran': ran, 'regressions': regress[:10], 'new_failures': new_fail[:10], 'agent_tests': agent_tests,
            'output': '' if ok else '\n'.join(l for l in log.splitlines() if re.search(r'FAIL|Error|error|assert', l))[-3000:] or log[-3000:]}

def select(n):
    """A stratified pick: harder tasks are where harnesses differ, so they get more weight."""
    rs = [r for r in rows().values() if r['repo'] in REPOS and spec(r)['python'] in PY_OK]
    random.seed(7)
    want = {('django/django', '<15 min fix'): 3, ('django/django', '15 min - 1 hour'): 6, ('django/django', '1-4 hours'): 4,
            ('sympy/sympy', '<15 min fix'): 2, ('sympy/sympy', '15 min - 1 hour'): 4, ('sympy/sympy', '1-4 hours'): 3,
            ('pytest-dev/pytest', '<15 min fix'): 2, ('pytest-dev/pytest', '15 min - 1 hour'): 3, ('pytest-dev/pytest', '1-4 hours'): 3}
    pick = []
    for (repo, diff), k in want.items():
        pool = sorted([r['instance_id'] for r in rs if r['repo'] == repo and r['difficulty'] == diff])
        pick += random.sample(pool, min(k, len(pool)))
    pick = pick[:n]
    OUT.mkdir(exist_ok=True)
    (OUT / 'swe-pick.json').write_text(json.dumps(pick, indent=1))
    return pick

def validate(iid):
    inst = rows()[iid]
    d = Path('/tmp/wb/validate') / iid
    try:
        prepare(iid, d)
        status_base, _ = run_tests(inst, d, [to_directive(inst, f) for f in test_files(inst['test_patch']) if f.endswith('.py') and (d / f).exists() and (inst['repo'] != 'django/django' or f.startswith('tests/'))])
        before = grade(inst, d)
        if not apply(d, inst['patch']):
            return {'id': iid, 'ok': False, 'why': 'gold patch did not apply'}
        gold = grade(inst, d)
        ok = before['f2p'][0] < before['f2p'][1] and gold['resolved']
        return {'id': iid, 'ok': ok, 'before': before['f2p'], 'gold': gold['f2p'], 'gold_p2p': gold['p2p'], 'base_status': status_base,
                'why': '' if ok else ('F2P already passing' if before['f2p'][0] == before['f2p'][1] else f"gold not resolved: {gold['f2p_failed'][:3]} {gold['p2p_failed'][:3]} {gold['log_tail'][-400:]}")}
    except Exception as e:
        return {'id': iid, 'ok': False, 'why': f'{type(e).__name__}: {str(e)[:600]}'}
    finally:
        shutil.rmtree(d, ignore_errors=True)

if __name__ == '__main__':
    cmd, *a = sys.argv[1:]
    if cmd == 'select':
        print(json.dumps(select(int(a[0]))))
    elif cmd == 'prepare':
        prepare(a[0], a[1]); print(json.dumps({'ok': True}))
    elif cmd == 'validate':
        print(json.dumps(validate(a[0])))
    elif cmd == 'hidden':
        print(json.dumps(grade(rows()[a[0]], a[1])))
    elif cmd == 'gate':
        base = json.loads(Path(a[2]).read_text()) if len(a) > 2 else None
        print(json.dumps(gate(rows()[a[0]], a[1], base)))
    elif cmd == 'problem':
        print(rows()[a[0]]['problem_statement'])
