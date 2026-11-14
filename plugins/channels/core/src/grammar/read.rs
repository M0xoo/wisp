//! Reading (v1 grammar.js, first half): where the options at the front of a message end. A thing that exists
//! anywhere is an option even if it can't run here, so `with gpt-5 fix it` is refused, not sent as a sentence.

use wisp_channels_api::{AgentView, ChannelCtx, MemberView, Mode, ModelView, Problem, ProjectView};

use crate::mentions::crew_mentions;

/// Words a bare in/on can't take as the start of a name: "in the login page", "on my laptop".
const NOT_A_NAME: [&str; 18] =
    ["a", "an", "the", "my", "our", "your", "this", "that", "these", "those", "all", "it", "its", "one", "some", "any", "each", "every"];

pub(crate) fn is_colon(c: char) -> bool {
    c == ':' || c == '：'
}

/// `^\s*[:：]`
pub(crate) fn starts_colon(s: &str) -> bool {
    s.trim_start().starts_with(is_colon)
}

pub(crate) fn drop_colon(s: &str) -> &str {
    let t = s.trim_start();
    t.strip_prefix(is_colon).unwrap_or(t)
}

fn strip_marks(w: &str) -> &str {
    w.trim_matches(|c| matches!(c, '*' | '_' | '~' | '`'))
}

/// The next word, its marks and punctuation apart from it.
#[derive(Debug, Clone)]
pub(crate) struct Token<'a> {
    pub raw: &'a str,
    pub word: String,
    pub low: String,
    pub colon: bool,
    pub comma: bool,
    pub after: &'a str,
}

pub(crate) fn token(s: &str) -> Token<'_> {
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    let raw = &s[..end];
    let mut w = strip_marks(raw);
    let colon = w.ends_with(is_colon);
    let comma = w.ends_with(',');
    if colon || comma {
        let cut = w.char_indices().last().map_or(0, |(i, _)| i);
        w = strip_marks(&w[..cut]);
    }
    Token { raw, word: w.to_owned(), low: w.to_lowercase(), colon, comma, after: s[end..].trim_start() }
}

pub(crate) fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// with X [Y] [Z], as read: harness, model, effort (or Auto's goal), checked later.
#[derive(Debug, Clone, Default)]
pub(crate) struct With {
    pub agent: String,
    pub model: String,
    pub effort: String,
}

/// What the options said so far (v1 `fresh()` plus what resolving fills).
#[derive(Debug, Clone, Default)]
pub(crate) struct Opts {
    pub crew: Option<MemberView>,
    pub tagged: Vec<MemberView>,
    pub project: Option<ProjectView>,
    /// None: not said; Some(""): this computer
    pub machine: Option<String>,
    pub withs: Option<With>,
    pub mode: Option<Mode>,
    pub problems: Vec<Problem>,
    pub notes: Vec<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Opts {
    pub fn problem(&mut self, kind: &str, text: String, choices: Vec<String>) {
        self.problems.push(Problem { kind: kind.into(), text, choices });
    }
}

/// One option read: what's left, whether it ended at `:`, and `stop` (a problem: read no further).
pub(crate) struct Step {
    pub rest: String,
    pub colon: bool,
    pub stop: bool,
}

#[allow(clippy::unnecessary_wraps)] // the shape every reader returns
fn step(rest: &str, colon: bool) -> Option<Step> {
    Some(Step { rest: rest.to_owned(), colon, stop: false })
}

pub(crate) fn harnesses(c: &ChannelCtx) -> impl Iterator<Item = &AgentView> {
    c.adapters.iter().map(|a| &a.agent).filter(|a| a.id != "wisp")
}

pub(crate) fn place_list(c: &ChannelCtx) -> Vec<&AgentView> {
    c.machines.iter().flat_map(|m| m.agents.iter().flatten()).chain(c.agents.iter()).chain(harnesses(c)).collect()
}

pub(crate) fn model_ids(a: &AgentView) -> impl Iterator<Item = &ModelView> {
    a.models.iter().filter(|m| !m.id.is_empty())
}

pub(crate) fn find_harness<'a>(c: &'a ChannelCtx, w: &str) -> Option<&'a AgentView> {
    harnesses(c).find(|a| {
        let name = lower(a.name.as_deref().unwrap_or_default());
        a.id == w || name == w || name.split(' ').next() == Some(w) || (w.chars().count() >= 3 && a.id.starts_with(w))
    })
}

