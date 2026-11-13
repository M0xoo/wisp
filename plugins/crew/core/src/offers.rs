//! Kit offers (v1 crew.js `propose`, `settleOffer`): files an agent proposed for a member's kit, kept on the member
//! under the turn that made them until the user adds or dismisses them. Nothing joins the kit here: the user picks,
//! and the kit itself changes through `crew.update`.

use serde_json::Value;
use wisp_crew_api::{Member, OFFER_FILES, OFFERS_MAX, Offer, OfferFile};

use crate::error::{Result, bad};
use crate::kit::offer_file;
use crate::text::clip;

fn same(a: &OfferFile, b: &OfferFile) -> bool {
    a.kind == b.kind && a.name.to_lowercase() == b.name.to_lowercase()
}

/// Files proposed from task `job` in `turn` (v1 `propose`): each checked on its own, refused ones named with why.
/// A second call in the same turn adds to that open offer (the same name replaces); the newest offers stay.
/// `id` is the new offer's, used only when there is no open offer for that turn yet.
pub fn propose(m: &mut Member, job: &str, turn: &str, list: &[Value], id: String, now: i64) -> Result<(Offer, Vec<String>)> {
    let mut files: Vec<OfferFile> = Vec::new();
    let mut refused = Vec::new();
    for x in list.iter().take(OFFER_FILES) {
        match offer_file(x) {
            Ok(f) => {
                files.retain(|y| !same(y, &f));
                files.push(f);
            }
            Err(e) => {
                let name = x.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or("a file");
                refused.push(format!("{name}: {e}"));
            }
        }
    }
    if files.is_empty() {
        return Err(bad(if refused.is_empty() {
            "Give at least one file to propose.".to_owned()
        } else {
            format!("None of those could join {}’s kit. {}", m.name, refused.join(" "))
        }));
    }
    let prev = m.offers.iter().find(|o| o.job == job && o.turn.as_deref() == Some(turn) && o.state == "open");
    let mut merged: Vec<OfferFile> =
        prev.map(|o| o.files.iter().filter(|f| !files.iter().any(|y| same(f, y))).cloned().collect()).unwrap_or_default();
    merged.extend(files);
    let skip = merged.len().saturating_sub(OFFER_FILES);
    let merged: Vec<OfferFile> = merged.into_iter().skip(skip).collect();
    let offer = Offer {
        id: prev.map_or(id, |o| o.id.clone()),
        job: job.to_owned(),
        turn: Some(turn.to_owned()),
        at: now,
        files: merged,
        state: "open".into(),
        names: Vec::new(),
        settled_at: None,
    };
    m.offers.retain(|o| o.id != offer.id);
    m.offers.insert(0, offer.clone());
    m.offers.truncate(OFFERS_MAX);
    Ok((offer, refused))
}

/// The files a job's crew block proposed (v1 `#offer`): an offer under that job, replacing the job's earlier one (a
/// follow-up on the job proposes again). Files that wouldn't pass as kit files are left out; none left, no offer.
pub fn offer_from_job(m: &mut Member, job: &str, list: &[Value], id: String, now: i64) -> Option<Offer> {
    let files = crate::kit::offer_files(list);
    if files.is_empty() {
        return None;
    }
    // the same report again (a durable event replayed after a restart): the offer as you left it, settled or not
    if m.offers.iter().any(|o| o.job == job && o.files == files) {
        return None;
    }
    let offer = Offer { id, job: job.to_owned(), turn: None, at: now, files, state: "open".into(), names: Vec::new(), settled_at: None };
    m.offers.retain(|o| o.job != job);
    m.offers.insert(0, offer.clone());
    m.offers.truncate(OFFERS_MAX);
    Some(offer)
}

/// You added (`taken`, the names added) or dismissed an offer (v1 `settleOffer`). Anything else, or an offer that
/// isn't there, changes nothing; a settled offer can be settled again (Done after adding some through the editor).
pub fn settle(m: &mut Member, id: &str, state: &str, names: &[String], now: i64) -> bool {
    let state = if state == "added" { "taken" } else { state };
    if !matches!(state, "taken" | "dismissed") {
        return false;
    }
    let Some(o) = m.offers.iter_mut().find(|o| o.id == id) else { return false };
    state.clone_into(&mut o.state);
    o.names = names.iter().take(OFFER_FILES).map(|n| clip(n, 64)).collect();
    o.settled_at = Some(now);
    true
}

