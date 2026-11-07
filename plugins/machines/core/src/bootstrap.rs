//! The script that starts wisp on a machine over `ssh … sh -s` (v1 `server/machines/bootstrap.js`),
//! now installing wisp's own binary instead of Node. The script is `bootstrap.sh` beside this
//! crate's Cargo.toml: plain POSIX shell with `__FIELDS__`, so the phone app loads the same file.
//! This module fills it in and reads the `@@wisp` lines it prints back.
use wisp_machines_api::StepStatus;

use crate::shell::shq;

pub const TEMPLATE: &str = include_str!("../bootstrap.sh");

pub const SSH: &str = "ssh";
pub const INSTALL: &str = "install";
pub const WISP: &str = "wisp";
pub const TUNNEL: &str = "tunnel";
pub const AGENTS: &str = "agents";

/// The steps a connection goes through, as the script and the tunnel report them.
pub const STEPS: &[(&str, &str)] = &[
    (SSH, "Connect over SSH"),
    (INSTALL, "Install wisp there"),
    (WISP, "Start wisp there"),
    (TUNNEL, "Open the tunnel"),
    (AGENTS, "Find coding agents"),
];

/// Where release downloads live: `<DIST>/v<version>/{SHA256SUMS.txt, wisp-bin-<os>-<arch>.tar.gz}`.
pub const DIST: &str = "https://github.com/M0xoo/wisp/releases/download";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Api {
    /// take whichever wisp runs there (the phone)
    Any,
    /// the lowest protocol this side speaks: an older wisp there is stale
    AtLeast(u32),
}

#[derive(Debug, Clone)]
pub struct BootOpts<'a> {
    pub port: u16,
    /// a custom start command; '' runs this version's binary
    pub command: &'a str,
    pub api: Api,
    /// download wisp when it isn't there
    pub install: bool,
    pub version: &'a str,
    /// `None`: the GitHub release of `version`
    pub dist: Option<&'a str>,
}

pub fn bootstrap_script(o: &BootOpts<'_>) -> String {
    let dist = o
        .dist
        .map_or_else(|| format!("{DIST}/v{}", o.version), str::to_owned);
    let api = match o.api {
        Api::Any => "any".to_owned(),
        Api::AtLeast(n) => n.to_string(),
    };
    let cmd = if o.command.trim().is_empty() {
        "''".to_owned()
    } else {
        shq(o.command.trim())
    };
    TEMPLATE
        .replace("__PORT__", &o.port.to_string())
        .replace("__INSTALL__", if o.install { "1" } else { "0" })
        .replace("__API__", &api)
        .replace("__VERSION__", &shq(o.version))
        .replace("__DIST__", &shq(&dist))
        .replace("__CMD__", &cmd)
}

/// What the default command runs, for the card (v1 showed `npx -y wisp-agents@<version>`).
pub fn default_command(version: &str) -> String {
    format!("~/.wisp/bin/{version}/wisp")
}

/// One line the script printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootLine {
    Step {
        id: String,
        status: StepStatus,
        detail: String,
    },
    Fail {
        id: String,
        message: String,
    },
    /// an older wisp there refused this API: its pid, for Restart
    Stale(Option<u32>),
    Ready {
        version: String,
        pid: Option<u32>,
    },
    /// anything else: kept for Details
    Log(String),
    Blank,
}

