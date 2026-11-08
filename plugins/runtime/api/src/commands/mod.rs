//! wisp.runtime's commands. Each id is also its permission (`runtime.create` → `runtime:create`), checked
//! by the kernel before the handler runs (default deny). Shapes are v1's request bodies (routes/sessions.js)
//! so the HTTP adapters stay thin.

use serde_json::Value;
use wisp_kernel::Command;

mod more;
mod tasks;

pub use more::*;
pub use tasks::*;

use crate::model::{Presentation, SearchHit, Session, Summary, Turn};

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            const TASK_ARGS: &'static [&'static str] = TASK_ARGS;
            const ALL_TASKS: bool = EVERY_TASK.contains(&$id);
            type Args = $args;
            fn args_ts() -> Option<String> {
                Some(format!("{}{}", <$args as ::ts_rs::TS>::docs().unwrap_or_default(), <$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
            }
            type Out = $out;
        }
    };
}

/// The args that name a task in wisp.runtime's commands: `id` is always the task here.
/// (`of`: the task an agent tool reads, `runtime.agent.session` / `taskState`)
const TASK_ARGS: &[&str] = &["id", "sessionId", "session", "parentId", "from", "taskId", "of"];
/// Its commands that answer about every task: refused to an agent's token (`wisp_kernel::scope`).
const EVERY_TASK: Lists = Lists(&["runtime.list", "runtime.search", "runtime.history"]);

struct Lists(&'static [&'static str]);
impl Lists {
    const fn contains(&self, id: &&str) -> bool {
        let mut i = 0;
        while i < self.0.len() {
            if const_eq(self.0[i], id) {
                return true;
            }
            i += 1;
        }
        false
    }
}

const fn const_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

command!(Create = "runtime.create": StartArgs => Created);
command!(FollowUp = "runtime.followUp": FollowUpArgs => FollowedUp);
command!(
    /// A stop never discards queued follow-ups: it holds them (v1 runner stop).
    Stop = "runtime.stop": StopArgs => Ack
);
command!(Rename = "runtime.rename": RenameArgs => Ack);
command!(Archive = "runtime.archive": ArchiveArgs => Ack);
command!(MarkRead = "runtime.markRead": MarkReadArgs => Ack);
command!(SetState = "runtime.setState": SetStateArgs => Ack);
command!(Delete = "runtime.delete": IdArgs => Ack);
command!(QueueEdit = "runtime.queue.edit": QueueEditArgs => Ack);
command!(QueueSendNow = "runtime.queue.sendNow": QueueItemArgs => FollowedUp);
command!(QueueMerge = "runtime.queue.merge": QueueMergeArgs => Ack);
command!(QueueText = "runtime.queue.text": QueueTextArgs => Ack);
command!(Release = "runtime.release": ReleaseArgs => Ack);
command!(Get = "runtime.get": IdArgs => Session, read_only);
command!(List = "runtime.list": ListArgs => Vec<Summary>, read_only);
command!(Turns = "runtime.turns": TurnsArgs => Vec<Turn>, read_only);
command!(ActivityOf = "runtime.activity": ActivityArgs => ActivityPage, read_only);
command!(PresentationOf = "runtime.presentation": PresentationArgs => Option<Presentation>, read_only);
command!(SetExt = "runtime.setExt": SetExtArgs => Ack);
command!(TurnSetExt = "runtime.turn.setExt": TurnExtArgs => Ack);
command!(Answer = "runtime.answer": AnswerArgs => Value);
command!(Ask = "runtime.ask": AskArgs => Asked);
command!(Approval = "runtime.approval": ApprovalArgs => Value);
command!(PollAnswerOf = "runtime.pollAnswer": PollAnswerArgs => PollAnswer, read_only);
command!(ApproveBlocked = "runtime.approveBlocked": ApproveBlockedArgs => Value);
command!(Btw = "runtime.btw": BtwArgs => BtwEntry);
command!(BtwDrop = "runtime.btw.drop": BtwDropArgs => Ack);
command!(Compact = "runtime.compact": IdArgs => FollowedUp);
command!(Delegate = "runtime.delegate": DelegateArgs => Vec<Delegation>);
command!(Results = "runtime.results": ResultsArgs => Reports, read_only);
command!(Rerun = "runtime.rerun": RerunArgs => FollowedUp);
command!(SignIn = "runtime.signIn": TurnArgs => Ack);
command!(SignInDone = "runtime.signInDone": SignInDoneArgs => Ack);
command!(Overage = "runtime.overage": OverageArgs => Ack);
command!(Note = "runtime.note": NoteArgs => Ack);
command!(Settle = "runtime.settle": SettleArgs => Ack);
command!(Search = "runtime.search": SearchArgs => Vec<SearchHit>, read_only);
command!(Quick = "runtime.quick": QuickArgs => QuickResult);
command!(Agents = "runtime.agents": AgentsArgs => Vec<AgentStatus>, read_only);
command!(Card = "runtime.card": CardArgs => Created);
command!(Fork = "runtime.fork": ForkArgs => Created);
command!(Import = "runtime.import": ImportArgs => ImportReport);
command!(
    /// The named agent profiles (`agents:` in a formula).
    Profiles = "runtime.profiles": Value => Vec<crate::spec::Profile>, read_only
);
command!(
    /// Adds or replaces a profile.
    ProfileSet = "runtime.profile.set": crate::spec::Profile => crate::spec::Profile
);
command!(ProfileRemove = "runtime.profile.remove": crate::spec::NameArgs => Ack);
command!(
    /// A task's spec: what was asked, from which code, under which formula, from where (ADR-0027).
    SpecOf = "runtime.spec": IdArgs => crate::spec::TaskSpec, read_only
);
command!(
    /// A read-only task from shared turns (`wisp open --import`).
    Adopt = "runtime.adopt": crate::spec::AdoptArgs => Created
);
command!(
    /// Tasks by what made them: agent, crew, workflow, project, since, the profiles they ran with.
    History = "runtime.history": crate::spec::HistoryArgs => Vec<crate::spec::HistoryRow>, read_only
);
command!(
    /// The effective formula a task ran with, by its hash or the task's id (ADR-0029).
    SnapshotOf = "runtime.snapshot": crate::spec::HashArgs => crate::spec::Snapshot, read_only
);

/// `wisp_sessions`: an `agent:session` token reads every task's line (the lead's decision); a capped one
/// only its own and its children's.
#[derive(Debug)]
pub struct AgentSessions;
impl Command for AgentSessions {
    const ID: &'static str = "runtime.agent.sessions";
    const READ_ONLY: bool = true;
    const TASK_ARGS: &'static [&'static str] = &["session"];
    const READS_ANY_TASK: bool = true;
    type Args = AgentSessionsArgs;
    fn args_ts() -> Option<String> {
        Some(format!("{}{}", <AgentSessionsArgs as ::ts_rs::TS>::docs().unwrap_or_default(), <AgentSessionsArgs as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
    }
    type Out = AgentText;
}

/// `wisp_session`: one task in words, readable like `AgentSessions`.
#[derive(Debug)]
pub struct AgentSession;
impl Command for AgentSession {
    const ID: &'static str = "runtime.agent.session";
    const READ_ONLY: bool = true;
    const TASK_ARGS: &'static [&'static str] = &["session", "of"];
    const READS_ANY_TASK: bool = true;
    type Args = AgentSessionArgs;
    fn args_ts() -> Option<String> {
        Some(format!("{}{}", <AgentSessionArgs as ::ts_rs::TS>::docs().unwrap_or_default(), <AgentSessionArgs as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
    }
    type Out = AgentText;
}
