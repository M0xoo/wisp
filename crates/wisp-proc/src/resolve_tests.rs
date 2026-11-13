#![allow(clippy::unwrap_used, reason = "a test")]
// v1 test/proc.test.js, ported. The Windows cases run everywhere against a fake file system.

use std::collections::BTreeMap;

use super::*;

/// v1 test/helpers.js npmCmdShim: what `npm install -g` writes for a node CLI.
fn npm_cmd_shim(rel: &str) -> String {
    let rel = rel.replace('/', "\\");
    format!(
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\{rel}\" %*\r\n"
    )
}

#[derive(Default)]
struct FakeFs(BTreeMap<String, String>);

impl FakeFs {
    fn with(mut self, path: &str, text: &str) -> Self {
        self.0.insert(path.to_lowercase(), text.to_owned());
        self
    }
}

impl Lookup for FakeFs {
    fn is_file(&self, path: &str) -> bool {
        self.0.contains_key(&path.to_lowercase())
    }
    fn is_exe(&self, path: &str) -> bool {
        self.is_file(path)
    }
    fn read(&self, path: &str) -> Option<String> {
        self.0.get(&path.to_lowercase()).cloned()
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

fn win_env(path: &str) -> Vec<(String, String)> {
    vec![("Path".into(), path.into()), ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into())]
}

#[test]
fn parse_cmd_shim_understands_npm_pnpm_style_and_native_binary_shims() {
    assert_eq!(
        parse_cmd_shim(&npm_cmd_shim("node_modules/@openai/codex/bin/codex.js")),
        Some(Shim::Script("node_modules\\@openai\\codex\\bin\\codex.js".into()))
    );
    assert_eq!(
        parse_cmd_shim("@\"%~dp0\\node.exe\"  \"%~dp0\\..\\opencode-ai\\bin\\opencode\" %*\r\n"),
        Some(Shim::Script("..\\opencode-ai\\bin\\opencode".into()))
    );
    assert_eq!(
        parse_cmd_shim("@ECHO off\r\n\"%dp0%\\node_modules\\tool\\bin\\tool.exe\"   %*\r\n"),
        Some(Shim::Exe("node_modules\\tool\\bin\\tool.exe".into()))
    );
    assert_eq!(parse_cmd_shim("@echo off\r\necho hello\r\n"), None);
    assert_eq!(parse_cmd_shim("\"C:\\elsewhere\\x.exe\" %*"), None, "only targets relative to the shim");
}

#[test]
fn escape_cmd_argument_matches_cross_spawn() {
    // Expected values produced by cross-spawn@7 lib/util/escape.js.
    assert_eq!(escape_cmd_argument("plain", false), "^\"plain^\"");
    assert_eq!(escape_cmd_argument("a \"b\" & c", false), "^\"a^ \\^\"b\\^\"^ ^&^ c^\"");
    assert_eq!(escape_cmd_argument("trail\\", false), "^\"trail\\\\^\"");
    assert_eq!(escape_cmd_argument("%PATH%!", true), "^^^\"^^^%PATH^^^%^^^!^^^\"");
    assert_eq!(escape_cmd_command("C:\\a b\\x.bat"), "C:\\a^ b\\x.bat");
}

#[test]
fn resolve_command_is_a_pass_through_off_windows() {
    let r = resolve_command("codex", &s(&["exec", "--json"]), &[], Platform::Unix, &FakeFs::default());
    assert_eq!(r, Resolved { command: "codex".into(), args: s(&["exec", "--json"]), verbatim: false });
}

// Arguments wisp really passes: JSON, TOML, Windows paths, spaces, quotes, cmd metacharacters.
const NASTY: &[&str] = &[
    "exec",
    "-c",
    "mcp_servers.wisp.env={WISP_URL=\"http://127.0.0.1:4477\",X=\"a b\"}",
    "C:\\Program Files\\x\\",
    "say \"hi\" & echo pwned | more",
    "100%",
    "^caret^",
    "(parens)",
    "",
];

#[test]
fn windows_npm_cmd_shims_are_unwrapped_to_node_script_arguments_intact() {
    let fs = FakeFs::default()
        .with("C:\\shim\\echoer.cmd", &npm_cmd_shim("node_modules/echo/echo.js"))
        .with("C:\\shim\\node_modules\\echo\\echo.js", "")
        .with("C:\\node\\node.exe", "");
    let r = resolve_command("echoer", &s(NASTY), &win_env("C:\\shim;C:\\node"), Platform::Windows, &fs);
    assert_eq!(r.command, "C:\\node\\node.exe");
    assert!(!r.verbatim);
    assert_eq!(r.args[0], "C:\\shim\\node_modules\\echo\\echo.js");
    assert_eq!(&r.args[1..], &s(NASTY)[..], "arguments go through untouched");
}

#[test]
fn windows_a_node_exe_beside_the_shim_wins() {
    let fs = FakeFs::default()
        .with("C:\\shim\\oc.cmd", "@\"%~dp0\\node.exe\"  \"%~dp0\\..\\opencode-ai\\bin\\opencode\" %*\r\n")
        .with("C:\\opencode-ai\\bin\\opencode", "")
        .with("C:\\shim\\node.exe", "");
    let r = resolve_command("oc", &[], &win_env("C:\\shim"), Platform::Windows, &fs);
    assert_eq!((r.command.as_str(), r.args[0].as_str()), ("C:\\shim\\node.exe", "C:\\opencode-ai\\bin\\opencode"));
}

#[test]
fn windows_exe_shims_run_the_exe() {
    let fs = FakeFs::default()
        .with("C:\\b\\tool.cmd", "@ECHO off\r\n\"%dp0%\\node_modules\\tool\\bin\\tool.exe\"   %*\r\n")
        .with("C:\\b\\node_modules\\tool\\bin\\tool.exe", "");
    let r = resolve_command("tool", &s(&["x"]), &win_env("C:\\b"), Platform::Windows, &fs);
    assert_eq!(r, Resolved { command: "C:\\b\\node_modules\\tool\\bin\\tool.exe".into(), args: s(&["x"]), verbatim: false });
}

#[test]
fn windows_unknown_bat_files_go_through_cmd_exe_with_escaping() {
    let fs = FakeFs::default().with("C:\\bat\\plainbat.bat", "@echo off\r\n\"C:\\node.exe\" \"C:\\echo.js\" %*\r\n");
    let mut env = win_env("C:\\bat");
    env.push(("ComSpec".into(), "C:\\Windows\\system32\\cmd.exe".into()));
    let r = resolve_command("plainbat", &s(&["a b", "line1\nline2"]), &env, Platform::Windows, &fs);
    assert!(r.verbatim);
    assert_eq!(r.command, "C:\\Windows\\system32\\cmd.exe");
    assert_eq!(&r.args[..3], &s(&["/d", "/s", "/c"])[..]);
    assert_eq!(
        r.args[3],
        format!("\"C:\\bat\\plainbat.bat {} {}\"", escape_cmd_argument("a b", true), escape_cmd_argument("line1 line2", true)),
        "newlines can't survive cmd's parser"
    );
}

#[test]
fn windows_ps1_only_installs_run_through_powershell() {
    let fs = FakeFs::default().with("C:\\ps\\psonly.ps1", "");
    let r = resolve_command("psonly", &s(&["--resume", "abc-123", "two words"]), &win_env("C:\\ps"), Platform::Windows, &fs);
    assert_eq!(r.command, "powershell.exe");
    assert_eq!(
        r.args,
        s(&["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ps\\psonly.ps1", "--resume", "abc-123", "two words"])
    );
}

#[test]
fn windows_which_follows_pathext_and_case_insensitive_path() {
    let fs = FakeFs::default().with("C:\\a\\claude.exe", "").with("C:\\b\\claude.cmd", "");
    assert_eq!(which("claude", &win_env("C:\\a;C:\\b"), Platform::Windows, &fs).as_deref(), Some("C:\\a\\claude.exe"));
    assert_eq!(which("claude.cmd", &win_env("C:\\a;C:\\b"), Platform::Windows, &fs).as_deref(), Some("C:\\b\\claude.cmd"));
    assert_eq!(which("missing", &win_env("C:\\a"), Platform::Windows, &fs), None);
    // a missing program is left for the spawn to report
    assert_eq!(resolve_command("missing", &[], &win_env("C:\\a"), Platform::Windows, &fs).command, "missing");
}

#[test]
fn unix_which_walks_path_and_takes_paths_as_they_are() {
    let fs = FakeFs::default().with("/usr/bin/git", "").with("/opt/x/tool", "");
    let env = vec![("PATH".to_owned(), "/nope::/usr/bin/".to_owned())];
    assert_eq!(which("git", &env, Platform::Unix, &fs).as_deref(), Some("/usr/bin/git"));
    assert_eq!(which("/opt/x/tool", &env, Platform::Unix, &fs).as_deref(), Some("/opt/x/tool"));
    assert_eq!(which("tool", &env, Platform::Unix, &fs), None);
}

#[test]
fn escaping_never_loses_a_character_property() {
    // Every input char survives (in order) once the carets are taken out: a cheap model check.
    let samples = ["", "a", "\"", "\\", "\\\"", "a\\\\b\"c", "%^&|<>()!,; *?`[]", "ü 日本 \t"];
    for x in samples {
        let e = escape_cmd_argument(x, false);
        let mut uncaret = String::new();
        let mut it = e.chars().peekable();
        while let Some(c) = it.next() {
            if c == '^' {
                if let Some(n) = it.next() {
                    uncaret.push(n);
                }
            } else {
                uncaret.push(c);
            }
        }
        let kept: String = uncaret.chars().filter(|c| *c != '"' && *c != '\\').collect();
        let want: String = x.chars().filter(|c| *c != '"' && *c != '\\').collect();
        assert_eq!(kept, want, "{x:?} → {e:?}");
    }
}
