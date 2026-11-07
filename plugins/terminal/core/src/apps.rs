//! Which terminal app a take over or "open in terminal" uses (v1 server/terminal.js): the list Settings
//! shows per platform, auto-detection, and when the page's own terminal is the one. Everything the
//! answers depend on (platform, environment, PATH, files) is passed in, so every platform is tested
//! anywhere.

use wisp_terminal_api::TerminalApp;

/// The platform names v1 used (`process.platform`); settings and tests speak them.
pub const DARWIN: &str = "darwin";
pub const WIN32: &str = "win32";
pub const LINUX: &str = "linux";

/// `std::env::consts::OS` as v1's platform name.
pub fn platform_name(os: &str) -> &'static str {
    match os {
        "macos" => DARWIN,
        "windows" => WIN32,
        _ => LINUX,
    }
}

/// What the answers depend on. `env` reads a variable (an empty one reads as unset, as v1's `||` did).
pub struct Lookups<'a> {
    pub platform: &'a str,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// is this program on PATH
    pub has: &'a dyn Fn(&str) -> bool,
    pub exists: &'a dyn Fn(&str) -> bool,
}

impl std::fmt::Debug for Lookups<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lookups").field("platform", &self.platform).finish_non_exhaustive()
    }
}

impl Lookups<'_> {
    pub fn var(&self, k: &str) -> Option<String> {
        (self.env)(k).filter(|v| !v.is_empty())
    }
}

/// (id, label, the platforms that list it: all when empty)
const ALL_TERMINALS: &[(&str, &str, &[&str])] = &[
    ("auto", "Auto-detect", &[]),
    ("wisp", "In wisp", &[DARWIN, LINUX]),
    ("terminal", "Terminal.app", &[DARWIN]),
    ("iterm", "iTerm", &[DARWIN]),
    ("warp", "Warp", &[DARWIN]),
    ("cmux", "cmux", &[DARWIN]),
    ("wt", "Windows Terminal", &[WIN32]),
    ("powershell", "PowerShell", &[WIN32]),
    ("cmd", "Command Prompt", &[WIN32]),
    ("ghostty", "Ghostty", &[DARWIN, LINUX]),
    ("kitty", "kitty", &[DARWIN, LINUX]),
    ("wezterm", "WezTerm", &[]),
    ("gnome-terminal", "GNOME Terminal", &[LINUX]),
    ("konsole", "Konsole", &[LINUX]),
    ("xfce4-terminal", "Xfce Terminal", &[LINUX]),
    ("alacritty", "Alacritty", &[LINUX]),
    ("xterm", "xterm", &[LINUX]),
    ("custom", "Custom command", &[]),
];

/// The terminals Settings lists on `platform` (any platform but macOS and Windows lists Linux's).
pub fn terminals_for(platform: &str) -> Vec<TerminalApp> {
    let p = if platform == DARWIN || platform == WIN32 { platform } else { LINUX };
    ALL_TERMINALS.iter().filter(|(_, _, os)| os.is_empty() || os.contains(&p)).map(|(id, label, _)| TerminalApp { id: (*id).to_owned(), label: (*label).to_owned() }).collect()
}

/// Settings on a wisp Grid box: only "In wisp" (there's no desktop to open an app on).
pub fn terminals_here(l: &Lookups<'_>) -> Vec<TerminalApp> {
    let all = terminals_for(l.platform);
    if l.var("WISP_GRID_URL").is_some() { all.into_iter().filter(|t| t.id == "wisp").collect() } else { all }
}

pub const CMUX_APP: &str = "/Applications/cmux.app";
pub const MACOS_WEZTERM: &str = "/Applications/WezTerm.app/Contents/MacOS/wezterm";
const LINUX_ORDER: &[&str] = &["ghostty", "kitty", "wezterm", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "x-terminal-emulator", "xterm"];

pub fn detect_terminal(l: &Lookups<'_>) -> String {
    let term = l.var("TERM_PROGRAM");
    let t = match l.platform {
        DARWIN => {
            if term.as_deref() == Some("iTerm.app") && (l.exists)("/Applications/iTerm.app") {
                "iterm"
            // cmux is built on Ghostty and reports TERM_PROGRAM=ghostty, so it is checked first
            } else if (l.var("CMUX_WORKSPACE_ID").is_some() || l.var("__CFBundleIdentifier").as_deref() == Some("com.cmuxterm.app")) && (l.exists)(CMUX_APP) {
                "cmux"
            } else if term.as_deref() == Some("ghostty") && (l.exists)("/Applications/Ghostty.app") {
                "ghostty"
            } else {
                "terminal"
            }
        }
        WIN32 => {
            if l.var("WT_SESSION").is_some() || (l.has)("wt") {
                "wt"
            } else {
                "powershell"
            }
        }
        _ => LINUX_ORDER.iter().copied().find(|t| (l.has)(t)).unwrap_or("xterm"),
    };
    t.to_owned()
}

