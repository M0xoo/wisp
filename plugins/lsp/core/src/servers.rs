//! Which language server speaks for a file, where to find it, and how wisp installs the npm ones.

use std::path::{Path, PathBuf};

use wisp_lsp_api::Lang;

/// One language's servers, in the order tried (v1 `SERVERS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerSpec {
    pub lang: Lang,
    /// what the editor shows: `TypeScript`
    pub name: &'static str,
    /// each a program and its arguments
    pub bins: &'static [&'static [&'static str]],
    pub exts: &'static [&'static str],
    /// what `POST /lsp/install` puts in `<home>/lsp`; empty: install it yourself
    pub npm: &'static [&'static str],
}

pub const SERVERS: [ServerSpec; 4] = [
    ServerSpec {
        lang: Lang::Ts,
        name: "TypeScript",
        bins: &[&["typescript-language-server", "--stdio"]],
        exts: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        npm: &["typescript@5", "typescript-language-server"],
    },
    ServerSpec {
        lang: Lang::Py,
        name: "Python",
        bins: &[&["pyright-langserver", "--stdio"], &["pylsp"]],
        exts: &["py", "pyi"],
        npm: &["pyright"],
    },
    ServerSpec {
        lang: Lang::Go,
        name: "Go",
        bins: &[&["gopls"]],
        exts: &["go"],
        npm: &[],
    },
    ServerSpec {
        lang: Lang::Rs,
        name: "Rust",
        bins: &[&["rust-analyzer"]],
        exts: &["rs"],
        npm: &[],
    },
];

pub fn spec(lang: Lang) -> &'static ServerSpec {
    match lang {
        Lang::Ts => &SERVERS[0],
        Lang::Py => &SERVERS[1],
        Lang::Go => &SERVERS[2],
        Lang::Rs => &SERVERS[3],
    }
}

fn ext_of(file: &Path) -> Option<String> {
    file.extension().map(|e| e.to_string_lossy().to_lowercase())
}

/// The language of a file by its extension, any case.
pub fn lang_of(file: &Path) -> Option<Lang> {
    let ext = ext_of(file)?;
    SERVERS
        .iter()
        .find(|s| s.exts.contains(&ext.as_str()))
        .map(|s| s.lang)
}

/// LSP's `languageId` for a file (v1 `LANG_ID`), `plaintext` when wisp doesn't know it.
pub fn lang_id(file: &Path) -> &'static str {
    match ext_of(file).as_deref() {
        Some("ts" | "mts" | "cts") => "typescript",
        Some("tsx") => "typescriptreact",
        Some("js" | "mjs" | "cjs") => "javascript",
        Some("jsx") => "javascriptreact",
        Some("py" | "pyi") => "python",
        Some("go") => "go",
        Some("rs") => "rust",
        _ => "plaintext",
    }
}

/// What `find_server` reads of the world, injected so it stays pure.
#[derive(Debug, Clone, Default)]
pub struct Search {
    /// `WISP_LSP_<LANG>`'s value: a whole command line, which wins (how tests and odd installs say it)
    pub override_cmd: Option<String>,
    /// `PATH`
    pub path: Option<String>,
    pub windows: bool,
}

impl Search {
    /// The environment variable that overrides `lang`'s server: `WISP_LSP_TS`.
    pub fn override_var(lang: Lang) -> String {
        format!("WISP_LSP_{}", lang.as_str().to_uppercase())
    }
}

