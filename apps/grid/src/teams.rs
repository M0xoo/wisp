//! Team spaces (ADR-0041): a team holds members with a role, and shares can be for its members only.
//! Roles map to what a member may do here:
//!
//! | role   | read the team's shares | share to the team | add or remove members |
//! |--------|------------------------|-------------------|-----------------------|
//! | owner  | yes                    | yes               | yes (and owners)      |
//! | admin  | yes                    | yes               | yes (not owners)      |
//! | member | yes                    | yes               | no (but may leave)    |
//! | viewer | yes                    | no                | no (but may leave)    |
//!
//! A team always keeps an owner: the last one can't leave or be removed.
use std::sync::Arc;

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::UserRow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Member,
    Admin,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
            Self::Viewer => "viewer",
        }
    }
    pub fn shares(self) -> bool {
        self >= Self::Member
    }
    pub fn manages(self) -> bool {
        self >= Self::Admin
    }
}

#[derive(Debug, Clone)]
pub struct Teams {
    pub db: Arc<Db>,
    pub clock: SharedClock,
}

fn slug_ok(s: &str) -> bool {
    (2..=40).contains(&s.len()) && crate::hosts::is_handle_label(s) && !s.starts_with('-') && !s.ends_with('-')
}

impl Teams {
    fn team_id(&self, slug: &str) -> Result<String> {
        self.db
            .with(|c| c.query_row("SELECT id FROM teams WHERE slug = ?1", [slug], |r| r.get(0)).optional())?
            .ok_or_else(|| bad(format!("There's no team {slug}."), 404))
    }

    /// A user's role in a team; None when they aren't in it (or there's no such team).
    pub fn role(&self, user_id: &str, slug: &str) -> Result<Option<Role>> {
        let r: Option<String> = self.db.with(|c| {
            c.query_row(
                "SELECT m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE t.slug = ?1 AND m.user_id = ?2",
                params![slug, user_id],
                |r| r.get(0),
            )
            .optional()
        })?;
        Ok(r.as_deref().and_then(Role::parse))
    }

    /// A new team, with its maker as owner.
    pub fn create(&self, user: &UserRow, slug: &str, name: &str) -> Result<Value> {
        let slug = slug.trim().to_ascii_lowercase();
        if !slug_ok(&slug) {
            return Err(bad("A team's name is 2 to 40 of a-z, 0-9 and dashes.", 400));
        }
        let id = crate::accounts::token("t_");
        let now = self.clock.now_ms();
        let name = if name.trim().is_empty() { slug.clone() } else { name.trim().chars().take(60).collect() };
        self.db.tx(|tx| {
            if tx.query_row("SELECT 1 FROM teams WHERE slug = ?1", [&slug], |_| Ok(())).optional()?.is_some() {
                return Err(bad(format!("The team {slug} exists already."), 409));
            }
            tx.execute("INSERT INTO teams (id, slug, name, created_at) VALUES (?1, ?2, ?3, ?4)", params![id, slug, name, now])?;
            tx.execute(
                "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)",
                params![id, user.id, now],
            )?;
            Ok(())
        })?;
        Ok(json!({ "slug": slug, "name": name, "role": "owner" }))
    }

    /// `actor` adds `handle` (or changes their role).
    pub fn add(&self, actor: &UserRow, slug: &str, handle: &str, role: &str) -> Result<()> {
        let role = Role::parse(role).ok_or_else(|| bad("A role is owner, admin, member or viewer.", 400))?;
        let mine = self.role(&actor.id, slug)?.ok_or_else(|| bad(format!("You aren't in {slug}."), 403))?;
        if !mine.manages() || (role == Role::Owner && mine != Role::Owner) {
            return Err(bad(format!("Only an owner or admin of {slug} adds people (and only an owner adds owners)."), 403));
        }
        let tid = self.team_id(slug)?;
        let uid: String = self
            .db
            .with(|c| c.query_row("SELECT id FROM users WHERE handle = ?1", [handle], |r| r.get(0)).optional())?
            .ok_or_else(|| bad(format!("There's nobody called {handle} here."), 404))?;
        if self.role(&uid, slug)? == Some(Role::Owner) && mine != Role::Owner {
            return Err(bad("Only an owner changes an owner's role.", 403));
        }
        if self.role(&uid, slug)? == Some(Role::Owner) && role != Role::Owner && self.owners(&tid)? == 1 {
            return Err(bad(format!("{slug} needs an owner: make someone else owner first."), 409));
        }
        let now = self.clock.now_ms();
        self.db.with(|c| c.execute("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role", params![tid, uid, role.as_str(), now]))?;
        Ok(())
    }