/// Id, label, then prefix (of the id, or the part after a provider's `/`): (tier, hits).
pub(crate) fn match_models<'a>(a: &'a AgentView, w: &str) -> (u8, Vec<&'a ModelView>) {
    let label = |m: &ModelView| lower(m.label.as_deref().unwrap_or_default());
    let exact: Vec<_> = model_ids(a).filter(|m| lower(&m.id) == w).collect();
    if !exact.is_empty() {
        return (0, exact);
    }
    let by_label: Vec<_> = model_ids(a).filter(|m| label(m) == w).collect();
    if !by_label.is_empty() {
        return (1, by_label);
    }
    if w.chars().count() < 3 {
        return (2, Vec::new()); // "with a test" isn't a model
    }
    (
        2,
        model_ids(a)
            .filter(|m| {
                let id = lower(&m.id);
                id.starts_with(w) || id.rsplit('/').next().is_some_and(|t| t.starts_with(w)) || label(m).starts_with(w)
            })
            .collect(),
    )
}

fn model_known(c: &ChannelCtx, w: &str) -> bool {
    place_list(c).iter().any(|a| a.id != "wisp" && !match_models(a, w).1.is_empty())
}

pub(crate) fn effort_known(c: &ChannelCtx, w: &str) -> bool {
    place_list(c).iter().any(|a| a.efforts.iter().any(|e| e == w) || model_ids(a).any(|m| m.efforts.iter().any(|e| e == w)))
}

/// "with gpt-9": shaped like a model (`[a-z]+-\d`), so not a sentence.
pub(crate) fn model_shape(w: &str) -> bool {
    let letters = w.chars().take_while(char::is_ascii_alphabetic).count();
    letters > 0 && w[letters..].starts_with('-') && w[letters + 1..].starts_with(|c: char| c.is_ascii_digit())
}

/// A name picked from a list: its index, or several it could be.
pub(crate) enum Pick {
    One { at: usize, rest: String, colon: bool },
    Ambiguous { all: Vec<usize>, word: String, rest: String },
}

/// A bare in/on: a whole name (longest first; names may have spaces), else the unique name a word starts. A
/// comma says it's a sentence ("in app, the button…"). `exact`: whole names only, and two that fit are
/// ambiguous (a router: "on mac" isn't enough to send work somewhere).
pub(crate) fn pick_name(names: &[&str], s: &str, exact: bool) -> Option<Pick> {
    let text = lower(s);
    let mut order: Vec<usize> = (0..names.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(names[i].chars().count()));
    for i in order {
        let n = lower(names[i]);
        if !n.is_empty()
            && text.starts_with(&n)
            && (text.len() == n.len()
                || text[n.len()..].starts_with(|c: char| c.is_whitespace() || matches!(c, ':' | '：' | ',' | '*' | '_' | '~' | '`')))
        {
            let tail = s.get(n.len()..).unwrap_or_default();
            if exact {
                let twins: Vec<usize> = (0..names.len()).filter(|&j| lower(names[j]) == n).collect();
                if twins.len() > 1 {
                    return Some(Pick::Ambiguous { all: twins, word: names[i].to_owned(), rest: tail.trim_start().to_owned() });
                }
            }
            let t = token(tail);
            if t.word.is_empty() && !t.raw.is_empty() {
                return Some(Pick::One { at: i, rest: t.after.to_owned(), colon: t.colon || starts_colon(tail) });
            }
            return Some(Pick::One { at: i, rest: tail.trim_start().to_owned(), colon: false });
        }
    }
    let t = token(s);
    let whole: Vec<usize> = (0..names.len()).filter(|&i| lower(names[i]) == t.low).collect();
    if whole.len() == 1 {
        return Some(Pick::One { at: whole[0], rest: t.after.to_owned(), colon: t.colon });
    }
    if exact {
        return (!whole.is_empty()).then(|| Pick::Ambiguous { all: whole, word: t.word.clone(), rest: t.after.to_owned() });
    }
    if t.word.is_empty() || t.comma || t.word.chars().count() < 2 || NOT_A_NAME.contains(&t.low.as_str()) {
        return None;
    }
    let hits: Vec<usize> = (0..names.len()).filter(|&i| lower(names[i]).starts_with(&t.low)).collect();
    match hits.len() {
        0 => None,
        1 => Some(Pick::One { at: hits[0], rest: t.after.to_owned(), colon: t.colon }),
        _ => Some(Pick::Ambiguous { all: hits, word: t.word.clone(), rest: t.after.to_owned() }),
    }
}