/// Every command to try for `lang` in `root`, in order: the repo's own `node_modules/.bin`, wisp's
/// `<home>/lsp/node_modules/.bin`, then PATH; on Windows each as `.cmd` then `.exe`.
pub fn candidates(
    lang: Lang,
    root: &Path,
    home: Option<&Path>,
    search: &Search,
) -> Vec<Vec<String>> {
    let sep = if search.windows { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> = vec![root.join("node_modules").join(".bin")];
    dirs.extend(home.map(|h| h.join("lsp").join("node_modules").join(".bin")));
    dirs.extend(
        search
            .path
            .as_deref()
            .unwrap_or("")
            .split(sep)
            .filter(|d| !d.is_empty())
            .map(PathBuf::from),
    );
    let mut out = Vec::new();
    for bin in spec(lang).bins {
        let Some((prog, args)) = bin.split_first() else {
            continue;
        };
        let names: Vec<String> = if search.windows {
            vec![format!("{prog}.cmd"), format!("{prog}.exe")]
        } else {
            vec![(*prog).to_owned()]
        };
        for d in &dirs {
            for n in &names {
                let mut cmd = vec![d.join(n).to_string_lossy().into_owned()];
                cmd.extend(args.iter().map(|a| (*a).to_owned()));
                out.push(cmd);
            }
        }
    }
    out
}

/// The override, split on spaces, if set.
pub fn override_command(search: &Search) -> Option<Vec<String>> {
    let cmd: Vec<String> = search
        .override_cmd
        .as_deref()?
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    (!cmd.is_empty()).then_some(cmd)
}

/// The command for `lang` in `root`, or `None` when no server is installed: the override, else the
/// first candidate `is_exe` accepts.
pub fn find_server(
    lang: Lang,
    root: &Path,
    home: Option<&Path>,
    search: &Search,
    is_exe: impl Fn(&Path) -> bool,
) -> Option<Vec<String>> {
    if let Some(cmd) = override_command(search) {
        return Some(cmd);
    }
    candidates(lang, root, home, search)
        .into_iter()
        .find(|c| c.first().is_some_and(|p| is_exe(Path::new(p))))
}

/// How `POST /lsp/install` runs npm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    pub dir: PathBuf,
    pub args: Vec<String>,
}

/// npm's servers for `lang` into `<home>/lsp`, so every task folder finds them; `None` when wisp
/// doesn't install that language's server.
pub fn install_plan(lang: &str, home: &Path) -> Option<InstallPlan> {
    let s = spec(Lang::parse(lang)?);
    if s.npm.is_empty() {
        return None;
    }
    let dir = home.join("lsp");
    let mut args: Vec<String> = ["install", "--no-audit", "--no-fund", "--prefix"]
        .map(str::to_owned)
        .to_vec();
    args.push(dir.to_string_lossy().into_owned());
    args.extend(s.npm.iter().map(|p| (*p).to_owned()));
    Some(InstallPlan { dir, args })
}

/// v1's 400: which languages wisp installs.
pub fn install_refusal() -> String {
    let names: Vec<&str> = SERVERS
        .iter()
        .filter(|s| !s.npm.is_empty())
        .map(|s| s.lang.as_str())
        .collect();
    format!(
        "wisp installs {} servers; install others yourself",
        names.join(" and ")
    )
}

