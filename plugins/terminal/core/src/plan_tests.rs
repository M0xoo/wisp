//! v1 test/terminal.test.js, 1:1, plus the TS port's apps.test.ts: "Take over" command lines for
//! every terminal app on every platform, built without launching anything.

use super::*;
use crate::apps::tests::Fake;
use crate::apps::{DARWIN, LINUX, WIN32};

const CWD: &str = "/home/me/my project";
const WCWD: &str = "C:\\Users\\me\\my project";

fn argv() -> Vec<String> {
    ["codex", "resume", "it's-1"].map(str::to_owned).to_vec()
}

fn plan_in(f: &Fake, terminal: &str, platform: &str, cwd: &str, argv: &[String], custom: &str) -> Result<Vec<Step>, TerminalError> {
    f.with(platform, |l| terminal_plan(PlanArgs { cwd, argv, terminal, custom }, l))
}

fn plan(terminal: &str, platform: &str) -> Vec<Step> {
    plan_in(&Fake::new(&[]), terminal, platform, CWD, &argv(), "").unwrap_or_default()
}

fn first(steps: &[Step]) -> (String, Vec<String>, Option<String>, bool) {
    match steps.first() {
        Some(Step::Run { command, args, cwd, verbatim }) => (command.clone(), args.clone(), cwd.clone(), *verbatim),
        other => panic!("not a command step: {other:?}"),
    }
}

fn osa(step: Option<&Step>) -> String {
    match step {
        Some(Step::Osa(s)) => s.clone(),
        other => panic!("not an AppleScript step: {other:?}"),
    }
}

