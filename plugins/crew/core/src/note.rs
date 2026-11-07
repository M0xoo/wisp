//! What a job hears (v1 crew.js `crewNote`, `checkinPrompt`): who it is, its memory, where this job came
//! from and how to hand memory back. Appended to the job's system prompt.

use std::collections::BTreeMap;

use wisp_crew_api::{CrewExt, JobKind, LINKS_MAX, Member, NOTEBOOK_SOFT, WAKE_MIN};

use crate::cron::{Zone, civil};
use crate::kit::kit_note;

const LOG_IN_PROMPT: usize = 12;
const LINKS_IN_PROMPT: usize = 8;
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "25 Oct, 09:00" (v1 `toLocaleString('en-GB', …)`).
pub fn when(t: i64, zone: &dyn Zone) -> String {
    let c = civil(t + i64::from(zone.offset_min(t)) * 60_000);
    let month = MONTHS.get((c.month as usize).saturating_sub(1)).copied().unwrap_or("");
    format!("{} {month}, {:02}:{:02}", c.day, c.hour, c.minute)
}

fn job_label(j: JobKind) -> &'static str {
    match j {
        JobKind::Checkin => "check-in",
        JobKind::Task => "from the user",
        JobKind::Delegated => "delegated",
        JobKind::Trigger => "trigger",
        JobKind::Mention => "tagged",
        JobKind::Event => "on a task",
    }
}

fn event_what(e: Option<&str>) -> &'static str {
    match e {
        Some("finished") => "just finished",
        Some("done") => "was marked done by the user",
        _ => "changed",
    }
}

const KIT_JOB: &str = "\n\nThe user asked you to build your own kit: the skills and instructions files that make you excellent at the goal in their message. First learn what that takes here: your brief and notebook, your current kit, and (if you have a project) its README, AGENTS.md / CLAUDE.md, design and contributing docs, and how its code is actually written. Then propose files with `kit` in your crew block (see below): one instructions file (`rules`, e.g. AGENTS.md: how you always work, your standards, what you never do) and a few focused skills (each one kind of work, a description that says exactly when to use it, then concrete steps, checklists, commands and file paths from this project, not generic advice). 2 to 6 files. To improve one you have, propose it under the same name. Don't write them to disk: wisp shows them to the user, who picks what to add. In your report, list each file and why.";

fn this_job(m: &Member, job: &CrewExt) -> String {
    let from = job.from.as_ref().filter(|f| !f.title.is_empty()).map_or_else(|| "another task".to_owned(), |f| format!("\"{}\" (wisp task {})", f.title, f.id));
    let what = match job.job {
        JobKind::Checkin => format!(
            "A check-in{}{}. Do your standing job from the brief: find what changed since your last check-in (your notebook has what you saw then), act on it, and report.",
            if m.cron.is_empty() { "" } else { " on your schedule" },
            if job.wake { ", at the time you asked to look again" } else { "" }
        ),
        JobKind::Task => "A task from the user, sent to you directly.".to_owned(),
        JobKind::Delegated => format!("Delegated to you by the agent working on {from}. That agent reads your report; it can't see your notebook, so say everything it needs."),
        JobKind::Trigger => format!("Started by the trigger \"{}\".", job.from.as_ref().map_or("a trigger", |f| if f.title.is_empty() { "a trigger" } else { f.title.as_str() })),
        JobKind::Mention => format!("The user tagged you in {from}. Your answer shows there, under their message. Read that task with wisp_session if you need its context."),
        JobKind::Event => format!("The task {from} {}, and you watch for that. Do your standing job from the brief on it: read it with wisp_session. To have its agent fix what you found, send it a followUp.", event_what(job.event.as_deref())),
    };
    if job.kit { what + KIT_JOB } else { what }
}

fn log_lines(m: &Member, zone: &dyn Zone) -> String {
    if m.log.is_empty() {
        return "None yet: this is your first.".to_owned();
    }
    let lines: Vec<String> = m
        .log
        .iter()
        .take(LOG_IN_PROMPT)
        .map(|l| {
            let summary = if l.summary.is_empty() { String::new() } else { format!(": {}", l.summary) };
            let tag = if l.quiet { " (nothing new)" } else if l.for_later { " (filed for later)" } else { "" };
            format!("- {} · {} · {}{summary}{tag}", when(l.at, zone), job_label(l.job), l.title)
        })
        .collect();
    lines.join("\n")
}

