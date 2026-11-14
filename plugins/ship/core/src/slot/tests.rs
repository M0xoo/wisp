use super::*;
use wisp_ship_api::{AttachedPr, PrSummary, Shipping, ToShip};

fn wt(branch: &str) -> Worktree {
    Worktree {
        path: format!("/h/.wisp/worktrees/app-{branch}"),
        root: "/code/app".into(),
        branch: branch.into(),
        base: "main".into(),
        base_ref: "origin/main".into(),
        ..Worktree::default()
    }
}

fn facts(w: Option<Worktree>) -> Facts {
    Facts { session: "s1".into(), cwd: "/code/app".into(), worktree: w, updated_at: 5, ..Facts::default() }
}

fn pr(n: u64, state: &str) -> PrSummary {
    PrSummary {
        number: n,
        url: format!("https://github.com/o/app/pull/{n}"),
        state: state.into(),
        head: "abc".into(),
        ..PrSummary::default()
    }
}

#[test]
fn a_worktree_task_is_followed_and_a_task_in_place_is_not() {
    let t = sync(None, &facts(Some(wt("wisp/fix")))).unwrap();
    assert_eq!(t.repos.len(), 1);
    assert_eq!(t.repos[0].name, "app");
    assert_eq!(t.repos[0].worktree.branch, "wisp/fix");
    assert!(sync(None, &facts(None)).is_none());
}

#[test]
fn the_worktree_slot_from_wisp_worktrees_reads_as_ships_copy() {
    let slot = json!({ "path": "/w/app-1", "cwd": "/w/app-1", "branch": "wisp/a", "base": "main", "baseRef": "origin/main", "root": "/code/app", "createdAt": 3, "kept": true });
    let w = worktree_of(&slot).unwrap();
    assert_eq!((w.base_ref.as_str(), w.root.as_str()), ("origin/main", "/code/app"));
    assert!(worktree_of(&json!({ "kept": true })).is_none(), "a slot with only `kept` is no worktree");
    assert!(worktree_of(&Value::Null).is_none());
}

#[test]
fn the_slot_round_trips_and_carries_the_own_pr_on_top_for_review() {
    let mut t = sync(None, &facts(Some(wt("wisp/fix")))).unwrap();
    t.repos[0].pr = Some(pr(12, "OPEN"));
    t.to_ship = Some(ToShip { dirty: 1, ..ToShip::default() });
    let slot = ext_of(&t);
    assert_eq!(slot["pr"]["head"], "abc");
    assert_eq!(slot["pr"]["state"], "OPEN");
    assert!(slot.get("session").is_none());
    assert_eq!(restore("s1", &slot), Some(t));
    assert_eq!(restore("s1", &Value::Null), None);
}

#[test]
fn a_new_branch_drops_the_old_pr_and_a_move_keeps_it() {
    let mut t = sync(None, &facts(Some(wt("wisp/fix")))).unwrap();
    t.repos[0].pr = Some(pr(12, "MERGED"));
    let mut moved = wt("wisp/fix");
    moved.path = "/elsewhere".into();
    let t2 = sync(Some(t.clone()), &facts(Some(moved))).unwrap();
    assert_eq!(t2.repos[0].pr.as_ref().map(|p| p.number), Some(12));
    assert_eq!(t2.repos[0].worktree.path, "/elsewhere");
    let t3 = sync(Some(t), &facts(Some(wt("wisp/next")))).unwrap();
    assert!(t3.repos[0].pr.is_none());
}

#[test]
fn archived_and_subagent_facts_follow_the_session() {
    let t = sync(None, &facts(Some(wt("b")))).unwrap();
    let f = Facts { archived: true, child: true, ..facts(Some(wt("b"))) };
    let t = sync(Some(t), &f).unwrap();
    assert!(t.archived && t.child);
}

#[test]
fn a_task_with_only_attached_prs_stays_followed_after_its_worktree_goes() {
    let t = ShipTask { session: "s1".into(), prs: vec![AttachedPr { repo: "o/x".into(), pr: pr(3, "OPEN") }], ..ShipTask::default() };
    assert!(sync(Some(t), &facts(None)).is_some());
}

#[test]
fn the_row_gets_pr_also_prs_to_ship_and_shipping_in_the_uis_shapes() {
    let mut t = sync(None, &facts(Some(wt("wisp/fix")))).unwrap();
    t.repos[0].pr = Some(pr(12, "OPEN"));
    let mut api = wt("wisp/fix");
    api.root = "/code/api".into();
    t.repos.push(ShipRepo { name: "api".into(), worktree: api, pr: Some(pr(4, "OPEN")) });
    t.prs.push(AttachedPr { repo: "o/docs".into(), pr: pr(9, "OPEN") });
    t.to_ship = Some(ToShip { dirty: 0, ahead: 2, unpushed: 2, repos: Some(1) });
    t.shipping = Some(Shipping { step: "push".into(), ..Shipping::default() });
    let mut out = BTreeMap::new();
    row_fields(&ext_of(&t), &mut out);
    assert_eq!(out["pr"]["number"], 12);
    assert_eq!(out["also"][0]["project"], "api");
    assert_eq!(out["also"][0]["pr"]["number"], 4);
    assert_eq!(out["prs"][0]["repo"], "o/docs");
    assert_eq!(out["toShip"]["ahead"], 2);
    assert_eq!(out["shipping"]["step"], "push");
    assert!(!out.contains_key("conflictFix"));
}

#[test]
fn an_empty_slot_adds_nothing_to_the_row() {
    let mut out = BTreeMap::new();
    row_fields(&Value::Null, &mut out);
    row_fields(&json!({ "nonsense": 1, "repos": 7 }), &mut out);
    assert!(out.is_empty());
}

#[test]
fn a_review_is_asked_for_when_the_open_prs_head_moves_and_only_then() {
    let at = |state: &str, head: &str| json!({ "pr": { "state": state, "head": head } });
    assert!(new_head(None, &at("OPEN", "a")), "the PR just opened");
    assert!(new_head(Some(&at("OPEN", "a")), &at("OPEN", "b")), "a push moved it");
    assert!(!new_head(Some(&at("OPEN", "a")), &at("OPEN", "a")), "checks changed, not the head");
    assert!(!new_head(Some(&at("OPEN", "a")), &at("MERGED", "a")));
    assert!(!new_head(None, &json!({ "pr": null })));
    assert!(!new_head(None, &at("OPEN", "")));
}

#[test]
fn a_pr_poll_that_found_nothing_new_is_not_a_write() {
    let at = |checked: i64, state: &str| json!({ "pr": { "state": state, "checkedAt": checked }, "repos": [{ "pr": { "state": state, "checkedAt": checked } }] });
    assert!(same_news(&at(1, "OPEN"), &at(2, "OPEN")));
    assert!(!same_news(&at(1, "OPEN"), &at(2, "MERGED")));
}