#[test]
fn cmux_opens_a_workspace_with_a_fallback() {
    let (command, args, cwd, _) = first(&plan("cmux", DARWIN));
    assert_eq!(command, "/bin/sh");
    assert_eq!(args[3], "/Applications/cmux.app/Contents/Resources/bin/cmux", "falls back to the bundled CLI");
    assert!(args[1].contains(r#""$1" new-workspace --cwd "$2" --command "$3""#));
    assert!(args[1].contains(r#"|| { open -a cmux "$2""#));
    assert_eq!((args[4].as_str(), args[5].as_str()), (CWD, r"'codex' 'resume' 'it'\''s-1'"));
    assert!(args[6].starts_with("tell application \"System Events\" to keystroke \"") && args[6].ends_with("\" & return"));
    assert_eq!(cwd.as_deref(), Some(CWD));
    let mut has = Fake::new(&[]);
    has.has = vec!["cmux"];
    assert_eq!(first(&plan_in(&has, "cmux", DARWIN, CWD, &argv(), "").unwrap_or_default()).1[3], "cmux");
}

#[test]
fn macos_terminal_gets_a_quoted_cd_and_command() {
    let s = osa(plan("terminal", DARWIN).first());
    assert!(s.contains(r#"do script "cd '/home/me/my project' && 'codex' 'resume' 'it'\\''s-1'""#), "{s}");
    assert!(osa(plan("iterm", DARWIN).first()).contains("create window with default profile"));
}

#[test]
fn warp_opens_the_folder_waits_then_types() {
    let steps = plan("warp", DARWIN);
    assert_eq!(first(&steps).1, ["-a", "Warp", CWD]);
    assert_eq!(steps[1], Step::Delay(1200));
    assert!(osa(steps.get(2)).contains("keystroke"));
}

#[test]
fn linux_terminals_open_in_the_project_and_keep_a_shell() {
    for t in ["gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "ghostty", "xterm", "x-terminal-emulator"] {
        let (command, args, _, _) = first(&plan(t, LINUX));
        assert_eq!(command, t);
        assert!(args.join(" ").contains(CWD) || t == "xterm" || t == "x-terminal-emulator", "{t} gets the cwd");
        assert_eq!(&args[args.len() - 3..args.len() - 1], ["sh", "-c"]);
        assert_eq!(args.last().map(String::as_str), Some(r#"'codex' 'resume' 'it'\''s-1'; exec "${SHELL:-sh}""#));
    }
}

#[test]
fn macos_apps_get_the_command_itself() {
    let (command, args, _, _) = first(&plan("ghostty", DARWIN));
    assert_eq!((command.as_str(), &args[..3]), ("open", &["-na".to_owned(), "Ghostty".to_owned(), "--args".to_owned()][..]));
    assert_eq!(&args[args.len() - 3..], argv());
    assert_eq!(first(&plan("wezterm", DARWIN)).0, crate::apps::MACOS_WEZTERM);
    let (wc, wargs, wcwd, _) = first(&plan_in(&Fake::new(&[]), "wezterm", WIN32, WCWD, &argv(), "").unwrap_or_default());
    assert_eq!(
        (wc.as_str(), wargs.last().map(String::as_str), wcwd.as_deref()),
        ("wezterm", Some("& 'codex' 'resume' 'it''s-1'"), Some(WCWD))
    );
}

#[test]
fn windows_terminal_powershell_and_cmd() {
    let none = Fake::new(&[]);
    let (_, wt, cwd, _) = first(&plan_in(&none, "wt", WIN32, WCWD, &argv(), "").unwrap_or_default());
    assert_eq!(&wt[..5], ["-d", WCWD, "powershell.exe", "-NoExit", "-Command"]);
    assert_eq!(wt[5], "& 'codex' 'resume' 'it''s-1'");
    assert_eq!(cwd.as_deref(), Some(WCWD));
    let (pc, pa, pcwd, _) = first(&plan_in(&none, "powershell", WIN32, WCWD, &argv(), "").unwrap_or_default());
    assert_eq!(
        (pc.as_str(), pa),
        ("powershell.exe", vec!["-NoExit".to_owned(), "-Command".to_owned(), "& 'codex' 'resume' 'it''s-1'".to_owned()])
    );
    assert!(pcwd.is_some(), "detached into the folder: its own console window");
    let comspec = Fake::new(&[("ComSpec", "C:\\Windows\\system32\\cmd.exe")]);
    let (cc, ca, _, verbatim) = first(&plan_in(&comspec, "cmd", WIN32, WCWD, &argv(), "").unwrap_or_default());
    assert_eq!(cc, "C:\\Windows\\system32\\cmd.exe");
    assert!(verbatim);
    assert_eq!(&ca[..3], ["/d", "/s", "/k"]);
    assert_eq!(first(&plan_in(&none, "cmd", WIN32, WCWD, &argv(), "").unwrap_or_default()).0, "cmd.exe");
}

#[test]
fn wt_escapes_semicolons() {
    let a = ["x", "a;b"].map(str::to_owned);
    let (_, args, _, _) = first(&plan_in(&Fake::new(&[]), "wt", WIN32, "C:\\p", &a, "").unwrap_or_default());
    assert_eq!(args.last().map(String::as_str), Some(r"& 'x' 'a\;b'"));
}

#[test]
fn custom_fills_placeholders_per_platform() {
    let none = Fake::new(&[]);
    let (c, a, _, _) = first(&plan_in(&none, "custom", LINUX, CWD, &argv(), "foot -D {cwd} {cmd}").unwrap_or_default());
    assert_eq!((c.as_str(), a[0].as_str()), ("sh", "-c"));
    assert_eq!(a[1], r"foot -D '/home/me/my project' 'codex' 'resume' 'it'\''s-1'");
    let (_, line, _, _) = first(&plan_in(&none, "custom", LINUX, CWD, &argv(), "x -e sh -c {line}").unwrap_or_default());
    assert!(line[1].starts_with("x -e sh -c 'cd '\\''/home/me/my project'\\'' && "));
    let (_, w, _, verbatim) =
        first(&plan_in(&none, "custom", WIN32, "C:\\p", &argv(), "alacritty --working-directory {cwd} -e {cmd}").unwrap_or_default());
    assert!(verbatim && w[3].starts_with("\"alacritty --working-directory \"C:\\p\" -e codex "));
    let missing = plan_in(&none, "custom", LINUX, CWD, &argv(), "");
    assert!(matches!(missing, Err(TerminalError::NoCustom(m)) if m.contains("custom terminal command")));
    assert!(matches!(plan_in(&none, "wisp", LINUX, CWD, &argv(), ""), Err(TerminalError::InWisp)));
}

#[test]
fn auto_uses_the_detected_app() {
    assert_eq!(osa(plan("auto", DARWIN).first()), osa(plan("terminal", DARWIN).first()));
    assert_eq!(first(&plan("auto", LINUX)).0, "xterm");
}

// TS apps.test "openInTerminal: steps run in order through proc, delays wait" (the schedule half; the
// spawning and a missing app being swallowed are the host's).
#[test]
fn a_schedule_adds_delays_and_runs_applescript_through_osascript() {
    let steps = vec![
        Step::Run { command: "open".into(), args: vec!["-a".into()], cwd: None, verbatim: false },
        Step::Delay(1200),
        Step::Osa("tell".into()),
        Step::Run { command: "missing".into(), args: vec![], cwd: Some("/q".into()), verbatim: true },
    ];
    let s = schedule(&steps, "/p");
    let got: Vec<(u64, &str, &str, bool)> = s.iter().map(|l| (l.after_ms, l.bin.as_str(), l.cwd.as_str(), l.verbatim)).collect();
    assert_eq!(got, [(0, "open", "/p", false), (1200, "osascript", "/p", false), (1200, "missing", "/q", true)]);
    assert_eq!(s[1].args, ["-e", "tell"]);
}
