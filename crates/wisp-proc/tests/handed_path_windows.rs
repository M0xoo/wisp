//! ADR-0057 on Windows: the environment spells it `Path`, and the desktop app never hands one over there, so
//! `set_path` is a no-op: a handed `PATH` would be a second variable beside `Path`. Its own test binary, since the
//! PATH is the process's.
#![cfg(windows)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test: failing loudly is the point")]

#[test]
fn set_path_is_a_no_op_on_windows_so_no_second_path_variable_appears() {
    let before = wisp_proc::vars();
    let searched = wisp_proc::search_path();
    wisp_proc::set_path(r"C:\wisp-handed\bin");
    assert_eq!(wisp_proc::search_path(), searched, "still the inherited Path");
    let after = wisp_proc::vars();
    assert_eq!(after, before, "no PATH beside Path");
    assert!(after.iter().filter(|(k, _)| k.eq_ignore_ascii_case("PATH")).count() <= 1);
}