pub fn parse_line(line: &str) -> BootLine {
    let Some(rest) = line.strip_prefix("@@wisp ") else {
        return if line.trim().is_empty() {
            BootLine::Blank
        } else {
            BootLine::Log(line.to_owned())
        };
    };
    let (kind, rest) = rest.split_once(' ').unwrap_or((rest, ""));
    let rest = rest.trim_start();
    let word = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    match kind {
        "step" => {
            let mut it = rest.splitn(3, ' ');
            let (id, status, detail) = (
                it.next().unwrap_or(""),
                it.next().unwrap_or(""),
                it.next().unwrap_or("").trim_start(),
            );
            match StepStatus::parse(status) {
                Some(status) if word(id) => BootLine::Step {
                    id: id.to_owned(),
                    status,
                    detail: detail.to_owned(),
                },
                _ => BootLine::Log(line.to_owned()),
            }
        }
        "fail" => {
            let (id, msg) = rest.split_once(' ').unwrap_or((rest, ""));
            if word(id) {
                BootLine::Fail {
                    id: id.to_owned(),
                    message: msg.trim_start().to_owned(),
                }
            } else {
                BootLine::Log(line.to_owned())
            }
        }
        "stale" => BootLine::Stale(rest.trim().parse().ok().filter(|p| *p > 0)),
        "ready" => {
            let mut it = rest.split(' ');
            let version = it.next().unwrap_or("").to_owned();
            BootLine::Ready {
                version,
                pid: it.next().and_then(|p| p.parse().ok()).filter(|p| *p > 0),
            }
        }
        _ => BootLine::Log(line.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(command: &str, api: Api) -> BootOpts<'_> {
        BootOpts {
            port: 4555,
            command,
            api,
            install: true,
            version: "2.0.0",
            dist: None,
        }
    }

    #[test]
    fn fields_are_filled_and_quoted() {
        let sh = bootstrap_script(&opts("wisp-agents@1.2.3 # it's", Api::AtLeast(1)));
        assert!(sh.lines().any(|l| l == "PORT=4555"));
        assert!(
            sh.lines()
                .any(|l| l == r"CMD='wisp-agents@1.2.3 # it'\''s'")
        );
        assert!(sh.lines().any(|l| l == "API=1"));
        assert!(sh.lines().any(|l| l == "VERSION='2.0.0'"));
        assert!(
            sh.lines()
                .any(|l| l == "DIST='https://github.com/M0xoo/wisp/releases/download/v2.0.0'")
        );
        assert!(!sh.contains("__"), "every field filled");
        // the default command: this version's binary, nothing on the line itself to inject
        assert!(
            bootstrap_script(&opts("  ", Api::AtLeast(1)))
                .lines()
                .any(|l| l == "CMD=''")
        );
    }

    #[test]
    fn the_phone_takes_any_wisp_there() {
        let sh = bootstrap_script(&BootOpts {
            install: false,
            ..opts("", Api::Any)
        });
        assert!(sh.lines().any(|l| l == "API=any"));
        assert!(sh.lines().any(|l| l == "INSTALL=0"));
        assert!(sh.contains(r#"[ "$API" != any ] && [ "$3" -lt "$API" ]"#));
        assert_eq!(
            STEPS.iter().map(|s| s.0).collect::<Vec<_>>(),
            ["ssh", "install", "wisp", "tunnel", "agents"]
        );
    }

    #[test]
    fn the_script_keeps_v1s_edge_cases() {
        let sh = TEMPLATE;
        assert!(
            sh.contains(r#"cd "$HOME""#),
            "npx-style lookups from the login folder"
        );
        assert!(
            sh.contains("-lc 'printf \"%s\" \"$PATH\"'"),
            "PATH from the login shell"
        );
        for p in [".nvm/versions/node", ".volta/bin", "/opt/homebrew/bin"] {
            assert!(sh.contains(p), "{p} on PATH");
        }
        assert!(sh.contains("grep -qi musl"), "musl refused");
        assert!(
            sh.contains("SHA256SUMS.txt") && sh.contains("checksum didn’t match"),
            "the download is checked"
        );
        assert!(sh.contains("-ge 330"), "330 s health wait");
        assert!(
            sh.contains("used by another program"),
            "a port taken by another program"
        );
        assert!(sh.ends_with("exec cat >/dev/null\n"), "holds the session");
        assert!(sh.starts_with("say() {"), "the phone runs it as is");
    }

    #[test]
    fn lines() {
        assert_eq!(
            parse_line("@@wisp step ssh done Linux devbox"),
            BootLine::Step {
                id: "ssh".into(),
                status: StepStatus::Done,
                detail: "Linux devbox".into()
            }
        );
        assert_eq!(
            parse_line("@@wisp step wisp run"),
            BootLine::Step {
                id: "wisp".into(),
                status: StepStatus::Run,
                detail: String::new()
            }
        );
        assert_eq!(
            parse_line("@@wisp fail install Neither curl nor wget"),
            BootLine::Fail {
                id: "install".into(),
                message: "Neither curl nor wget".into()
            }
        );
        assert_eq!(parse_line("@@wisp stale 4242"), BootLine::Stale(Some(4242)));
        assert_eq!(parse_line("@@wisp stale x"), BootLine::Stale(None));
        assert_eq!(
            parse_line("@@wisp ready 2.0.0 99"),
            BootLine::Ready {
                version: "2.0.0".into(),
                pid: Some(99)
            }
        );
        assert_eq!(
            parse_line("@@wisp ready 2.0.0 0"),
            BootLine::Ready {
                version: "2.0.0".into(),
                pid: None
            }
        );
        assert_eq!(
            parse_line("@@wisp step bad-id done x"),
            BootLine::Log("@@wisp step bad-id done x".into())
        );
        assert_eq!(
            parse_line("@@wisp step ssh maybe"),
            BootLine::Log("@@wisp step ssh maybe".into())
        );
        assert_eq!(
            parse_line("Warning: Permanently added"),
            BootLine::Log("Warning: Permanently added".into())
        );
        assert_eq!(parse_line("   "), BootLine::Blank);
    }
}
