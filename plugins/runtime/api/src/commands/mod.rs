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
            type Args = $args;
            type Out = $out;
        }
    };
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