/// Past an in/on that matched nothing: would what follows be options up to a `:`? Then that's what the writer
/// meant, and running somewhere else would be wrong.
fn options_to_colon(s: &str, o: &Opts, c: &ChannelCtx) -> bool {
    if starts_colon(s) {
        return true;
    }
    let mut probe = Opts {
        crew: o.crew.clone(),
        project: o.project.clone(),
        machine: o.machine.clone(),
        withs: o.withs.clone(),
        mode: o.mode,
        ..Opts::default()
    };
    let mut rest = s.to_owned();
    while !rest.is_empty() {
        let r = rest.clone();
        let Some(st) = read_option(&token(&r), &r, &mut probe, c, 1) else { return false };
        if st.colon {
            return true;
        }
        rest = st.rest;
    }
    false
}

/// What a place word found: a list index, or a special place (this computer, a sandbox, your cloud computer).
enum Found {
    At(usize),
    Id(String),
}

/// A place word of its own (`here`, `sandbox`, `cloud`): (id, rest, colon).
type Special<'a> = &'a dyn Fn(&str) -> Option<(String, String, bool)>;

#[allow(clippy::many_single_char_names)] // v1's names: t token, o options, c ctx, s text, v the next token
fn read_place(
    t: &Token<'_>,
    o: &mut Opts,
    c: &ChannelCtx,
    names: &[&str],
    kind: &str,
    special: Option<Special<'_>>,
) -> Option<(Found, Step)> {
    let s = t.after;
    if s.is_empty() {
        return None;
    }
    if let Some((id, rest, colon)) = special.and_then(|f| f(s)) {
        return Some((Found::Id(id), Step { rest, colon, stop: false }));
    }
    match pick_name(names, s, c.exact) {
        Some(Pick::Ambiguous { all, word, rest }) => {
            o.problem("ambiguous", format!("“{word}” could be {} {kind}s.", all.len()), all.iter().map(|&i| names[i].to_owned()).collect());
            Some((Found::At(usize::MAX), Step { rest, colon: false, stop: true }))
        }
        Some(Pick::One { at, rest, colon }) => Some((Found::At(at), Step { rest, colon, stop: false })),
        None => {
            let v = token(s);
            if v.word.is_empty() {
                return None;
            }
            if v.colon || options_to_colon(v.after, o, c) {
                o.problem("no-match", format!("No {kind} “{}”.", v.word), names.iter().map(|n| (*n).to_owned()).collect());
                return Some((Found::At(usize::MAX), Step { rest: v.after.to_owned(), colon: false, stop: true }));
            }
            o.notes.push(format!("“{} {}” isn’t one of your {kind}s, so I read it as part of the task.", t.word, v.word));
            None
        }
    }
}

