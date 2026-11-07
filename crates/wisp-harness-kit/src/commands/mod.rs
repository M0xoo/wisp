//! describeCommand: a shell command as the ticker's sentence ("Running the tests", "Reading a.js").
//! The port of v1 `server/adapters/commands.js`; its parity corpus is `tests/commands.rs`.

use crate::paths::RunPaths;

/// What `command` does, in words, for the live ticker (v1 `describeCommand(command, cwd)`).
pub fn describe_command(command: &str, paths: &RunPaths) -> String {
    let _ = paths;
    crate::text::clip(&format!("Running {command}"), 80)
}