    fn owners(&self, tid: &str) -> Result<i64> {
        self.db.with(|c| c.query_row("SELECT count(*) FROM team_members WHERE team_id = ?1 AND role = 'owner'", [tid], |r| r.get(0)))
    }

    /// `actor` removes `handle` (themselves: they leave).
    pub fn remove(&self, actor: &UserRow, slug: &str, handle: &str) -> Result<()> {
        let mine = self.role(&actor.id, slug)?.ok_or_else(|| bad(format!("You aren't in {slug}."), 403))?;
        let tid = self.team_id(slug)?;
        let uid: String = self
            .db
            .with(|c| c.query_row("SELECT id FROM users WHERE handle = ?1", [handle], |r| r.get(0)).optional())?
            .ok_or_else(|| bad(format!("There's nobody called {handle} here."), 404))?;
        let theirs = self.role(&uid, slug)?.ok_or_else(|| bad(format!("{handle} isn't in {slug}."), 404))?;
        let own = uid == actor.id;
        if !own && (!mine.manages() || (theirs == Role::Owner && mine != Role::Owner)) {
            return Err(bad(format!("Only an owner or admin of {slug} removes people."), 403));
        }
        if theirs == Role::Owner && self.owners(&tid)? == 1 {
            return Err(bad(format!("{slug} needs an owner: make someone else owner first."), 409));
        }
        self.db.with(|c| c.execute("DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2", params![tid, uid]))?;
        Ok(())
    }

    /// The teams a user is in, with their role.
    pub fn of(&self, user_id: &str) -> Result<Vec<Value>> {
        self.db.with(|c| {
            let mut s = c.prepare(
                "SELECT t.slug, t.name, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?1 ORDER BY t.slug",
            )?;
            s.query_map([user_id], |r| {
                Ok(json!({ "slug": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "role": r.get::<_, String>(2)? }))
            })?
            .collect()
        })
    }

    /// A team's members, for its page.
    pub fn members(&self, slug: &str) -> Result<Vec<Value>> {
        self.db.with(|c| {
            let mut s = c.prepare("SELECT u.handle, m.role FROM team_members m JOIN teams t ON t.id = m.team_id JOIN users u ON u.id = m.user_id WHERE t.slug = ?1 ORDER BY u.handle")?;
            s.query_map([slug], |r| Ok(json!({ "handle": r.get::<_, String>(0)?, "role": r.get::<_, String>(1)? })))?.collect()
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::accounts::Accounts;
    use crate::clock::ManualClock;

    #[test]
    fn team_roles_decide_who_shares_and_manages() {
        let db = Arc::new(Db::memory().unwrap());
        let clock = ManualClock::new(1);
        let a = Accounts { db: db.clone(), clock: clock.clone() };
        let t = Teams { db, clock };
        let (ada, bo, cy, di) =
            (a.dev_user("ada").unwrap(), a.dev_user("bo").unwrap(), a.dev_user("cy").unwrap(), a.dev_user("di").unwrap());
        t.create(&ada, "acme", "Acme").unwrap();
        assert!(t.create(&bo, "acme", "").is_err());
        assert!(t.create(&bo, "x", "").is_err(), "too short");
        t.add(&ada, "acme", "bo", "admin").unwrap();
        t.add(&ada, "acme", "cy", "member").unwrap();
        // an admin adds people, but not owners
        t.add(&bo, "acme", "di", "viewer").unwrap();
        assert_eq!(t.add(&bo, "acme", "di", "owner").unwrap_err().status(), 403);
        // a member or viewer adds nobody
        assert_eq!(t.add(&cy, "acme", "di", "member").unwrap_err().status(), 403);
        assert_eq!(t.add(&di, "acme", "cy", "viewer").unwrap_err().status(), 403);
        // who shares
        let r = |u: &UserRow| t.role(&u.id, "acme").unwrap().unwrap();
        assert!(r(&ada).shares() && r(&bo).shares() && r(&cy).shares() && !r(&di).shares());
        assert!(r(&bo).manages() && !r(&cy).manages());
        // anyone may leave; an admin can't remove the owner; the last owner can't leave
        t.remove(&di, "acme", "di").unwrap();
        assert_eq!(t.remove(&bo, "acme", "ada").unwrap_err().status(), 403);
        assert_eq!(t.remove(&ada, "acme", "ada").unwrap_err().status(), 409);
        assert_eq!(t.add(&ada, "acme", "ada", "member").unwrap_err().status(), 409);
        t.add(&ada, "acme", "bo", "owner").unwrap();
        t.remove(&ada, "acme", "ada").unwrap();
        assert_eq!(t.of(&bo.id).unwrap()[0]["role"], "owner");
        assert_eq!(t.members("acme").unwrap().len(), 2);
    }
}
