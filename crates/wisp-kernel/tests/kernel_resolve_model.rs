//! Resolution as a model (plan §6.4, §6.11.2 rule 8): random plugin sets, checked against invariants
//! and against a simple reference model of who must be refused.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names
)]
mod common;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Value, json};
use wisp_kernel::Manifest;
use wisp_kernel::resolve::{Input, resolve};

/// xorshift: deterministic, no dependency
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct World {
    manifests: Vec<Manifest>,
    off: HashMap<String, String>,
    /// id → (hard deps, optional deps)
    deps: BTreeMap<String, (Vec<String>, Vec<String>)>,
}

fn world(seed: u64) -> World {
    let mut r = Rng(seed.wrapping_mul(2_654_435_761) | 1);
    let n = 3 + r.below(9);
    let ids: Vec<String> = (0..n).map(|i| format!("acme.p{i}")).collect();
    let mut manifests = Vec::new();
    let mut deps = BTreeMap::new();
    for id in &ids {
        let mut req = Map::new();
        let (mut hard, mut soft) = (Vec::new(), Vec::new());
        for _ in 0..r.below(3) {
            // mostly existing plugins, sometimes a missing one; cycles happen
            let t = if r.below(8) == 0 {
                "acme.ghost".to_owned()
            } else {
                ids[usize::try_from(r.below(n)).unwrap()].clone()
            };
            if t == *id || req.contains_key(&t) {
                continue;
            }
            if r.below(4) == 0 {
                req.insert(t.clone(), json!({ "version": "^1", "optional": true }));
                soft.push(t);
            } else {
                req.insert(t.clone(), json!("^1"));
                hard.push(t);
            }
        }
        manifests.push(common::manifest(
            id,
            json!({ "requires": Value::Object(req) }),
        ));
        deps.insert(id.clone(), (hard, soft));
    }
    let off = ids
        .iter()
        .filter(|_| r.below(6) == 0)
        .map(|id| (id.clone(), format!("{id} was switched off")))
        .collect();
    World {
        manifests,
        off,
        deps,
    }
}

/// The reference: a plugin runs iff it isn't off, every hard dep exists and runs, and it isn't on a
/// hard cycle. Computed as a greatest fixpoint, nothing clever.
fn model(w: &World) -> BTreeSet<String> {
    let mut run: BTreeSet<String> = w
        .deps
        .keys()
        .filter(|id| !w.off.contains_key(*id))
        .cloned()
        .collect();
    loop {
        let before = run.len();
        let snapshot = run.clone();
        run.retain(|id| w.deps[id].0.iter().all(|d| snapshot.contains(d)));
        if run.len() == before {
            break;
        }
    }
    // a set closed under hard deps can still hold a cycle: drop every plugin that reaches itself
    let reaches_self = |start: &String| {
        let mut seen = BTreeSet::new();
        let mut stack: Vec<&String> = w.deps[start].0.iter().collect();
        while let Some(x) = stack.pop() {
            if x == start {
                return true;
            }
            if seen.insert(x.clone()) && run.contains(x) {
                stack.extend(w.deps[x].0.iter());
            }
        }
        false
    };
    let cyclic: BTreeSet<String> = run.iter().filter(|id| reaches_self(id)).cloned().collect();
    let mut run: BTreeSet<String> = run.difference(&cyclic).cloned().collect();
    loop {
        let before = run.len();
        let snapshot = run.clone();
        run.retain(|id| w.deps[id].0.iter().all(|d| snapshot.contains(d)));
        if run.len() == before {
            return run;
        }
    }
}

#[test]
fn random_sets_match_the_model_and_keep_the_invariants() {
    for seed in 1..=400 {
        let w = world(seed);
        let input = Input {
            manifests: w.manifests.iter().collect(),
            off: w.off.clone(),
            ..Input::default()
        };
        let res = resolve(&input);
        let all: BTreeSet<String> = w.deps.keys().cloned().collect();
        let ran: BTreeSet<String> = res.order.iter().cloned().collect();
        let refused: BTreeSet<String> = res.refused.keys().cloned().collect();
        assert_eq!(
            ran.union(&refused).cloned().collect::<BTreeSet<_>>(),
            all,
            "seed {seed}: every plugin runs or is refused"
        );
        assert!(ran.is_disjoint(&refused), "seed {seed}");
        assert_eq!(ran, model(&w), "seed {seed}: refusals match the model");
        // dependencies first, optional ones too when they run
        for (i, id) in res.order.iter().enumerate() {
            for d in &w.deps[id].0 {
                assert!(res.order[..i].contains(d), "seed {seed}: {d} before {id}");
            }
        }
        // every refusal says why, naming what it needs
        for (id, why) in &res.refused {
            let ok = w.off.contains_key(id)
                || why.starts_with("dependency cycle:")
                || why.contains(" requires ");
            assert!(ok, "seed {seed}: {id}: {why}");
        }
        // registration order doesn't change who runs
        let mut rev: Vec<&Manifest> = w.manifests.iter().collect();
        rev.reverse();
        let res2 = resolve(&Input {
            manifests: rev,
            off: w.off.clone(),
            ..Input::default()
        });
        assert_eq!(
            res2.order.iter().cloned().collect::<BTreeSet<_>>(),
            ran,
            "seed {seed}: order-independent"
        );
    }
}

#[test]
fn optional_requirements_order_but_never_refuse() {
    let a = common::manifest(
        "acme.a",
        json!({ "requires": { "acme.b": { "version": "^1", "optional": true }, "acme.ghost": { "version": "^1", "optional": true } } }),
    );
    let b = common::manifest("acme.b", json!({}));
    let res = resolve(&Input {
        manifests: vec![&a, &b],
        ..Input::default()
    });
    assert_eq!(res.order, ["acme.b", "acme.a"]);
    assert!(res.refused.is_empty());
}

#[test]
fn kernel_api_and_exact_reasons() {
    let a = common::manifest("acme.a", json!({ "api": "^2" }));
    let b = common::manifest("acme.b", json!({ "requires": { "acme.a": "^1" } }));
    let c = common::manifest("acme.c", json!({ "requires": { "x.service": "^1" } }));
    let res = resolve(&Input {
        manifests: vec![&a, &b, &c],
        ..Input::default()
    });
    assert_eq!(
        res.refused["acme.a"],
        "acme.a needs kernel api ^2, this kernel is 1.0.0"
    );
    assert!(
        res.refused["acme.b"]
            .starts_with("acme.b requires acme.a, which is refused (acme.a needs kernel api")
    );
    assert_eq!(
        res.refused["acme.c"],
        "acme.c requires x.service, which is missing"
    );
}
