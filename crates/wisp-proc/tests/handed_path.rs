//! The PATH the desktop app hands its server after start (F-desk-5): its own test binary, since the PATH is the
//! process's.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test: failing loudly is the point")]

mod common;

use common::args;
use wisp_proc::{Env, ExecOpts};

// A CLI the login shell's PATH has and the inherited one hasn't: found and started once the PATH is handed over,
// and the agent it starts sees that PATH too. A caller's own PATH still wins.
#[tokio::test]
async fn a_handed_over_path_finds_and_starts_a_cli_the_inherited_one_misses() {
    let dir = std::env::temp_dir().join(format!("wisp-handed-path-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let tool = dir.join("wisp-handed-tool");
    let wrote = std::process::Command::new("/bin/sh")
        .args(["-c", "printf '#!/bin/sh\\necho \"tool on $PATH\"\\n' > \"$1\" && chmod 755 \"$1\"", "sh"])
        .arg(&tool)
        .status()
        .unwrap();
    assert!(wrote.success());
    let proc = wisp_proc::local();
    assert_eq!(proc.which("wisp-handed-tool", None).await, None, "not on the inherited PATH");

    let path = format!("{}:/usr/bin:/bin", dir.display());
    wisp_proc::set_path(&path);
    assert_eq!(proc.which("wisp-handed-tool", None).await, Some(tool.clone()));
    let r = proc.exec("wisp-handed-tool", &[], ExecOpts::default()).await.unwrap();
    assert_eq!(String::from_utf8(r.stdout).unwrap().trim(), format!("tool on {path}"));
    // what any child sees, not only the one found on it
    let r = proc.exec("sh", &args(&["-c", "echo $PATH"]), ExecOpts::default()).await.unwrap();
    assert_eq!(String::from_utf8(r.stdout).unwrap().trim(), path);
    let own = ExecOpts { env: Env::default().with("PATH", "/usr/bin:/bin"), ..ExecOpts::default() };
    let r = proc.exec("sh", &args(&["-c", "echo $PATH"]), own).await.unwrap();
    assert_eq!(String::from_utf8(r.stdout).unwrap().trim(), "/usr/bin:/bin", "the caller's PATH, not the handed one");
    wisp_proc::set_path("");
    assert_eq!(proc.which("wisp-handed-tool", None).await, Some(tool), "an empty PATH is ignored");
    let _ = std::fs::remove_dir_all(&dir);
}
