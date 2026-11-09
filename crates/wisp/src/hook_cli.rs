//! `wisp hook install | uninstall | status` (ADR-0033, ADR-0040): a `prepare-commit-msg` hook that links each commit
//! made in a wisp task's run to that task (`Wisp-Task: <id>`, the trailer Ship it writes), even when no wisp is
//! running: the run's `WISP_TASK` is all it reads. A hook the repo had is kept as `prepare-commit-msg.local` and
//! runs first; uninstall puts it back.
use std::path::{Path, PathBuf};

use crate::client::{CliError, Result};
use crate::scripted::say;

/// What marks the hook as wisp's.
const MARK: &str = "# wisp-hook: prepare-commit-msg";

/// The hook. POSIX sh; `git interpret-trailers` places the trailer the way git does.
pub fn script() -> String {
    format!(
        r#"#!/bin/sh
{MARK}
# Links commits made in a wisp task's run to that task (Wisp-Task: <id>). `wisp hook uninstall` removes it.
here=$(dirname "$0")
if [ -x "$here/prepare-commit-msg.local" ]; then
  "$here/prepare-commit-msg.local" "$@" || exit $?
fi
[ -n "$WISP_TASK" ] || exit 0
case "$WISP_TASK" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
grep -q "^Wisp-Task: $WISP_TASK\$" "$1" 2>/dev/null && exit 0
git interpret-trailers --in-place --if-exists addIfDifferent --trailer "Wisp-Task: $WISP_TASK" "$1"
"#
    )
}

/// The repo's hooks folder (`core.hooksPath` and worktrees respected).
fn hooks_dir(cwd: &Path) -> Result<PathBuf> {
    let o = std::process::Command::new("git").args(["rev-parse", "--git-path", "hooks"]).current_dir(cwd).output().map_err(|e| CliError::said(format!("git: {e}")))?;
    if !o.status.success() {
        return Err(CliError::said("not in a git repository (wisp hook works in one)"));
    }
    let p = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
    Ok(if p.is_absolute() { p } else { cwd.join(p) })
}

fn is_ours(text: &str) -> bool {
    text.contains(MARK)
}

#[cfg(unix)]
fn executable(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn executable(_p: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Installs it in `dir`. → what it did.
pub fn install(dir: &Path) -> std::io::Result<&'static str> {
    std::fs::create_dir_all(dir)?;
    let hook = dir.join("prepare-commit-msg");
    let local = dir.join("prepare-commit-msg.local");
    match std::fs::read_to_string(&hook) {
        Ok(t) if is_ours(&t) => {
            if t == script() {
                return Ok("already installed");
            }
        }
        Ok(_) => {
            if local.exists() {
                return Err(std::io::Error::other("both a prepare-commit-msg and a prepare-commit-msg.local are here: move one away first"));
            }
            std::fs::rename(&hook, &local)?;
        }
        Err(_) => {}
    }
    std::fs::write(&hook, script())?;
    executable(&hook)?;
    Ok("installed")
}

/// Removes it, putting the repo's own hook back.
pub fn uninstall(dir: &Path) -> std::io::Result<&'static str> {
    let hook = dir.join("prepare-commit-msg");
    let local = dir.join("prepare-commit-msg.local");
    match std::fs::read_to_string(&hook) {
        Ok(t) if is_ours(&t) => {
            std::fs::remove_file(&hook)?;
            if local.exists() {
                std::fs::rename(&local, &hook)?;
            }
            Ok("removed")
        }
        Ok(_) => Ok("the hook here isn't wisp's: left as it is"),
        Err(_) => Ok("not installed"),
    }
}

pub fn run(words: &[String], cwd: &Path) -> Result<i32> {
    let dir = hooks_dir(cwd)?;
    let verb = words.first().map_or("status", String::as_str);
    let said = match verb {
        "install" => install(&dir).map_err(|e| CliError::said(format!("wisp hook install: {e}")))?,
        "uninstall" | "remove" => uninstall(&dir).map_err(|e| CliError::said(format!("wisp hook uninstall: {e}")))?,
        "status" => {
            let t = std::fs::read_to_string(dir.join("prepare-commit-msg")).unwrap_or_default();
            if is_ours(&t) { "installed: commits made in a wisp task get Wisp-Task: <id>" } else { "not installed (wisp hook install)" }
        }
        other => return Err(CliError::said(format!("wisp hook {other}: install, uninstall or status"))),
    };
    say(&format!("  {said}  ({})", dir.join("prepare-commit-msg").display()));
    Ok(0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn repo(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wisp-hook-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&d).output().unwrap().status.success(), "git {args:?}");
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "commit.gpgsign", "false"]);
        d
    }

    fn commit(d: &Path, task: Option<&str>, msg: &str) -> String {
        let n = std::fs::read_dir(d).unwrap().count();
        std::fs::write(d.join(format!("f{n}")), "x").unwrap();
        let run = |args: &[&str]| {
            let mut c = std::process::Command::new("git");
            c.args(args).current_dir(d).env_remove("WISP_TASK");
            if let Some(t) = task {
                c.env("WISP_TASK", t);
            }
            assert!(c.output().unwrap().status.success(), "git {args:?}");
        };
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", msg]);
        let o = std::process::Command::new("git").args(["log", "-1", "--format=%B"]).current_dir(d).output().unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    #[test]
    fn hook_adds_the_trailer_only_inside_a_task() {
        let d = repo("only");
        install(&hooks_dir(&d).unwrap()).unwrap();
        assert!(commit(&d, Some("01abc_DEF-9"), "fix: in a task").contains("Wisp-Task: 01abc_DEF-9"));
        assert!(!commit(&d, None, "by hand").contains("Wisp-Task"), "no task: untouched");
    }

    #[test]
    fn hook_never_doubles_the_trailer() {
        let d = repo("once");
        install(&hooks_dir(&d).unwrap()).unwrap();
        let m = commit(&d, Some("t1"), "ship: x\n\nWisp-Task: t1");
        assert_eq!(m.matches("Wisp-Task: t1").count(), 1, "{m}");
        let bad = commit(&d, Some("t1\nWisp-Task: evil"), "y");
        assert!(!bad.contains("Wisp-Task"), "a WISP_TASK that isn't an id adds nothing: {bad}");
    }

    #[test]
    fn hook_install_keeps_the_users_own_hook() {
        let d = repo("keep");
        let dir = hooks_dir(&d).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let own = "#!/bin/sh\necho 'mine' >> \"$1\"\n";
        std::fs::write(dir.join("prepare-commit-msg"), own).unwrap();
        executable(&dir.join("prepare-commit-msg")).unwrap();
        assert_eq!(install(&dir).unwrap(), "installed");
        assert_eq!(install(&dir).unwrap(), "already installed", "twice is a no-op");
        let m = commit(&d, Some("t2"), "z");
        assert!(m.contains("mine") && m.contains("Wisp-Task: t2"), "theirs runs first, then ours: {m}");
        assert_eq!(uninstall(&dir).unwrap(), "removed");
        assert_eq!(std::fs::read_to_string(dir.join("prepare-commit-msg")).unwrap(), own, "theirs is back");
        assert!(!dir.join("prepare-commit-msg.local").exists());
    }
}
