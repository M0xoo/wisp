//! `wisp_proc::vars()`: this process's variables with the PATH the desktop app handed over (ADR-0057), for code
//! that reads the environment itself. Its own test binary, since the PATH is the process's.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test: failing loudly is the point")]

#[test]
fn vars_holds_the_handed_over_path_once_and_every_other_variable() {
    let before = wisp_proc::vars();
    assert_eq!(before.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()), std::env::var("PATH").ok(), "inherited until handed");
    wisp_proc::set_path("/wisp-handed-vars/bin:/usr/bin:/bin");
    let after = wisp_proc::vars();
    let paths: Vec<&str> = after.iter().filter(|(k, _)| k == "PATH").map(|(_, v)| v.as_str()).collect();
    assert_eq!(paths, ["/wisp-handed-vars/bin:/usr/bin:/bin"], "one PATH, the handed one");
    assert_eq!(after.len(), before.len() + usize::from(!before.iter().any(|(k, _)| k == "PATH")));
    assert!(before.iter().filter(|(k, _)| k != "PATH").all(|kv| after.contains(kv)), "nothing else changes");
}
