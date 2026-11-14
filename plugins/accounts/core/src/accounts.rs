//! A harness's accounts (v1 accounts.js `Accounts`): the list in the user's order, which one a run
//! gets, a usage limit's cool-down, who a login is. wisp never switches accounts to get around a
//! limit: a launch you start yourself skips one known to be at its limit, an unattended one doesn't.

use serde::{Deserialize, Serialize};
use wisp_accounts_api::{AccountKind, AccountState, AccountView};

/// accounts per harness
pub const MAX: usize = 8;
/// characters in a label
pub const LABEL: usize = 40;
/// the default account's id: the CLI's own folder
pub const DEFAULT: &str = "default";

/// An account as stored (v1 accounts.json entries, field for field).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub email: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub plan: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<Limit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limit {
    pub until: i64,
    #[serde(default)]
    pub why: String,
}

/// Why a change was refused, in v1's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    Invalid(String),
    NotFound,
}

fn clip_chars(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// "a.b@gmail.com" → "A.b": the label an account gets when you don't name it.
pub fn from_email(email: &str) -> String {
    let name = email.split('@').next().unwrap_or("");
    let mut c = name.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

/// Plans that belong to an employer or school.
fn work_plan(plan: &str) -> bool {
    let p = plan.to_lowercase();
    ["team", "enterprise", "business", "edu"].iter().any(|w| p.contains(w))
}

/// The stored list, with the default first when nothing is stored.
pub fn raw(list: &[Stored]) -> Vec<Stored> {
    if list.is_empty() { vec![Stored { id: DEFAULT.into(), ..Stored::default() }] } else { list.to_vec() }
}

pub fn view_of(a: &Stored, now: i64) -> AccountView {
    let limit = a.limit.as_ref().filter(|l| l.until > now);
    let label = if !a.label.is_empty() {
        a.label.clone()
    } else if !from_email(&a.email).is_empty() {
        from_email(&a.email)
    } else if a.id == DEFAULT {
        "Main".into()
    } else {
        "Account".into()
    };
    let kind = a.kind.as_deref().and_then(AccountKind::parse).unwrap_or(if work_plan(&a.plan) {
        AccountKind::Work
    } else {
        AccountKind::Personal
    });
    AccountView {
        id: a.id.clone(),
        label,
        email: a.email.clone(),
        plan: a.plan.clone(),
        default: a.id == DEFAULT,
        kind,
        state: if a.signed_in == Some(false) {
            AccountState::SignedOut
        } else if limit.is_some() {
            AccountState::Limit
        } else {
            AccountState::Ready
        },
        until: limit.map(|l| l.until),
        why: limit.map(|l| l.why.clone()).unwrap_or_default(),
    }
}

pub fn view(list: &[Stored], now: i64) -> Vec<AccountView> {
    raw(list).iter().map(|a| view_of(a, now)).collect()
}

pub fn multi(list: &[Stored]) -> bool {
    list.len() > 1
}

/// Which account a run gets: `prefer` (your last pick), else the first in your order; a launch you
/// start yourself skips one at its limit or signed out. '' when the harness has one account.
pub fn pick(list: &[Stored], prefer: &str, by_hand: bool, now: i64) -> String {
    if !multi(list) {
        return String::new();
    }
    let v = view(list, now);
    let want = v.iter().find(|a| a.id == prefer).unwrap_or(&v[0]);
    if !by_hand || want.state == AccountState::Ready {
        return want.id.clone();
    }
    v.iter().find(|a| a.state == AccountState::Ready).unwrap_or(want).id.clone()
}

/// A new account, last. `id` is the client's (the row that shows at once is the row kept).
pub fn add(list: &[Stored], id: &str, label: &str, kind: &str, now: i64, name: &str) -> Result<Vec<Stored>, Refused> {
    let mut l = raw(list);
    if l.len() >= MAX {
        return Err(Refused::Invalid(format!("{name} already has {MAX} accounts.")));
    }
    if !kind.is_empty() && AccountKind::parse(kind).is_none() {
        return Err(Refused::Invalid("kind must be one of personal, work.".into()));
    }
    let id = if id.is_empty() || id == DEFAULT { format!("a{now:x}") } else { clip_chars(id, 40) };
    if l.iter().any(|a| a.id == id) {
        return Err(Refused::Invalid("That account is there already.".into()));
    }
    l.push(Stored {
        id,
        label: clip_chars(label, LABEL),
        kind: (!kind.is_empty()).then(|| kind.to_owned()),
        added_at: Some(now),
        ..Stored::default()
    });
    Ok(l)
}

/// Rename, set its kind, move it up or down.
pub fn update(list: &[Stored], id: &str, label: Option<&str>, kind: Option<&str>, mv: Option<&str>) -> Result<Vec<Stored>, Refused> {
    let mut l = raw(list);
    let at = l.iter().position(|a| a.id == id).ok_or(Refused::NotFound)?;
    if let Some(lb) = label {
        l[at].label = clip_chars(lb, LABEL);
    }
    if let Some(k) = kind {
        if AccountKind::parse(k).is_none() {
            return Err(Refused::Invalid("kind must be one of personal, work.".into()));
        }
        l[at].kind = Some(k.to_owned());
    }
    match mv {
        Some("up") if at > 0 => l.swap(at, at - 1),
        Some("down") if at + 1 < l.len() => l.swap(at, at + 1),
        _ => {}
    }
    Ok(l)
}

/// Forget an account; the default stays. An empty list: only the default is left.
pub fn remove(list: &[Stored], id: &str) -> Result<Vec<Stored>, Refused> {
    if id == DEFAULT {
        return Err(Refused::Invalid("That’s the account the CLI uses on its own: sign out of it instead.".into()));
    }
    let l = raw(list);
    if !l.iter().any(|a| a.id == id) {
        return Err(Refused::NotFound);
    }
    let rest: Vec<Stored> = l.into_iter().filter(|a| a.id != id).collect();
    Ok(if rest.len() <= 1 && rest.first().is_some_and(|a| a.id == DEFAULT) { Vec::new() } else { rest })
}

/// A usage limit: skipped by hand-started launches until `until`.
pub fn cool(list: &mut [Stored], id: &str, until: i64, why: &str) -> bool {
    let id = if id.is_empty() { DEFAULT } else { id };
    let Some(a) = list.iter_mut().find(|a| a.id == id) else { return false };
    a.limit = Some(Limit { until, why: why.chars().take(160).collect() });
    true
}

/// The account's plan is free again before the time `cool` gave (an early reset, `budget.plan_free`): hand-started
/// launches may pick it at once. Whether it was cooled.
pub fn uncool(list: &mut [Stored], id: &str) -> bool {
    let id = if id.is_empty() { DEFAULT } else { id };
    list.iter_mut().find(|a| a.id == id).is_some_and(|a| a.limit.take().is_some())
}

/// What the CLI says about a login, kept for the page.
pub fn identify(list: &mut [Stored], id: &str, email: Option<&str>, plan: Option<&str>, signed_in: Option<bool>) -> bool {
    let id = if id.is_empty() { DEFAULT } else { id };
    let Some(a) = list.iter_mut().find(|a| a.id == id) else { return false };
    if let Some(e) = email.filter(|e| !e.is_empty()) {
        a.email = e.chars().take(200).collect();
    }
    if let Some(p) = plan.filter(|p| !p.is_empty()) {
        a.plan = p.chars().take(40).collect();
    }
    if signed_in.is_some() {
        a.signed_in = signed_in;
    }
    if signed_in == Some(true) {
        a.limit = None;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two() -> Vec<Stored> {
        add(&[], "w1", "Work", "work", 5, "Claude").unwrap_or_default()
    }

    #[test]
    fn one_account_is_the_default_and_picks_nothing() {
        let v = view(&[], 0);
        assert_eq!((v.len(), v[0].label.as_str(), v[0].default), (1, "Main", true));
        assert_eq!(pick(&[], "", true, 0), "");
    }

    #[test]
    fn add_update_remove_as_v1() {
        let l = two();
        assert_eq!(l.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["default", "w1"]);
        let l = update(&l, "w1", Some("  Day job "), None, Some("up")).unwrap_or_default();
        assert_eq!((l[0].id.as_str(), l[0].label.as_str()), ("w1", "Day job"));
        assert_eq!(update(&l, "nope", None, None, None), Err(Refused::NotFound));
        assert!(matches!(remove(&l, DEFAULT), Err(Refused::Invalid(_))));
        assert!(remove(&l, "w1").unwrap_or_default().is_empty(), "only the default left: no entry");
        let mut full = Vec::new();
        for i in 0..MAX - 1 {
            full = add(&full, &format!("x{i}"), "", "", 0, "Claude").unwrap_or_default();
        }
        assert!(matches!(add(&full, "y", "", "", 0, "Claude"), Err(Refused::Invalid(m)) if m == "Claude already has 8 accounts."));
    }

    #[test]
    fn a_launch_by_hand_skips_an_account_at_its_limit_an_unattended_one_doesnt() {
        let mut l = two();
        cool(&mut l, "default", 1000, "5-hour limit");
        assert_eq!(view(&l, 10)[0].state, AccountState::Limit);
        assert_eq!(pick(&l, "default", true, 10), "w1");
        assert_eq!(pick(&l, "default", false, 10), "default");
        assert_eq!(pick(&l, "default", true, 2000), "default", "the limit ended");
        identify(&mut l, "default", Some("ann.b@x.dev"), Some("team"), Some(true));
        let v = view(&l, 10);
        assert_eq!(
            (v[0].state, v[0].kind, v[0].label.as_str()),
            (AccountState::Ready, AccountKind::Work, "Ann.b"),
            "signing in clears the limit; a team plan is work"
        );
    }
}
