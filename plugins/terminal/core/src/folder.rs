//! Where a task's shell opens, and which shell (v1 routes/workspace.js `shellDir`, `shellArgv`).

use wisp_terminal_api::TaskFolder;

/// The worktree (or the project folder) when it is there. A merged task's worktree is gone with its
/// branch: then the project folder, else home, and the page says so (`gone`).
pub fn task_folder(
    workdir: &str,
    cwd: &str,
    home: &str,
    exists: &dyn Fn(&str) -> bool,
) -> TaskFolder {
    if !workdir.is_empty() && exists(workdir) {
        return TaskFolder {
            dir: workdir.to_owned(),
            root: workdir.to_owned(),
            gone: false,
        };
    }
    let dir = if !cwd.is_empty() && exists(cwd) {
        cwd
    } else {
        home
    };
    TaskFolder {
        dir: dir.to_owned(),
        root: cwd.to_owned(),
        gone: true,
    }
}

/// The user's login shell, started as one so their PATH and prompt come with it.
pub fn shell_argv(shell: Option<&str>) -> Vec<String> {
    vec![
        shell
            .filter(|s| !s.is_empty())
            .unwrap_or("/bin/sh")
            .to_owned(),
        "-l".to_owned(),
    ]
}

/// The shell's name for the panel (`zsh`).
pub fn shell_name(shell: Option<&str>) -> String {
    let argv = shell_argv(shell);
    let bin = argv.first().map_or("sh", String::as_str);
    bin.rsplit(['/', '\\']).next().unwrap_or(bin).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_else_project_folder_else_home_and_gone_says_so() {
        let only = |dirs: &'static [&'static str]| move |p: &str| dirs.contains(&p);
        assert_eq!(
            task_folder("/wt", "/repo", "/home", &only(&["/wt", "/repo"])),
            TaskFolder {
                dir: "/wt".into(),
                root: "/wt".into(),
                gone: false
            }
        );
        assert_eq!(
            task_folder("/wt", "/repo", "/home", &only(&["/repo"])),
            TaskFolder {
                dir: "/repo".into(),
                root: "/repo".into(),
                gone: true
            }
        );
        assert_eq!(
            task_folder("/repo", "/repo", "/home", &only(&[])),
            TaskFolder {
                dir: "/home".into(),
                root: "/repo".into(),
                gone: true
            }
        );
        assert!(
            task_folder("", "", "/home", &|_| true).gone,
            "no folder at all"
        );
    }

    #[test]
    fn the_login_shell() {
        assert_eq!(shell_argv(Some("/bin/zsh")), ["/bin/zsh", "-l"]);
        assert_eq!(shell_argv(None), ["/bin/sh", "-l"]);
        assert_eq!(shell_argv(Some("")), ["/bin/sh", "-l"]);
        assert_eq!(
            (shell_name(Some("/opt/homebrew/bin/fish")), shell_name(None)),
            ("fish".into(), "sh".into())
        );
    }
}
