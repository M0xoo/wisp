//! v1's event stream, for v1 clients (the v1 web app, and v1 wisps relaying this one with
//! `x-wisp-relay: 1`). v1 broadcast every named event to every stream (server/http/respond.js):
//! `event: hello` on open, then `event: <name>\ndata: <json>` per broadcast and `ping` every 25 s.
//! The names are fixed here so a typo can't open a stream nobody reads; the payloads are the v1
//! shapes the plugins' route adapters already build.

macro_rules! v1_events {
    ($($variant:ident = $name:literal),* $(,)?) => {
        /// Every event name v1's server broadcast.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum V1Event { $($variant),* }

        impl V1Event {
            pub const ALL: &'static [V1Event] = &[$(V1Event::$variant),*];

            /// The SSE `event:` name.
            pub fn name(self) -> &'static str {
                match self { $(V1Event::$variant => $name),* }
            }

            pub fn from_name(name: &str) -> Option<Self> {
                match name { $($name => Some(V1Event::$variant),)* _ => None }
            }
        }
    };
}

v1_events! {
    Activity = "activity",
    AgentLogin = "agent-login",
    Agents = "agents",
    Cloud = "cloud",
    Computer = "computer",
    Config = "config",
    Connectors = "connectors",
    Finished = "finished",
    Load = "load",
    Machines = "machines",
    Ping = "ping",
    Preferences = "preferences",
    Reminder = "reminder",
    Remote = "remote",
    Removed = "removed",
    Router = "router",
    Sandbox = "sandbox",
    SandboxStep = "sandbox-step",
    Spell = "spell",
    Stuff = "stuff",
    Summary = "summary",
    Turn = "turn",
    Update = "update",
}

/// What v1 wrote first on every stream.
pub const V1_HELLO: &str = "event: hello\ndata: {}\n\n";

/// One v1 event: `data_json` is already JSON (one line: `serde_json` escapes CR and LF).
pub fn v1_frame(event: V1Event, data_json: &str) -> String {
    let name = event.name();
    let mut s = String::with_capacity(name.len() + data_json.len() + 16);
    s.push_str("event: ");
    s.push_str(name);
    s.push_str("\ndata: ");
    s.push_str(data_json);
    s.push_str("\n\n");
    s
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_frames_match_v1() {
        for e in V1Event::ALL {
            assert_eq!(V1Event::from_name(e.name()), Some(*e));
        }
        assert_eq!(V1Event::from_name("bogus"), None);
        assert_eq!(v1_frame(V1Event::Ping, "{}"), "event: ping\ndata: {}\n\n");
    }
}
