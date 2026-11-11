//! A member's answers under the message that asked them (v1 crew.js `replyIn`, `turn.btw` with `crew`): kept on
//! the asking turn in crew's own ext slot (`{"answers": [...]}`). A reply to an answer threads right after it (after
//! the thread's last entry), so the conversation reads in order, and carries on the same job.

use serde_json::{Value, json};
use wisp_crew_api::CrewAnswer;

/// The answers kept on a turn (its `ext["wisp.crew"]`); nothing there reads as none.
pub fn answers_of(slot: Option<&Value>) -> Vec<CrewAnswer> {
    slot.and_then(|v| v.get("answers")).and_then(|a| serde_json::from_value(a.clone()).ok()).unwrap_or_default()
}

/// The turn's slot with `answers` in it (other keys in the slot kept).
pub fn slot_with(slot: Option<&Value>, answers: &[CrewAnswer]) -> Value {
    let mut out = slot.filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
    if let Some(m) = out.as_object_mut() {
        m.insert("answers".into(), serde_json::to_value(answers).unwrap_or_else(|_| json!([])));
    }
    out
}

/// Where `entry` is, among a task's turns (`(turn id, its crew slot)`, in order): the turn's id and the entry.
pub fn find<'a>(turns: impl IntoIterator<Item = (&'a str, Option<&'a Value>)>, entry: &str) -> Option<(String, CrewAnswer)> {
    turns.into_iter().find_map(|(t, slot)| answers_of(slot).into_iter().find(|a| a.id == entry).map(|a| (t.to_owned(), a)))
}

/// A reply to `parent`: a new entry on the same job and thread, put right after the thread's last entry.
/// `None` when `parent` isn't on the list.
pub fn thread_reply(list: &mut Vec<CrewAnswer>, parent: &str, id: String, question: String, at: i64) -> Option<CrewAnswer> {
    let p = list.iter().position(|a| a.id == parent)?;
    let parent = list[p].clone();
    let thread = parent.thread.clone().unwrap_or_else(|| parent.id.clone());
    let entry = CrewAnswer { id, crew: parent.crew, member: parent.member, job: parent.job, question, answer: String::new(), status: "running".into(), thread: Some(thread.clone()), asked_at: at, answered_at: None };
    let mut at_i = p;
    while list.get(at_i + 1).is_some_and(|a| a.thread.as_deref() == Some(thread.as_str())) {
        at_i += 1;
    }
    list.insert(at_i + 1, entry.clone());
    Some(entry)
}

/// The job behind `entry` started: it's the one answering (and the one a reply carries on).
pub fn started(list: &mut [CrewAnswer], entry: &str, job: &str) -> bool {
    list.iter_mut().find(|a| a.id == entry).is_some_and(|a| {
        a.job = Some(job.to_owned());
        true
    })
}

/// The job reported: its text is the answer (`failed`: what went wrong). An entry already answered keeps its answer
/// (a durable event delivered twice settles it once).
pub fn settle(list: &mut [CrewAnswer], entry: &str, text: &str, failed: bool, at: i64) -> bool {
    let Some(a) = list.iter_mut().find(|a| a.id == entry) else { return false };
    if a.status != "running" {
        return false;
    }
    text.trim().clone_into(&mut a.answer);
    a.status = if failed { "error" } else { "done" }.into();
    a.answered_at = Some(at);
    true
}

/// What a job answered, for under the question: its words ahead of the `wisp` fenced block (never the block's JSON), or,
/// when it wrote nothing else, its hero's title and summary.
pub fn answer_text(text: &str, presentation: &Value) -> String {
    let prose = text.split("```wisp").next().unwrap_or_default().trim();
    if !prose.is_empty() {
        return prose.to_owned();
    }
    let hero = presentation.get("blocks").and_then(Value::as_array).and_then(|b| b.iter().find(|x| x.get("type").and_then(Value::as_str) == Some("hero")));
    let s = |k: &str| hero.and_then(|h| h.get(k)).and_then(Value::as_str).unwrap_or_default().trim();
    match (s("title"), s("summary")) {
        ("", "") => String::new(),
        (t, "") => t.to_owned(),
        ("", m) => m.to_owned(),
        (t, m) => format!("**{t}**\n\n{m}"),
    }
}

/// What the member's job is asked: the question, and where it was asked.
pub fn ask_prompt(task_title: &str, question: &str) -> String {
    let title = task_title.trim();
    if title.is_empty() { format!("You were asked in a task:\n\n{}", question.trim()) } else { format!("You were asked in the task “{title}”:\n\n{}", question.trim()) }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn asked(id: &str, thread: Option<&str>) -> CrewAnswer {
        CrewAnswer { id: id.into(), crew: "ada".into(), member: "Ada".into(), job: Some("job1".into()), question: "q".into(), status: "done".into(), thread: thread.map(str::to_owned), ..CrewAnswer::default() }
    }

    /// v1 crew.test.js "you reply in the thread": the reply sits right after the answer (after any earlier replies in
    /// that thread, before the next member's answer), on the same job; a settled answer isn't overwritten.
    #[test]
    fn a_reply_to_a_members_answer_lands_right_under_its_thread_and_carries_on_the_same_job() {
        let mut list = vec![asked("a1", None), asked("a2", Some("a1")), asked("b1", None)];
        let r = thread_reply(&mut list, "a1", "r1".into(), "and the docs?".into(), 5).unwrap();
        assert_eq!((r.thread.as_deref(), r.job.as_deref(), r.status.as_str()), (Some("a1"), Some("job1"), "running"));
        assert_eq!(list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a1", "a2", "r1", "b1"]);
        // replying to a reply stays in the first entry's thread
        let r2 = thread_reply(&mut list, "r1", "r2".into(), "and tests?".into(), 6).unwrap();
        assert_eq!(r2.thread.as_deref(), Some("a1"));
        assert_eq!(list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a1", "a2", "r1", "r2", "b1"]);
        assert!(thread_reply(&mut list, "nope", "x".into(), "x".into(), 7).is_none());
        // the job's report settles it once
        assert!(settle(&mut list, "r1", " done, docs too ", false, 9));
        assert!(!settle(&mut list, "r1", "again", true, 10));
        let r1 = list.iter().find(|a| a.id == "r1").unwrap();
        assert_eq!((r1.answer.as_str(), r1.status.as_str(), r1.answered_at), ("done, docs too", "done", Some(9)));
        // kept in the turn's slot next to whatever else crew keeps there, and read back
        let slot = slot_with(Some(&json!({ "other": 1 })), &list);
        assert_eq!(slot["other"], 1);
        assert_eq!(answers_of(Some(&slot)), list);
        let found = find([("t0", None), ("t1", Some(&slot))], "r2").unwrap();
        assert_eq!((found.0.as_str(), found.1.question.as_str()), ("t1", "and tests?"));
        assert_eq!(answers_of(None), Vec::<CrewAnswer>::new());
        // what lands under the question is the job's words, never its wisp block
        let block = json!({ "blocks": [{ "type": "hero", "title": "Ready", "summary": "Tests pass." }] });
        assert_eq!(answer_text("All done.\n\n```wisp\n{\"blocks\":[]}\n```", &block), "All done.");
        assert_eq!(answer_text("```wisp\n{}\n```", &block), "**Ready**\n\nTests pass.");
        assert_eq!(answer_text("", &json!({})), "");
    }
}