/// Take over in the page by default where it can run one (no PTY on Windows).
pub fn default_terminal(platform: &str) -> &'static str {
    if platform == WIN32 { "auto" } else { "wisp" }
}

/// No desktop here to open an app on: a wisp Grid box, or a Linux reached over SSH.
fn headless(l: &Lookups<'_>) -> bool {
    l.var("WISP_GRID_URL").is_some() || (l.platform == LINUX && l.var("DISPLAY").is_none() && l.var("WAYLAND_DISPLAY").is_none())
}

/// In the page instead of an app: when asked to, or on auto where there's no desktop.
pub fn in_wisp(terminal: &str, l: &Lookups<'_>) -> bool {
    if l.platform == WIN32 {
        return false;
    }
    terminal == "wisp" || (terminal == "auto" && headless(l))
}

/// A terminal app can open only on a desktop someone sits at, and not for a page that reached this
/// wisp through the grid's edge or a machine's proxy.
pub fn app_here(l: &Lookups<'_>, via_proxy: bool) -> bool {
    !via_proxy && (l.platform == WIN32 || !in_wisp("auto", l))
}

/// Whether this computer can run a terminal for the page at all.
pub fn pty_supported(platform: &str) -> bool {
    platform != WIN32
}

/// The terminal a setting names, for a take over: unset is this platform's default.
pub fn chosen(setting: Option<&str>, platform: &str) -> String {
    setting.filter(|s| !s.is_empty()).unwrap_or(default_terminal(platform)).to_owned()
}

