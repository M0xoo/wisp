//! The TypeScript side of the wire types, made with ts-rs (ADR-0013: wire types come from Rust).
//!
//! One file, in protocol order, so it has no imports (`@wisp/protocol` resolves `.ts` extensions,
//! which ts-rs's per-type files don't write) and diffs read like the plan's §4.3 table. Large
//! integers are `number`: every seq fits in 2^53.

use ts_rs::{Config, TS};

use crate::{
    Ack, ClientMessage, CommandError, CommandRequest, CommandResponse, EntityOp, Hello, Mutate,
    Notice, Patch, PatchOp, PeerInfo, PeerPlugin, Reject, Resync, Row, Rows, ServerMessage,
    Snapshot, Sub, Topic, Unsub, Welcome, Window,
};

const HEADER: &str = "// Generated from crates/wisp-protocol by `cargo test -p wisp-protocol export_bindings` (ts-rs).\n// Do not edit: change the Rust types and run it again.\n";

fn decl<T: TS>(cfg: &Config, out: &mut String) {
    out.push('\n');
    if let Some(docs) = T::docs() {
        out.push_str(&docs);
    }
    out.push_str("export ");
    out.push_str(&T::decl(cfg));
    out.push('\n');
}

/// The whole of `packages/protocol/src/generated/protocol.ts`.
pub fn typescript() -> String {
    let cfg = Config::new().with_large_int("number");
    let mut out = String::from(HEADER);
    let c = &cfg;
    let o = &mut out;
    decl::<Topic>(c, o);
    decl::<PatchOp>(c, o);
    decl::<EntityOp>(c, o);
    decl::<Row>(c, o);
    decl::<PeerPlugin>(c, o);
    decl::<PeerInfo>(c, o);
    decl::<Hello>(c, o);
    decl::<Sub>(c, o);
    decl::<Unsub>(c, o);
    decl::<Window>(c, o);
    decl::<Mutate>(c, o);
    decl::<ClientMessage>(c, o);
    decl::<Welcome>(c, o);
    decl::<Snapshot>(c, o);
    decl::<Patch>(c, o);
    decl::<Rows>(c, o);
    decl::<Ack>(c, o);
    decl::<Reject>(c, o);
    decl::<Resync>(c, o);
    decl::<Notice>(c, o);
    decl::<ServerMessage>(c, o);
    decl::<CommandRequest>(c, o);
    decl::<CommandError>(c, o);
    decl::<CommandResponse>(c, o);
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    fn protocol_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src")
    }

    /// Writes the bindings. Under CI (`CI` set) it fails instead when the committed file differs,
    /// so a Rust change can't merge without its TypeScript.
    #[test]
    fn export_bindings() {
        let path = protocol_dir().join("generated/protocol.ts");
        let want = super::typescript();
        let have = std::fs::read_to_string(&path).unwrap_or_default();
        if have == want {
            return;
        }
        assert!(
            std::env::var_os("CI").is_none(),
            "{} is stale: run `cargo test -p wisp-protocol export_bindings` and commit it",
            path.display()
        );
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, want).unwrap();
    }

    #[test]
    fn the_typescript_proto_constants_match() {
        let index = std::fs::read_to_string(protocol_dir().join("index.ts")).unwrap();
        assert!(
            index.contains(&format!("export const PROTO = {};", crate::PROTO)),
            "PROTO differs in index.ts"
        );
        assert!(
            index.contains(&format!("export const PROTO_MIN = {};", crate::PROTO_MIN)),
            "PROTO_MIN differs in index.ts"
        );
    }

    #[test]
    fn every_type_is_declared_once_with_no_imports() {
        let ts = super::typescript();
        assert!(!ts.contains("import "), "{ts}");
        for name in [
            "Topic",
            "EntityOp",
            "Welcome",
            "ServerMessage",
            "ClientMessage",
            "CommandResponse",
        ] {
            assert_eq!(
                ts.matches(&format!("export type {name} =")).count(),
                1,
                "{name}"
            );
        }
        assert!(!ts.contains("bigint"));
    }
}
