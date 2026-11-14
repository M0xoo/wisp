//! wisp-workflows-core: the workflow runner's decisions, without IO (ADR-0028).
//!
//! - [`check`]: names that don't exist, cycles, bad expressions.
//! - [`expand`]: a matrix step becomes one node per combination (`audit[agent=codex]`).
//! - [`Run::next`]: what starts now (needs met, `if` true, under the concurrency and the budget), what is
//!   skipped, and whether the run is over. The host makes the tasks and reports how each ended.
//! - [`output_of`]: a step's result from its answer: an `output` block's value, else the hero's status
//!   with the answer's stats and text.
//!
//! size-ok: one runner's decisions with their tests (the scheduler, checks, expansion and outputs)

/// The expressions live in the api crate (pure), so other plugins evaluate `if:` the same way (ADR-0043).
pub use wisp_workflows_api::expr;

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use wisp_workflows_api::{StepSpec, StepState, WorkflowSpec};

/// One task to run: a step, or one combination of its matrix.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    /// `audit` or `audit[agent=codex]`
    pub id: String,
    /// the step it comes from
    pub step: String,
    pub matrix: Map<String, Value>,
    pub spec: StepSpec,
}

/// What's wrong with a workflow, one line each.
pub fn check(w: &WorkflowSpec) -> Vec<String> {
    let mut out = Vec::new();
    if w.tasks.is_empty() {
        out.push("a workflow needs tasks".to_owned());
    }
    for (name, s) in &w.tasks {
        if s.prompt.trim().is_empty() {
            out.push(format!("tasks.{name}: needs a prompt"));
        }
        for n in &s.needs {
            if !w.tasks.contains_key(n) {
                out.push(format!("tasks.{name}.needs: no task named {n}"));
            }
            if n == name {
                out.push(format!("tasks.{name}.needs: a task can't need itself"));
            }
        }
        let mut texts: Vec<String> = vec![s.when.clone()];
        texts.extend(expr::exprs(&s.prompt));
        texts.extend(s.steps.iter().flat_map(|x| expr::exprs(x)));
        for e in texts.iter().filter(|e| !e.trim().is_empty()) {
            if let Err(why) = expr::eval(e, &json!({})) {
                out.push(format!("tasks.{name}: {why}"));
            }
            for p in expr::paths(e) {
                let mut parts = p.split('.');
                match (parts.next(), parts.next()) {
                    (Some("tasks"), Some(t)) if !w.tasks.contains_key(t) => out.push(format!("tasks.{name}: `{p}` names no task")),
                    (Some("tasks"), Some(t)) if !s.needs.iter().any(|n| n == t) && !depends(w, name, t) => {
                        out.push(format!("tasks.{name}: reads tasks.{t} but doesn't need it (add needs: [{t}])"));
                    }
                    (Some("inputs"), Some(i)) if !w.inputs.contains_key(i) => out.push(format!("tasks.{name}: `{p}` names no input")),
                    (Some("matrix"), Some(m)) if !s.matrix.contains_key(m) => out.push(format!("tasks.{name}: `{p}` isn't in its matrix")),
                    (Some("tasks" | "inputs" | "matrix"), _) => {}
                    _ => out.push(format!("tasks.{name}: `{p}` reads nothing (tasks., inputs. or matrix.)")),
                }
            }
        }
    }
    if let Some(cycle) = cycle(w) {
        out.push(format!("these tasks need each other: {}", cycle.join(" → ")));
    }
    out
}

/// Whether `a` (transitively) needs `b`.
fn depends(w: &WorkflowSpec, a: &str, b: &str) -> bool {
    let mut stack = vec![a.to_owned()];
    let mut seen = Vec::new();
    while let Some(x) = stack.pop() {
        if seen.contains(&x) {
            continue;
        }
        if let Some(s) = w.tasks.get(&x) {
            for n in &s.needs {
                if n == b {
                    return true;
                }
                stack.push(n.clone());
            }
        }
        seen.push(x);
    }
    false
}

