#![allow(clippy::unwrap_used, clippy::assert_is_empty)]

use std::collections::HashMap;

use super::*;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

#[test]
fn tmux_capture_takes_the_last_n_lines_of_this_pane() {
    let e = env(&[("TMUX", "/tmp/tmux-501/default,1,0"), ("TMUX_PANE", "%3")]);
    let a = read_argv("tmux", &e, 120).unwrap();
    assert_eq!(a, ["tmux", "capture-pane", "-p", "-J", "-S", "-120", "-t", "%3"]);
    let captured =
        "\u{1b}[32m$ cargo test\u{1b}[0m\nerror[E0308]: mismatched types\n  --> src/lib.rs:3:5\nprogress 10%\rprogress 100%\n\n\n";
    assert_eq!(
        tail(captured, 3),
        "error[E0308]: mismatched types\n  --> src/lib.rs:3:5\nprogress 100%",
        "escapes, overwrites and blank lines at the end go"
    );
    assert_eq!(tail("a\nb\nc", 2), "b\nc");
    assert_eq!(strip_ansi("\u{1b}]633;A\u{7}ls\u{1b}]0;title\u{1b}\\"), "ls", "OSC marks (VS Code's, titles) go too");
}

#[test]
fn a_terminal_without_its_api_is_skipped_not_an_error() {
    // kitty without remote control: no KITTY_LISTEN_ON, so not a source here
    assert!(read_argv("kitty", &env(&[("KITTY_WINDOW_ID", "1")]), 10).is_none());
    assert!(read_argv("kitty", &env(&[("KITTY_WINDOW_ID", "1"), ("KITTY_LISTEN_ON", "unix:/tmp/k")]), 10).is_some());
    assert!(read_argv("wezterm", &env(&[]), 10).is_none());
    assert!(read_argv("apple-terminal", &env(&[("TERM_PROGRAM", "iTerm.app")]), 10).is_none());
    assert!(read_argv("tmux", &env(&[]), 10).is_none());
    assert!(read_argv("telepathy", &env(&[("TMUX", "x")]), 10).is_none());
    let none = TermContext { cwd: "/w/api".into(), ..TermContext::default() };
    assert_eq!(none.summary(), "the folder /w/api", "nothing read: no source named");
}

#[test]
fn never_reruns_a_command_to_get_its_output() {
    let e = env(&[
        ("TMUX", "x"),
        ("WEZTERM_PANE", "1"),
        ("KITTY_WINDOW_ID", "1"),
        ("KITTY_PID", "9"),
        ("ITERM_SESSION_ID", "w0t0p0:ABC"),
        ("TERM_PROGRAM", "Apple_Terminal"),
    ]);
    let readers = ["tmux", "wezterm", "kitty", "osascript"];
    for s in SOURCES {
        let a = read_argv(s.id, &e, 50).unwrap();
        assert!(readers.contains(&a[0].as_str()), "{}: {a:?}", s.id);
        assert!(!a.iter().any(|x| x.contains("cargo test")), "never the user's command");
    }
    let ctx = TermContext {
        cwd: "/w".into(),
        commands: vec![Cmd { cmd: "cargo test".into(), exit: Some(101), cwd: "/w".into(), ..Cmd::default() }],
        ..TermContext::default()
    };
    let b = ctx.block();
    assert!(b.contains("couldn't be read") && b.contains("never runs a command again") && b.contains("`cargo test`  → exit 101"), "{b}");
    assert_eq!(ctx.failing().map(|c| c.exit), Some(Some(101)));
}

#[test]
fn shell_hook_log_parses_and_drops_week_old_lines() {
    let now = 1_800_000_000_000;
    let log = format!(
        "{{\"cmd\":\"cargo test\",\"cwd\":\"/w\",\"exit\":101,\"ms\":4200,\"at\":{}}}\nnot json\n{{\"cmd\":\"old\",\"cwd\":\"/w\",\"exit\":0,\"at\":{}}}\n{{\"cmd\":\"echo \\\"hi\\\"\\nthere\",\"cwd\":\"/w\",\"exit\":0,\"at\":{}}}\n",
        now - 1000,
        now - KEEP_MS - 1,
        now - 10
    );
    let cmds = parse_log(&log, now);
    assert_eq!(cmds.iter().map(|c| c.cmd.as_str()).collect::<Vec<_>>(), ["cargo test", "echo \"hi\"\nthere"]);
    assert_eq!((cmds[0].exit, cmds[0].ms), (Some(101), Some(4200)));
}