/// What the agent reads back after proposing (v1 crew-tools.js `wisp_crew_kit`).
pub fn proposed_text(m: &Member, o: &Offer, refused: &[String]) -> String {
    let names: Vec<String> = o.files.iter().map(|f| format!("`{}`", f.name)).collect();
    let mut out = format!(
        "Proposed for {}’s kit: {}. They show under your answer for the user to read and pick; nothing joins the kit until they do.",
        m.name,
        names.join(", ")
    );
    if !refused.is_empty() {
        out.push_str(" Not proposed: ");
        out.push_str(&refused.join(" "));
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ada() -> Member {
        Member { id: "m1".into(), name: "Ada".into(), ..Member::default() }
    }

    #[test]
    fn a_proposed_kit_is_an_open_offer_and_a_second_call_in_the_same_turn_adds_to_it() {
        let mut m = ada();
        let files =
            [json!({ "kind": "skill", "name": "Release Notes", "description": "Writing release notes", "body": "1. Read the log" })];
        let (o, refused) = propose(&mut m, "s1", "t1", &files, "o1".into(), 5).unwrap();
        assert_eq!(refused, Vec::<String>::new());
        assert_eq!((o.id.as_str(), o.state.as_str(), o.files[0].name.as_str()), ("o1", "open", "release-notes"));
        // the same turn: one offer, the new file added, the same name replaced
        let more = [
            json!({ "kind": "rules", "name": "AGENTS.md", "body": "- run tests" }),
            json!({ "kind": "skill", "name": "release-notes", "description": "Notes", "body": "2. Write them" }),
        ];
        let (o2, _) = propose(&mut m, "s1", "t1", &more, "o2".into(), 6).unwrap();
        assert_eq!(o2.id, "o1");
        assert_eq!(m.offers.len(), 1);
        assert_eq!(o2.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["AGENTS.md", "release-notes"]);
        assert_eq!(o2.files[1].body, "2. Write them");
        // the next turn: a new offer, newest first
        propose(&mut m, "s1", "t2", &more, "o3".into(), 7).unwrap();
        assert_eq!(m.offers.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["o3", "o1"]);
    }

    #[test]
    fn a_proposal_with_only_bad_files_is_refused_with_why_and_a_mixed_one_names_what_it_left_out() {
        let mut m = ada();
        let err = propose(&mut m, "s1", "t1", &[json!({ "kind": "skill", "name": "x", "body": "" })], "o1".into(), 1).unwrap_err();
        assert!(err.to_string().contains("None of those could join Ada’s kit"), "{err}");
        assert!(propose(&mut m, "s1", "t1", &[], "o1".into(), 1).unwrap_err().to_string().contains("at least one file"));
        let mixed =
            [json!({ "kind": "rules", "name": "AGENTS.md", "body": "ok" }), json!({ "kind": "skill", "name": "lint", "body": "steps" })];
        let (o, refused) = propose(&mut m, "s1", "t1", &mixed, "o1".into(), 1).unwrap();
        assert_eq!(o.files.len(), 1);
        assert_eq!(refused.len(), 1, "the skill has no When");
        assert!(proposed_text(&m, &o, &refused).contains("Not proposed: lint"));
        assert!(m.offers.len() <= OFFERS_MAX);
    }

    #[test]
    fn a_kit_jobs_crew_block_becomes_an_offer_under_that_job_and_a_follow_up_replaces_it() {
        let mut m = ada();
        let kit =
            [json!({ "kind": "rules", "name": "AGENTS.md", "body": "- run tests" }), json!({ "kind": "skill", "name": "x", "body": "" })];
        let o = offer_from_job(&mut m, "s1", &kit, "o1".into(), 1).unwrap();
        assert_eq!(o.files.len(), 1, "the bad file is left out");
        assert!(offer_from_job(&mut m, "s1", &[json!({ "kind": "skill", "name": "y", "body": "" })], "o2".into(), 2).is_none());
        assert_eq!(m.offers.len(), 1, "nothing to offer leaves the earlier one");
        assert!(settle(&mut m, "o1", "dismissed", &[], 2));
        assert!(offer_from_job(&mut m, "s1", &kit, "o3".into(), 3).is_none(), "the same report replayed: dismissed stays dismissed");
        assert_eq!(m.offers[0].state, "dismissed");
        let follow = [json!({ "kind": "rules", "name": "AGENTS.md", "body": "- run the tests first" })];
        offer_from_job(&mut m, "s1", &follow, "o4".into(), 4).unwrap();
        assert_eq!(m.offers.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["o4"], "the follow-up replaces it");
    }

    #[test]
    fn settling_an_offer_records_what_was_added_or_that_it_was_dismissed() {
        let mut m = ada();
        let (o, _) = propose(&mut m, "s1", "t1", &[json!({ "kind": "rules", "name": "AGENTS.md", "body": "ok" })], "o1".into(), 1).unwrap();
        assert!(!settle(&mut m, &o.id, "open", &[], 2), "only taken or dismissed");
        assert!(!settle(&mut m, "nope", "taken", &[], 2));
        assert!(settle(&mut m, &o.id, "added", &["AGENTS.md".into()], 3));
        assert_eq!(
            (m.offers[0].state.as_str(), m.offers[0].names.clone(), m.offers[0].settled_at),
            ("taken", vec!["AGENTS.md".to_owned()], Some(3))
        );
        assert!(settle(&mut m, &o.id, "dismissed", &[], 4));
        assert_eq!(m.offers[0].state, "dismissed");
    }

    #[test]
    fn at_most_offers_max_offers_stay_newest_first() {
        let mut m = ada();
        let f = [json!({ "kind": "rules", "name": "AGENTS.md", "body": "ok" })];
        for i in 0..(OFFERS_MAX + 3) {
            propose(&mut m, &format!("s{i}"), "t", &f, format!("o{i}"), 1).unwrap();
        }
        assert_eq!(m.offers.len(), OFFERS_MAX);
        assert_eq!(m.offers[0].id, format!("o{}", OFFERS_MAX + 2));
    }
}
