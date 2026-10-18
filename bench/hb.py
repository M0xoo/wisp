"""Harness-Bench (Qihoo360/harness-bench) tasks, run natively without Docker, graded with the suite's own
hidden oracles (safe_score_workspace + score_workspace_from_cases, as docker/grader/grade_entrypoint.py does).

  python hb.py select N        -> bench/out/hb-pick.json
  python hb.py prepare ID DEST -> copy the workspace, run the task's prepare script, snapshot a manifest
  python hb.py validate ID     -> the oracle runs and an untouched workspace does not pass
  python hb.py hidden ID DIR   -> oracle score for DIR
  python hb.py gate ID DIR     -> no visible tests here: wisp has nothing to run (pass = null)
"""
import importlib.util, json, os, random, shutil, subprocess, sys, collections
from pathlib import Path
import yaml
from harnessbench.grading.outcome_cases import score_workspace_from_cases
from harnessbench.grading.oracle_contract import safe_score_workspace, workspace_manifest, workspace_mutation_report, STRUCTURAL_POLICY_CASE_OWNED

ROOT = Path.home() / '.wisp-bench-private' / 'harness-bench'
HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
TOOLS_OK = {'python3', 'git', 'sqlite3', 'sha256', 'pytest'}

def meta(iid):
    return yaml.safe_load((ROOT / 'tasks' / iid / 'task.yaml').read_text())

def manifest_path(dest):
    return Path(dest).parent / 'hb-manifest.json'  # outside the workspace the agent edits

def prepare(iid, dest):
    m = meta(iid)
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'tasks' / iid / m.get('workspace_dir', 'workspace'), dest, symlinks=True)
    env = m.get('environment') or {}
    if env.get('prepare'):
        runtime = dest.parent / 'hb-runtime'
        runtime.mkdir(exist_ok=True)
        e = dict(os.environ, HB_WORKSPACE=str(dest), HB_RUNTIME=str(runtime), HOME=str(runtime))
        p = subprocess.run([sys.executable, str(ROOT / 'tasks' / iid / 'environment' / env['prepare'])], cwd=dest, env=e, capture_output=True, text=True, timeout=600)
        if p.returncode:
            raise RuntimeError(f'prepare failed: {p.stderr[-800:]}')
    manifest_path(dest).write_text(json.dumps(workspace_manifest(dest)))
    return m

def instruction(iid):
    m = meta(iid)
    return (ROOT / 'tasks' / iid / m.get('prompt_file', 'instruction.md')).read_text()

def load_module(path):
    spec = importlib.util.spec_from_file_location('hidden_oracle', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def grade(iid, d):
    m = meta(iid)
    d = Path(d)
    tdir = ROOT / 'tasks' / iid
    mod = load_module(tdir / m['outcome_test'])
    manifest = yaml.safe_load((tdir / m.get('cases_file', 'tests/cases.yaml')).read_text())
    before = json.loads(manifest_path(d).read_text())
    mutation = workspace_mutation_report(before, workspace_manifest(d), contract=m.get('mutation_contract'))
    r = safe_score_workspace(
        lambda w: score_workspace_from_cases(w, manifest=manifest, evaluate_cases=mod.evaluate_cases, task_id=iid),
        workspace=d, required_artifacts=m.get('required_artifacts') or [], task_id=iid,
        workspace_mutation=mutation, require_task_success=True, structural_policy=STRUCTURAL_POLICY_CASE_OWNED)
    return {'resolved': bool(r.get('task_success')), 'score': round(float(r.get('outcome_score') or 0), 3),
            'weighted': round(float(r.get('weighted_score') or 0), 3), 'failed_core': r.get('failed_core_cases'), 'failed_gates': r.get('failed_gates'),
            'safety_failed': bool(r.get('safety_gate_failed'))}

def select(n):
    rows = []
    for f in sorted((ROOT / 'tasks').glob('*/task.yaml')):
        y = yaml.safe_load(f.read_text())
        tools = set(((y.get('environment') or {}).get('required_tools') or {}).keys())
        if not y.get('outcome_test') or 'semantic_judge' in y or y.get('semantic_judge') or not tools <= TOOLS_OK:
            continue
        if (f.parent / 'tests' / 'ground_truth' / 'semantic_judge.yaml').exists():
            continue
        rows.append((y['task_id'], y['task_category']))
    random.seed(11)
    want = {'Software Engineering': 12, 'Systems Engineering': 6, 'Research and Analysis': 3, 'Business Operations': 3}
    pick = []
    for cat, k in want.items():
        pool = sorted(i for i, c in rows if c == cat)
        pick += random.sample(pool, min(k, len(pool)))
    OUT.mkdir(exist_ok=True)
    (OUT / 'hb-pick.json').write_text(json.dumps(pick[:n], indent=1))
    return pick[:n], collections.Counter(c for _, c in rows)

def validate(iid):
    d = Path('/tmp/wb/validate-hb') / iid / 'work'
    try:
        prepare(iid, d)
        g = grade(iid, d)
        return {'id': iid, 'ok': not g['resolved'], 'untouched': g, 'category': meta(iid)['task_category'], 'difficulty': meta(iid).get('difficulty'), 'why': '' if not g['resolved'] else 'untouched workspace already passes'}
    except Exception as e:
        return {'id': iid, 'ok': False, 'why': f'{type(e).__name__}: {str(e)[:500]}'}
    finally:
        shutil.rmtree(d.parent, ignore_errors=True)

if __name__ == '__main__':
    cmd, *a = sys.argv[1:]
    if cmd == 'select':
        print(json.dumps(select(int(a[0]))))
    elif cmd == 'prepare':
        prepare(a[0], a[1]); print(json.dumps({'ok': True}))
    elif cmd == 'validate':
        print(json.dumps(validate(a[0])))
    elif cmd == 'hidden':
        try:
            print(json.dumps(grade(a[0], a[1])))
        except Exception as e:
            print(json.dumps({'resolved': False, 'error': f'{type(e).__name__}: {str(e)[:500]}'}))
    elif cmd == 'gate':
        print(json.dumps({'pass': None, 'ran': 0, 'note': 'no visible tests for this task'}))
    elif cmd == 'problem':
        print(instruction(a[0]))