#[test]
fn history_files_of_zsh_bash_fish_read_their_last_commands() {
    let zsh = ": 1700000000:0;cd api\n: 1700000005:2;cargo build \\\n--release\n: 1700000010:0;git status\n";
    let z = history_tail("zsh", zsh, 2);
    assert_eq!(z.iter().map(|c| c.cmd.as_str()).collect::<Vec<_>>(), ["cargo build \n--release", "git status"]);
    assert_eq!(z[1].at, 1_700_000_010_000);
    let bash = "#1700000000\nls\nmake test\n";
    assert_eq!(history_tail("bash", bash, 5).iter().map(|c| c.cmd.as_str()).collect::<Vec<_>>(), ["ls", "make test"]);
    let fish = "- cmd: npm test\n  when: 1700000000\n- cmd: echo a\\nb\n  when: 1700000009\n";
    let f = history_tail("fish", fish, 5);
    assert_eq!((f[0].cmd.as_str(), f[0].at, f[1].cmd.as_str()), ("npm test", 1_700_000_000_000, "echo a\nb"));
}

#[test]
fn prompt_about_what_is_above_attaches_context() {
    for p in ["check the error above", "why did what I just ran fail?", "fix that error", "Explain the output"] {
        assert!(wants_context(p), "{p}");
    }
    for p in ["add a dark mode", "review the PR"] {
        assert!(!wants_context(p), "{p}");
    }
}

#[test]
fn context_summary_says_what_was_attached() {
    let ctx = TermContext {
        cwd: "/w".into(),
        branch: "main".into(),
        commands: vec![Cmd::default(); 3],
        source: "tmux".into(),
        output: vec!["x"; 120].join("\n"),
        ..TermContext::default()
    };
    assert_eq!(ctx.summary(), "3 commands, 120 lines from tmux, git status");
    let one = TermContext { commands: vec![Cmd::default()], source: "iterm2".into(), output: "x".into(), ..TermContext::default() };
    assert_eq!(one.summary(), "1 command, 1 line from iTerm2");
    assert!(ctx.block().contains("from tmux") && ctx.block().contains("on branch `main`"));
}

#[test]
fn terminal_failed_fires_once_per_failed_command() {
    let log = vec![
        Cmd { cmd: "ls".into(), exit: Some(0), at: 10, ..Cmd::default() },
        Cmd { cmd: "cargo test".into(), cwd: "/w".into(), exit: Some(101), at: 20, ..Cmd::default() },
    ];
    let (first, c) = failed_since(&log, &Value::Null, "ttys003");
    assert!(first.is_empty(), "the first read only sets the cursor");
    let mut more = log.clone();
    more.push(Cmd { cmd: "make".into(), cwd: "/w".into(), exit: Some(2), at: 30, ..Cmd::default() });
    more.push(Cmd { cmd: "echo ok".into(), exit: Some(0), at: 40, ..Cmd::default() });
    let (evs, c2) = failed_since(&more, &c, "ttys003");
    assert_eq!(evs.len(), 1, "make failed; echo didn't; cargo test was before the cursor");
    assert_eq!((evs[0]["key"].as_str(), evs[0]["payload"]["exit"].as_i64()), (Some("term:ttys003:30"), Some(2)));
    assert!(failed_since(&more, &c2, "ttys003").0.is_empty(), "seen once");
    // another terminal has a cursor of its own
    let (other, _) = failed_since(&more, &c2, "ttys009");
    assert!(other.is_empty());
}

#[test]
fn shell_hook_writes_a_private_file() {
    for sh in ["zsh", "bash"] {
        let s = hook_script(sh).unwrap();
        assert!(s.contains("umask 077") && s.contains("/term") && s.contains(".jsonl"), "{sh}");
        let code: String = s.lines().filter(|l| !l.trim_start().starts_with('#')).collect::<Vec<_>>().join("\n");
        assert!(!code.contains("curl") && !code.contains("wisp "), "{sh}: it records, nothing else (no network, no wisp call per prompt)");
    }
    assert!(hook_script("fish").unwrap().contains("chmod 600"));
    assert!(hook_script("powershell").is_none());
}