/// What a failed npm said: its last three lines of stderr, on one line (else `fallback`).
pub fn install_error(stderr: &str, fallback: &str) -> String {
    let text = stderr.trim();
    let text = if text.is_empty() {
        fallback.trim()
    } else {
        text
    };
    let lines: Vec<&str> = text.split('\n').collect();
    lines[lines.len().saturating_sub(3)..].join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_by_extension() {
        assert_eq!(lang_of(Path::new("a.tsx")), Some(Lang::Ts));
        assert_eq!(lang_of(Path::new("a.MJS")), Some(Lang::Ts));
        assert_eq!(lang_of(Path::new("a.py")), Some(Lang::Py));
        assert_eq!(lang_of(Path::new("x/main.go")), Some(Lang::Go));
        assert_eq!(lang_of(Path::new("lib.rs")), Some(Lang::Rs));
        assert_eq!(lang_of(Path::new("README.md")), None);
        assert_eq!(lang_of(Path::new("Makefile")), None);
        assert_eq!(lang_id(Path::new("a.cts")), "typescript");
        assert_eq!(lang_id(Path::new("a.jsx")), "javascriptreact");
        assert_eq!(lang_id(Path::new("a.pyi")), "python");
        assert_eq!(lang_id(Path::new("a.txt")), "plaintext");
    }

    #[test]
    fn the_override_wins() {
        let s = Search {
            override_cmd: Some("/usr/bin/node  /x/fake-lsp.mjs".into()),
            path: Some("/bin".into()),
            windows: false,
        };
        assert_eq!(
            find_server(Lang::Ts, Path::new("/r"), None, &s, |_| true),
            Some(vec!["/usr/bin/node".into(), "/x/fake-lsp.mjs".into()])
        );
        assert_eq!(Search::override_var(Lang::Py), "WISP_LSP_PY");
    }

    #[test]
    fn the_repo_then_wisp_then_path() {
        let s = Search {
            override_cmd: None,
            path: Some("/usr/bin::/opt/bin".into()),
            windows: false,
        };
        let c = candidates(Lang::Ts, Path::new("/r"), Some(Path::new("/h")), &s);
        let firsts: Vec<&str> = c.iter().map(|c| c[0].as_str()).collect();
        assert_eq!(
            firsts,
            [
                "/r/node_modules/.bin/typescript-language-server",
                "/h/lsp/node_modules/.bin/typescript-language-server",
                "/usr/bin/typescript-language-server",
                "/opt/bin/typescript-language-server"
            ]
        );
        assert!(c.iter().all(|c| c[1] == "--stdio"));
        let found = find_server(Lang::Ts, Path::new("/r"), Some(Path::new("/h")), &s, |p| {
            p.starts_with("/usr")
        });
        assert_eq!(
            found,
            Some(vec![
                "/usr/bin/typescript-language-server".into(),
                "--stdio".into()
            ])
        );
    }

    #[test]
    fn python_tries_pyright_before_pylsp() {
        let s = Search {
            path: Some("/bin".into()),
            ..Search::default()
        };
        let found = find_server(Lang::Py, Path::new("/r"), None, &s, |p| {
            p == Path::new("/bin/pylsp")
        });
        assert_eq!(found, Some(vec!["/bin/pylsp".into()]));
        let found = find_server(Lang::Py, Path::new("/r"), None, &s, |_| true);
        assert_eq!(
            found.map(|c| c.join(" ")),
            Some("/r/node_modules/.bin/pyright-langserver --stdio".into())
        );
    }

    #[test]
    fn windows_shims() {
        let s = Search {
            path: Some(r"C:\bin;C:\tools".into()),
            windows: true,
            ..Search::default()
        };
        let c = candidates(Lang::Go, Path::new("/r"), None, &s);
        let names: Vec<String> = c
            .iter()
            .map(|c| {
                Path::new(&c[0])
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .collect();
        assert_eq!(&names[..2], ["gopls.cmd", "gopls.exe"]);
        assert_eq!(c.len(), 6);
    }

    #[test]
    fn nothing_installed_anywhere() {
        let s = Search {
            path: Some("/empty".into()),
            ..Search::default()
        };
        assert_eq!(
            find_server(Lang::Go, Path::new("/r"), None, &s, |_| false),
            None
        );
    }

    #[test]
    fn install_only_the_npm_ones() {
        let p = install_plan("ts", Path::new("/h"));
        assert_eq!(
            p,
            Some(InstallPlan {
                dir: PathBuf::from("/h/lsp"),
                args: [
                    "install",
                    "--no-audit",
                    "--no-fund",
                    "--prefix",
                    "/h/lsp",
                    "typescript@5",
                    "typescript-language-server"
                ]
                .map(String::from)
                .to_vec()
            })
        );
        assert_eq!(
            install_plan("py", Path::new("/h")).map(|p| p.args.last().cloned()),
            Some(Some("pyright".into()))
        );
        assert_eq!(install_plan("go", Path::new("/h")), None);
        assert_eq!(install_plan("", Path::new("/h")), None);
        assert_eq!(
            install_refusal(),
            "wisp installs ts and py servers; install others yourself"
        );
    }

    #[test]
    fn install_errors_are_the_last_three_lines() {
        assert_eq!(install_error("a\nb\nc\nd\n", "x"), "b c d");
        assert_eq!(install_error("  ", "spawn npm ENOENT"), "spawn npm ENOENT");
    }
}