fn cycle(w: &WorkflowSpec) -> Option<Vec<String>> {
    w.tasks.keys().find(|k| depends(w, k, k)).map(|k| {
        let mut path = vec![k.clone()];
        let mut cur = k.clone();
        for _ in 0..w.tasks.len() {
            let Some(next) = w.tasks.get(&cur).and_then(|s| s.needs.iter().find(|n| depends(w, n, k) || *n == k)).cloned() else { break };
            path.push(next.clone());
            if next == *k {
                break;
            }
            cur = next;
        }
        path
    })
}

/// Every node: a step, or one per combination of its matrix (keys in order).
pub fn expand(w: &WorkflowSpec) -> Vec<Node> {
    let mut out = Vec::new();
    for (name, s) in &w.tasks {
        let mut combos: Vec<Map<String, Value>> = vec![Map::new()];
        for (k, vals) in &s.matrix {
            combos = combos
                .into_iter()
                .flat_map(|c| {
                    vals.iter().map(move |v| {
                        let mut c = c.clone();
                        c.insert(k.clone(), v.clone());
                        c
                    })
                })
                .collect();
        }
        for m in combos {
            let id = if m.is_empty() {
                name.clone()
            } else {
                format!(
                    "{name}[{}]",
                    m.iter()
                        .map(|(k, v)| format!("{k}={}", v.as_str().map_or_else(|| v.to_string(), str::to_owned)))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            let mut spec = s.clone();
            // a matrix key that is a spec field sets it (`agent: [claude, codex]`)
            for (k, v) in &m {
                if let Some(t) = v.as_str() {
                    match k.as_str() {
                        "agent" => t.clone_into(&mut spec.agent),
                        "model" => t.clone_into(&mut spec.model),
                        "effort" => t.clone_into(&mut spec.effort),
                        "mode" => t.clone_into(&mut spec.mode),
                        "on" => t.clone_into(&mut spec.on),
                        _ => {}
                    }
                }
            }
            out.push(Node { id, step: name.clone(), matrix: m, spec });
        }
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeRun {
    pub state: StepState,
    pub task: Option<String>,
    pub attempts: u32,
    pub output: Value,
    pub started_at: Option<i64>,
    pub why: String,
    pub cost: f64,
}

/// What the host does next.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// make the task: its args (prompt and steps filled in)
    Start { node: String, prompt: String, steps: Vec<String> },
    /// stop its task: it ran past its timeout
    Stop { node: String, task: String },
}

/// A run of a workflow: each node's state.
#[derive(Debug, Clone)]
pub struct Run {
    pub spec: WorkflowSpec,
    pub inputs: Map<String, Value>,
    pub nodes: Vec<Node>,
    pub runs: BTreeMap<String, NodeRun>,
}

impl Run {
    pub fn new(spec: WorkflowSpec, given: &BTreeMap<String, Value>) -> Self {
        let mut inputs: Map<String, Value> = spec.inputs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (k, v) in given {
            inputs.insert(k.clone(), v.clone());
        }
        let nodes = expand(&spec);
        let runs = nodes.iter().map(|n| (n.id.clone(), NodeRun::default())).collect();
        Self { spec, inputs, nodes, runs }
    }

    /// What expressions read: `tasks.<step>` (a matrix step's output is the list of its runs'),
    /// `inputs`, and the node's own `matrix`.
    pub fn scope(&self, node: &Node) -> Value {
        let mut tasks = Map::new();
        for step in self.spec.tasks.keys() {
            let mine: Vec<(&Node, &NodeRun)> =
                self.nodes.iter().filter(|n| &n.step == step).filter_map(|n| self.runs.get(&n.id).map(|r| (n, r))).collect();
            let state_of = |r: &NodeRun| serde_json::to_value(r.state).unwrap_or_default();
            let v = if mine.len() == 1 && mine[0].0.matrix.is_empty() {
                json!({ "state": state_of(mine[0].1), "output": mine[0].1.output, "task": mine[0].1.task })
            } else {
                let all_done = mine.iter().all(|(_, r)| r.state == StepState::Done);
                json!({ "state": if all_done { "done" } else { "failed" }, "output": mine.iter().map(|(n, r)| json!({ "matrix": n.matrix, "state": state_of(r), "output": r.output })).collect::<Vec<_>>() })
            };
            tasks.insert(step.clone(), v);
        }
        json!({ "tasks": tasks, "inputs": self.inputs, "matrix": node.matrix })
    }

    fn ended(s: StepState) -> bool {
        matches!(s, StepState::Done | StepState::Failed | StepState::Skipped)
    }

    pub fn over(&self) -> bool {
        self.runs.values().all(|r| Self::ended(r.state))
    }

    /// done: every step that had to succeed did.
    pub fn ok(&self) -> bool {
        self.nodes.iter().all(|n| self.runs.get(&n.id).is_some_and(|r| r.state != StepState::Failed || n.spec.optional))
    }

    pub fn cost(&self) -> f64 {
        self.runs.values().map(|r| r.cost).sum()
    }

    fn budget(&self) -> Option<f64> {
        self.spec.budget.as_ref().and_then(|b| b.get("usd")).and_then(Value::as_f64)
    }

    /// What to start or stop now (`now` in ms, for timeouts). Nodes whose `if` is false, whose needs
    /// failed or that the budget leaves out are marked skipped here.
    pub fn next(&mut self, now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        for n in &self.nodes {
            let r = &self.runs[&n.id];
            if let (StepState::Running, Some(at), Some(min), Some(task)) = (r.state, r.started_at, n.spec.timeout, r.task.clone())
                && now - at > i64::try_from(min).unwrap_or(i64::MAX).saturating_mul(60_000)
            {
                out.push(Action::Stop { node: n.id.clone(), task });
            }
        }
        let limit = if self.spec.concurrency == 0 { usize::MAX } else { self.spec.concurrency as usize };
        loop {
            let mut changed = false;
            for i in 0..self.nodes.len() {
                let n = self.nodes[i].clone();
                if self.runs[&n.id].state != StepState::Waiting {
                    continue;
                }
                let needs: Vec<&NodeRun> =
                    self.nodes.iter().filter(|m| n.spec.needs.contains(&m.step)).map(|m| &self.runs[&m.id]).collect();
                if !needs.iter().all(|r| Self::ended(r.state)) {
                    continue;
                }
                let failed = self
                    .nodes
                    .iter()
                    .any(|m| n.spec.needs.contains(&m.step) && self.runs[&m.id].state == StepState::Failed && !m.spec.optional);
                let scope = self.scope(&n);
                let skip = if failed {
                    Some("a task it needs failed".to_owned())
                } else if !n.spec.when.trim().is_empty() && !expr::eval(&n.spec.when, &scope).is_ok_and(|v| expr::truthy(&v)) {
                    Some(format!("if: {} was false", n.spec.when.trim()))
                } else if self.budget().is_some_and(|b| self.cost() >= b) {
                    Some(format!("the run's budget (${:.2}) is spent", self.budget().unwrap_or(0.0)))
                } else {
                    None
                };
                if let Some(why) = skip {
                    let Some(r) = self.runs.get_mut(&n.id) else { continue };
                    r.state = StepState::Skipped;
                    r.why = why;
                    changed = true;
                    continue;
                }
                let running = self.runs.values().filter(|r| r.state == StepState::Running).count();
                if running >= limit {
                    continue;
                }
                match (
                    expr::interpolate(&n.spec.prompt, &scope),
                    n.spec.steps.iter().map(|s| expr::interpolate(s, &scope)).collect::<Result<Vec<_>, _>>(),
                ) {
                    (Ok(prompt), Ok(steps)) => {
                        let Some(r) = self.runs.get_mut(&n.id) else { continue };
                        r.state = StepState::Running;
                        r.attempts += 1;
                        r.started_at = Some(now);
                        out.push(Action::Start { node: n.id.clone(), prompt, steps });
                    }
                    (Err(e), _) | (_, Err(e)) => {
                        let Some(r) = self.runs.get_mut(&n.id) else { continue };
                        r.state = StepState::Failed;
                        r.why = e;
                    }
                }
                changed = true;
            }
            if !changed {
                break;
            }
        }
        out
    }

    /// The host made the node's task.
    pub fn started(&mut self, node: &str, task: &str) {
        if let Some(r) = self.runs.get_mut(node) {
            r.task = Some(task.to_owned());
        }
    }

    /// The node's task ended: done with its output, or failed (tried again while it has retries).
    pub fn finished(&mut self, node: &str, ok: bool, output: Value, why: &str, cost: f64) {
        let retries = self.nodes.iter().find(|n| n.id == node).map_or(0, |n| n.spec.retries);
        if let Some(r) = self.runs.get_mut(node) {
            r.cost += cost;
            r.output = output;
            if ok {
                r.state = StepState::Done;
            } else if r.attempts <= retries {
                r.state = StepState::Waiting;
                r.task = None;
                r.why = format!("try {} failed: {why}", r.attempts);
            } else {
                r.state = StepState::Failed;
                why.clone_into(&mut r.why);
            }
        }
    }

    /// Each node's state, for the parent task (`ext["wisp.workflows"].steps`).
    pub fn report(&self) -> Value {
        Value::Array(
            self.nodes
                .iter()
                .map(|n| {
                    let r = &self.runs[&n.id];
                    json!({ "id": n.id, "step": n.step, "state": r.state, "task": r.task, "attempts": r.attempts, "why": r.why, "output": r.output })
                })
                .collect(),
        )
    }
}

/// A step's result from its last turn (`Turn` as JSON): an `output` block's value, else what its
/// answer says: the hero's status and title, the stats as numbers, the answer's text.
pub fn output_of(turn: &Value) -> Value {
    let blocks = turn.pointer("/presentation/blocks").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(o) = blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("output")) {
        return o.get("value").or_else(|| o.get("data")).cloned().unwrap_or(Value::Null);
    }
    let mut out = Map::new();
    if let Some(h) = blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("hero")) {
        for k in ["status", "title", "summary"] {
            if let Some(v) = h.get(k) {
                out.insert(k.into(), v.clone());
            }
        }
    }
    for b in blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("stats")) {
        for i in b.get("items").and_then(Value::as_array).into_iter().flatten() {
            if let Some(l) = i.get("label").and_then(Value::as_str) {
                out.insert(l.replace(' ', "_"), i.get("value").cloned().unwrap_or(Value::Null));
            }
        }
    }
    if let Some(t) = blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("tests")) {
        for k in ["passed", "failed", "skipped"] {
            if let Some(v) = t.get(k) {
                out.insert(k.into(), v.clone());
            }
        }
        if let Some(f) = t.get("failures") {
            out.insert("failures".into(), f.clone());
        }
    }
    if let Some(t) = turn.get("text").and_then(Value::as_str) {
        out.insert("text".into(), json!(t));
    }
    Value::Object(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn step(prompt: &str, needs: &[&str]) -> StepSpec {
        StepSpec { prompt: prompt.into(), needs: needs.iter().map(|s| (*s).to_owned()).collect(), ..StepSpec::default() }
    }

    fn wf(steps: Vec<(&str, StepSpec)>) -> WorkflowSpec {
        WorkflowSpec { tasks: steps.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(), ..WorkflowSpec::default() }
    }

    fn starts(a: &[Action]) -> Vec<String> {
        a.iter().filter_map(|x| if let Action::Start { node, .. } = x { Some(node.clone()) } else { None }).collect()
    }

    #[test]
    fn checks_names_cycles_and_what_expressions_read() {
        let mut bad = step("Fix ${{ tasks.tests.output.failures }}", &[]);
        bad.when = "${{ inputs.nope }}".into();
        let w = wf(vec![("a", step("x", &["b"])), ("b", step("y", &["a"])), ("fix", bad), ("c", step("z", &["ghost"]))]);
        let got = check(&w);
        assert!(got.iter().any(|p| p.contains("need each other")), "{got:?}");
        assert!(got.iter().any(|p| p == "tasks.c.needs: no task named ghost"), "{got:?}");
        assert!(got.iter().any(|p| p.contains("names no task")), "{got:?}");
        assert!(got.iter().any(|p| p.contains("`inputs.nope` names no input")), "{got:?}");
        assert_eq!(check(&wf(vec![("t", step("x", &[])), ("f", step("fix ${{ tasks.t.output.text }}", &["t"]))])), Vec::<String>::new());
    }

    #[test]
    fn a_three_step_run_with_a_condition_and_a_matrix() {
        let mut fix = step("Fix: ${{ tasks.tests.output.failures }}", &["tests"]);
        fix.when = "${{ tasks.tests.output.failed > 0 }}".into();
        let mut audit = step("Audit on ${{ matrix.agent }}", &["tests"]);
        audit.matrix.insert("agent".into(), vec![json!("claude"), json!("codex")]);
        let report = step("Report: ${{ tasks.audit.output }}", &["fix", "audit"]);
        let w = WorkflowSpec {
            concurrency: 2,
            ..wf(vec![("tests", step("Run the tests", &[])), ("fix", fix), ("audit", audit), ("report", report)])
        };
        assert_eq!(check(&w), Vec::<String>::new());
        let mut r = Run::new(w, &BTreeMap::new());
        assert_eq!(starts(&r.next(0)), ["tests"]);
        r.started("tests", "T1");
        assert_eq!(r.next(1), Vec::new(), "nothing else is ready");
        r.finished("tests", true, json!({ "failed": 0 }), "", 0.5);
        let a = r.next(2);
        assert_eq!(starts(&a), ["audit[agent=claude]", "audit[agent=codex]"]);
        assert_eq!(r.runs["fix"].state, StepState::Skipped, "failed > 0 is false");
        assert!(a.iter().any(|x| matches!(x, Action::Start { prompt, .. } if prompt == "Audit on codex")));
        assert_eq!(r.nodes.iter().find(|n| n.id == "audit[agent=codex]").unwrap().spec.agent, "codex");
        r.finished("audit[agent=claude]", true, json!({ "status": "done" }), "", 0.0);
        r.finished("audit[agent=codex]", false, Value::Null, "harness failed", 0.0);
        assert_eq!(r.next(3), Vec::new(), "report needs audit, which failed");
        assert_eq!(r.runs["report"].state, StepState::Skipped);
        assert!(r.over() && !r.ok());
    }

    #[test]
    fn retries_timeouts_concurrency_and_budget() {
        let mut flaky = step("x", &[]);
        flaky.retries = 1;
        flaky.timeout = Some(1);
        let w = WorkflowSpec { concurrency: 1, budget: Some(json!({ "usd": 1 })), ..wf(vec![("a", flaky), ("b", step("y", &[]))]) };
        let mut r = Run::new(w, &BTreeMap::new());
        assert_eq!(starts(&r.next(0)), ["a"], "one at a time");
        r.started("a", "T1");
        assert!(matches!(r.next(61_000).as_slice(), [Action::Stop { node, .. }] if node == "a"), "past its timeout");
        r.finished("a", false, Value::Null, "timed out", 0.7);
        assert_eq!(starts(&r.next(62_000)), ["a"], "its retry");
        r.finished("a", true, json!({}), "", 0.4);
        r.next(63_000);
        assert_eq!(r.runs["b"].state, StepState::Skipped, "the budget is spent: {:?}", r.runs["b"]);
    }

    #[test]
    fn outputs_come_from_the_answer() {
        let t = json!({ "text": "ok", "presentation": { "blocks": [{ "type": "hero", "status": "done", "title": "Tests" }, { "type": "tests", "passed": 4, "failed": 1, "failures": [{ "name": "x" }] }] } });
        assert_eq!(
            output_of(&t),
            json!({ "status": "done", "title": "Tests", "passed": 4, "failed": 1, "failures": [{ "name": "x" }], "text": "ok" })
        );
        let o = json!({ "presentation": { "blocks": [{ "type": "output", "value": { "n": 3 } }] } });
        assert_eq!(output_of(&o), json!({ "n": 3 }));
    }
}