fn reporting(m: &Member, job: &CrewExt) -> String {
    let quiet_job = job.job.nobody_waits();
    let noun = if job.job == JobKind::Event { "job" } else { "check-in" };
    let quiet = if quiet_job { format!("true when this {noun} found nothing the user needs to see: wisp logs it and doesn’t notify them. Leave it out when there is something to report.") } else { "only for check-ins and jobs about a task you watch; this job is waited on, so always report.".to_owned() };
    let later = if quiet_job { "true when you found something worth reading but not urgent (a digest, an FYI): wisp files your report in the user’s For later list without notifying them. Leave it out when they should know now, and use quiet when there is nothing to read." } else { "only for check-ins and jobs about a task you watch; this job is waited on, so leave it out." };
    let target = if job.job == JobKind::Delegated {
        "not the one that delegated this job: its agent reads your report".to_owned()
    } else if let Some(f) = job.from.as_ref().filter(|f| m.links.iter().any(|l| l.id == f.id)) {
        format!("`{}` is this job's", f.id)
    } else {
        "none for this job".to_owned()
    };
    let n = m.notebook.chars().count();
    format!(
        "### Memory and reporting

Put one `crew` block last in your final message's blocks. wisp reads it and doesn't show it to the user:
{{\"type\":\"crew\",\"topic\":\"…\",\"remember\":[\"…\"],\"notebook\":\"…\",\"wakeIn\":30,\"quiet\":true,\"forLater\":true,\"followUp\":{{\"task\":\"<id>\",\"text\":\"…\"}}}}
- topic: the subject of this job as a short noun phrase (≤6 words), when your answer has no hero to carry one (a quick answer in plain text, then only this block); wisp names the task with it.
- remember: lasting facts to add to your notebook: ids, versions and states you'll compare against next time, the user's preferences for this job, open threads. Other jobs of yours may write at the same time, so add lines with remember rather than rewriting.
- notebook: the whole notebook rewritten, only to tidy it (it has {n} characters; keep it under {NOTEBOOK_SOFT}). Drop what's stale.
- wakeIn: minutes until wisp should start a fresh check-in (at least {WAKE_MIN}), when you want to do your standing job again sooner than your schedule. To carry on with *this* job instead (wait for a deploy or a run, then finish what you started, with this context), call resume_later.
- quiet: {quiet}
- forLater: {later}
- kit: skills or instructions files you propose for your own kit, when a job asked for that or you found a lasting how-to worth keeping (rarely otherwise): [{{\"kind\":\"skill\",\"name\":\"lowercase-with-dashes\",\"description\":\"when to use it\",\"body\":\"markdown steps\"}},{{\"kind\":\"rules\",\"name\":\"AGENTS.md\",\"body\":\"markdown\"}}]. The user reviews them before they're added; the same name replaces yours.
- followUp: a message wisp sends to the agent working on one of your tasks above, as a follow-up from you (the user sees it in that task, from you). Use it when that agent should act on what you found (fix this, rerun that) or was waiting on you. Its task is one of the ids above ({target}). wisp adds you to that task's delegates, so its agent can hand the work back to you. At most 3 (a list); only when it helps: your answer already reaches the user.
Leave out the fields you don't need, and keep secrets out of the notebook."
    )
}

/// Appended to a job's system prompt. `files`: the member's SKILL.md files here (None: elsewhere).
pub fn crew_note(m: &Member, job: &CrewExt, files: Option<&BTreeMap<String, String>>, zone: &dyn Zone) -> String {
    let role = if m.role.is_empty() { String::new() } else { format!("Your role: {}. ", m.role) };
    let brief = if m.brief.is_empty() { "(none yet: do what each job asks)" } else { m.brief.as_str() };
    let notebook = if m.notebook.is_empty() { "Empty so far.".to_owned() } else { format!("<notebook>\n{}\n</notebook>", m.notebook) };
    let links = if m.links.is_empty() {
        String::new()
    } else {
        let l: Vec<String> = m.links.iter().take(LINKS_IN_PROMPT.min(LINKS_MAX)).map(|l| format!("- `{}` \"{}\"", l.id, l.title)).collect();
        format!("\n### Tasks you're part of\n\nYou were tagged in or delegated by these. You may send their agent a follow-up (see followUp below):\n{}\n", l.join("\n"))
    };
    format!(
        "\n\n## You are {name}, on the user's crew\n\n{role}You are one of the user's long-lived agents. wisp hands you work as separate jobs: on your schedule (check-ins), from the user, from other tasks' agents, from triggers and when tasks you watch finish or are marked done. Several can run at once, each in its own context. What carries over from job to job is your brief, your notebook and the log below, so keep the notebook current.\n\n### Your brief (from the user)\n\n{brief}\n{kit}### Your notebook\n\n{notebook}\n\n### Your recent jobs (newest first)\n\n{log}\n\n### This job\n\n{what}\n{links}{reporting}",
        name = m.name,
        kit = kit_note(m, files),
        log = log_lines(m, zone),
        what = this_job(m, job),
        reporting = reporting(m, job),
    )
}

/// The prompt a check-in starts with.
pub fn checkin_prompt(m: &Member, wake: bool) -> String {
    format!("Check-in #{}{}: do your standing job and report what changed.", m.checkins + 1, if wake { " (you asked to look again)" } else { "" })
}