/// The terminal "open in terminal" uses: "In wisp" is the panel itself, so it reads as auto.
pub fn chosen_app(setting: Option<&str>) -> String {
    match setting {
        None | Some("" | "wisp") => "auto".to_owned(),
        Some(t) => t.to_owned(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    pub(crate) struct Fake {
        pub env: HashMap<String, String>,
        pub has: Vec<&'static str>,
        pub exists: bool,
    }

    impl Fake {
        pub fn new(env: &[(&str, &str)]) -> Self {
            Self { env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(), has: Vec::new(), exists: false }
        }
        pub fn with<R>(&self, platform: &str, f: impl FnOnce(&Lookups<'_>) -> R) -> R {
            let env = |k: &str| self.env.get(k).cloned();
            let has = |b: &str| self.has.contains(&b);
            let exists = |_: &str| self.exists;
            f(&Lookups { platform, env: &env, has: &has, exists: &exists })
        }
    }

    // v1 test/pty.test.js "inWisp: asked for, or auto where there is no desktop", 1:1.
    #[test]
    fn in_wisp_asked_for_or_auto_without_a_desktop() {
        let none = Fake::new(&[]);
        assert!(none.with(DARWIN, |l| in_wisp("wisp", l)));
        assert!(!none.with(DARWIN, |l| in_wisp("auto", l)));
        assert!(!Fake::new(&[("DISPLAY", ":0")]).with(LINUX, |l| in_wisp("auto", l)));
        assert!(none.with(LINUX, |l| in_wisp("auto", l)));
        assert!(Fake::new(&[("DISPLAY", ":0"), ("WISP_GRID_URL", "https://grid.example")]).with(LINUX, |l| in_wisp("auto", l)));
        assert!(!none.with(LINUX, |l| in_wisp("iterm", l)));
        assert!(!none.with(WIN32, |l| in_wisp("wisp", l)), "no pty on Windows");
        assert!(terminals_for(LINUX).iter().any(|t| t.id == "wisp") && !terminals_for(WIN32).iter().any(|t| t.id == "wisp"));
    }

    // v1 "defaultTerminal: in wisp unless the computer has no pty (Windows)", 1:1.
    #[test]
    fn default_terminal_in_wisp_unless_windows() {
        assert_eq!((default_terminal(DARWIN), default_terminal(LINUX), default_terminal(WIN32)), ("wisp", "wisp", "auto"));
        assert!(Fake::new(&[]).with(DARWIN, |l| in_wisp(default_terminal(DARWIN), l)));
        assert_eq!(chosen(None, WIN32), "auto");
        assert_eq!(chosen(Some("iterm"), DARWIN), "iterm");
        assert_eq!((chosen_app(Some("wisp")), chosen_app(None), chosen_app(Some("kitty"))), ("auto".into(), "auto".into(), "kitty".into()));
    }

    // v1 test/terminal.test.js "each platform only lists terminals it can run", 1:1.
    #[test]
    fn each_platform_lists_only_what_it_can_run() {
        let ids = |p: &str| terminals_for(p).into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert!(ids(DARWIN).contains(&"iterm".into()) && !ids(DARWIN).contains(&"wt".into()));
        assert!(ids(WIN32).contains(&"wt".into()) && ids(WIN32).contains(&"powershell".into()) && !ids(WIN32).contains(&"terminal".into()));
        assert!(ids(LINUX).contains(&"gnome-terminal".into()) && !ids(LINUX).contains(&"iterm".into()) && !ids(LINUX).contains(&"wt".into()));
        assert_eq!(ids("freebsd"), ids(LINUX));
        for p in [DARWIN, WIN32, LINUX] {
            let l = ids(p);
            assert_eq!((l.first().map(String::as_str), l.last().map(String::as_str)), (Some("auto"), Some("custom")));
        }
        let grid = Fake::new(&[("WISP_GRID_URL", "https://g")]);
        assert_eq!(grid.with(LINUX, |l| terminals_here(l)).len(), 1, "a Grid box: only In wisp (v1 settings.js)");
    }

    // v1 "auto-detect", 1:1.
    #[test]
    fn auto_detect() {
        assert_eq!(Fake::new(&[]).with(DARWIN, detect_terminal), "terminal");
        let mut iterm = Fake::new(&[("TERM_PROGRAM", "iTerm.app")]);
        iterm.exists = true;
        assert_eq!(iterm.with(DARWIN, detect_terminal), "iterm");
        let mut wt = Fake::new(&[]);
        wt.has = vec!["wt"];
        assert_eq!(wt.with(WIN32, detect_terminal), "wt");
        assert_eq!(Fake::new(&[("WT_SESSION", "1")]).with(WIN32, detect_terminal), "wt");
        assert_eq!(Fake::new(&[]).with(WIN32, detect_terminal), "powershell");
        let mut k = Fake::new(&[]);
        k.has = vec!["konsole", "xterm"];
        assert_eq!(k.with(LINUX, detect_terminal), "konsole");
        assert_eq!(Fake::new(&[]).with(LINUX, detect_terminal), "xterm");
    }

    // v1 "cmux: detected inside cmux (before Ghostty)" (the detection half; the plan half is plan.rs).
    #[test]
    fn cmux_is_detected_before_ghostty() {
        let env = [("TERM_PROGRAM", "ghostty"), ("CMUX_WORKSPACE_ID", "abc")];
        let mut f = Fake::new(&env);
        f.exists = true;
        assert_eq!(f.with(DARWIN, detect_terminal), "cmux");
        let only_ghostty = |p: &str| p != CMUX_APP;
        let e = |k: &str| env.iter().find(|(x, _)| *x == k).map(|(_, v)| (*v).to_owned());
        let l = Lookups { platform: DARWIN, env: &e, has: &|_| false, exists: &only_ghostty };
        assert_eq!(detect_terminal(&l), "ghostty");
        assert!(terminals_for(DARWIN).iter().any(|t| t.id == "cmux") && !terminals_for(LINUX).iter().any(|t| t.id == "cmux"));
    }

    // TS plugin.test "open-shell ... never through the grid's edge" (the appHere half).
    #[test]
    fn a_terminal_app_only_on_a_desktop_and_never_through_a_proxy() {
        let none = Fake::new(&[]);
        assert!(!none.with(LINUX, |l| app_here(l, false)), "a headless Linux has none");
        assert!(none.with(WIN32, |l| app_here(l, false)));
        assert!(none.with(DARWIN, |l| app_here(l, false)));
        assert!(!none.with(DARWIN, |l| app_here(l, true)), "through the grid's edge");
        assert!(!Fake::new(&[("WISP_GRID_URL", "x")]).with(DARWIN, |l| app_here(l, false)));
        assert!(pty_supported(DARWIN) && !pty_supported(WIN32));
        assert_eq!((platform_name("macos"), platform_name("windows"), platform_name("linux")), (DARWIN, WIN32, LINUX));
    }
}