/// on: `cloud` your cloud computer, `sandbox` a fresh box, `here` this computer. → (id, rest, colon).
fn machine_word(c: &ChannelCtx, s: &str) -> Option<(String, String, bool)> {
    let t = token(s);
    if matches!(t.low.as_str(), "here" | "local") {
        return Some((String::new(), t.after.to_owned(), t.colon));
    }
    if t.low == "this" && lower(t.after).starts_with("computer") {
        let n = token(t.after);
        if n.low == "computer" {
            return Some((String::new(), n.after.to_owned(), n.colon));
        }
    }
    if t.low == "sandbox" {
        return Some(("sandbox".into(), t.after.to_owned(), t.colon));
    }
    if t.low == "cloud" && !c.machines.iter().any(|m| lower(&m.name) == "cloud") {
        let clouds: Vec<_> = c.machines.iter().filter(|m| m.kind.as_deref() == Some("grid") && !m.computer).collect();
        if let [one] = clouds.as_slice() {
            return Some((one.id.clone(), t.after.to_owned(), t.colon));
        }
    }
    None
}

/// with X [Y] [Z]: harness, model, effort, or Auto's goal. A word known nowhere ends the options.
fn read_with(t: &Token<'_>, o: &mut Opts, c: &ChannelCtx) -> Option<Step> {
    let mut cur = token(t.after);
    if cur.word.is_empty() {
        return None;
    }
    let mut w = With::default();
    if cur.low == "auto" {
        w.agent = "auto".into();
        if cur.colon {
            o.withs = Some(w);
            return step(cur.after, true);
        }
        let next = token(cur.after);
        if c.goals.contains(&next.low) {
            w.model.clone_from(&next.low);
            o.withs = Some(w);
            return step(next.after, next.colon);
        }
        if effort_known(c, &next.low) {
            w.effort.clone_from(&next.low);
            o.withs = Some(w);
            return step(next.after, next.colon);
        }
        o.withs = Some(w);
        return step(cur.after, cur.colon);
    }
    if let Some(h) = find_harness(c, &cur.low) {
        w.agent.clone_from(&h.id);
        if cur.colon {
            o.withs = Some(w);
            return step(cur.after, true);
        }
        let next = token(cur.after);
        let own = place_list(c).into_iter().filter(|a| a.id == h.id).any(|a| !match_models(a, &next.low).1.is_empty());
        if !next.word.is_empty() && (own || model_shape(&next.word)) {
            w.model.clone_from(&next.low);
            cur = next;
            if cur.colon {
                o.withs = Some(w);
                return step(cur.after, true);
            }
        }
    } else if model_known(c, &cur.low) || model_shape(&cur.word) {
        w.model.clone_from(&cur.low);
        if cur.colon {
            o.withs = Some(w);
            return step(cur.after, true);
        }
    } else if effort_known(c, &cur.low) && cur.colon {
        // on its own only right before `:`: "with high priority, fix…" is a sentence
        w.effort.clone_from(&cur.low);
        o.withs = Some(w);
        return step(cur.after, true);
    } else {
        return None;
    }
    let next = token(cur.after);
    if !next.word.is_empty() && effort_known(c, &next.low) {
        w.effort.clone_from(&next.low);
        o.withs = Some(w);
        return step(next.after, next.colon);
    }
    o.withs = Some(w);
    step(cur.after, cur.colon)
}

fn read_mode(t: &Token<'_>, o: &mut Opts, count: usize) -> Option<Step> {
    if o.mode.is_some() {
        return None;
    }
    let (mut mode, mut last) = (
        match t.low.as_str() {
            "plan" => Some(Mode::Plan),
            "edits" => Some(Mode::Edits),
            "full-auto" => Some(Mode::Auto),
            _ => None,
        },
        t.clone(),
    );
    if t.low == "full" && !t.colon {
        let next = token(t.after);
        if next.low == "auto" {
            mode = Some(Mode::Auto);
            last = next;
        }
    }
    let m = mode?;
    // first, it's a mode only right before `:`: "plan the migration" is a task
    if count == 0 && !last.colon && !starts_colon(last.after) {
        return None;
    }
    o.mode = Some(m);
    step(last.after, last.colon)
}

fn find_project<'a>(list: &'a [ProjectView], q: &str) -> Option<&'a ProjectView> {
    crate::grammar::find_project(list, q)
}

/// One option at the front of `s`, or `None` when this isn't one.
#[allow(clippy::many_single_char_names)] // v1's names: t token, s text, o options, c ctx, m mentions
pub(crate) fn read_option(t: &Token<'_>, s: &str, o: &mut Opts, c: &ChannelCtx, count: usize) -> Option<Step> {
    let thread = c.thread.is_some();
    if t.word.starts_with('@') && !t.word.contains('/') {
        let src = format!(
            "{}{}{}",
            t.word,
            if t.colon {
                ":"
            } else if t.comma {
                ","
            } else {
                ""
            },
            &s[t.raw.len()..]
        );
        let m = crew_mentions(&src, &c.crew);
        if !m.lead.is_empty() && (!thread || o.crew.is_none()) {
            let trimmed = src.trim_end();
            let used = &trimmed[..trimmed.len().saturating_sub(m.rest.len())];
            let mut lead = m.lead.into_iter();
            if let Some(first) = lead.next() {
                if o.crew.is_some() {
                    o.tagged.push(first);
                } else {
                    o.crew = Some(first);
                }
            }
            o.tagged.extend(lead);
            return step(&m.rest, used.trim_end().ends_with(is_colon));
        }
        if thread {
            return None;
        }
        let name = &t.word[1..];
        if o.project.is_none()
            && let Some(p) = (!name.is_empty()).then(|| find_project(&c.projects, name)).flatten()
        {
            o.project = Some(p.clone());
            return step(t.after, t.colon);
        }
        let choices = c.crew.iter().map(|m| format!("@{}", m.name)).chain(c.projects.iter().map(|p| p.name.clone())).collect();
        o.problem("no-match", format!("No crew member or project matches “{name}”."), choices);
        return Some(Step { rest: t.after.to_owned(), colon: false, stop: true });
    }
    if t.word.starts_with('#') && t.word.chars().count() > 1 && !thread && o.project.is_none() {
        let name = &t.word[1..];
        if name.bytes().all(|b| b.is_ascii_digit()) && !c.projects.iter().any(|p| p.name == name) {
            return None; // #123 is an issue
        }
        if let Some(p) = find_project(&c.projects, name) {
            o.project = Some(p.clone());
            return step(t.after, t.colon);
        }
        o.problem("no-match", format!("No project matches “{name}”."), c.projects.iter().map(|p| p.name.clone()).collect());
        return Some(Step { rest: t.after.to_owned(), colon: false, stop: true });
    }
    if t.low == "in" && !t.colon && !thread && o.project.is_none() {
        let names: Vec<&str> = c.projects.iter().map(|p| p.name.as_str()).collect();
        let (found, st) = read_place(t, o, c, &names, "project", None)?;
        if let Found::At(i) = found
            && !st.stop
        {
            o.project = c.projects.get(i).cloned();
        }
        return Some(st);
    }
    if t.low == "on" && !t.colon && !thread && o.machine.is_none() {
        let names: Vec<&str> = c.machines.iter().map(|m| m.name.as_str()).collect();
        let special = |x: &str| machine_word(c, x);
        let (found, st) = read_place(t, o, c, &names, "machine", Some(&special))?;
        if !st.stop {
            o.machine = Some(match found {
                Found::Id(id) => id,
                Found::At(i) => c.machines.get(i).map(|m| m.id.clone()).unwrap_or_default(),
            });
        }
        return Some(st);
    }
    if t.low == "with" && !t.colon && o.withs.is_none() {
        return read_with(t, o, c);
    }
    read_mode(t, o, count)
}
