//! A project's path is stored canonical (`wisp add .` stored "/repo/."; Windows' `\\?\` breaks git).
#![allow(clippy::unwrap_used)]

use wisp_runtime_api::paths::canonical_project_path as canon;

#[test]
fn wisp_add_dot_stores_the_folder_itself_absolute_without_a_trailing_dot_or_slash() {
    // the bug: `wisp add .` in /repo stored "/repo/."
    assert_eq!(canon("/repo/.", None), "/repo");
    assert_eq!(canon("/repo/", None), "/repo");
    assert_eq!(canon("/repo/./", None), "/repo");
    assert_eq!(canon("/repo/./web/../api", None), "/repo/api");
    // relative: resolved against the folder it was typed in
    assert_eq!(canon(".", Some("/home/me/repo")), "/home/me/repo");
    assert_eq!(canon("../other/", Some("/home/me/repo")), "/home/me/other");
    // the root stays the root; a URL stays as it is
    assert_eq!(canon("/", None), "/");
    assert_eq!(canon("/..", None), "/");
    assert_eq!(canon("https://github.com/acme/api.git", None), "https://github.com/acme/api.git");
    assert_eq!(canon("git@github.com:acme/api.git", None), "git@github.com:acme/api.git");
}

#[test]
fn a_windows_path_loses_its_verbatim_prefix_and_trailing_separator() {
    // std::fs::canonicalize on Windows returns \\?\C:\..., which git refuses
    assert_eq!(canon(r"\\?\C:\work\repo", None), r"C:\work\repo");
    assert_eq!(canon(r"C:\work\repo\.", None), r"C:\work\repo");
    assert_eq!(canon(r"C:\work\repo\", None), r"C:\work\repo");
    assert_eq!(canon(r"C:\", None), r"C:\");
    assert_eq!(canon(r"\\?\UNC\server\share\repo\", None), r"\\server\share\repo");
    assert_eq!(canon(r".\api", Some(r"C:\work")), r"C:\work\api");
}

/// A folder that's empty or relative would resolve against the server's own folder: refused, every spelling.
#[test]
fn a_folder_is_a_full_path_and_never_empty_or_relative() {
    use wisp_runtime_api::paths::Folder;
    for bad in ["", "   ", ".", "./src", "src", "..", "~/code/app", "~"] {
        let e = Folder::of(bad).unwrap_err();
        assert_eq!(e.path, bad.trim(), "{bad:?}");
    }
    assert_eq!(Folder::of("").unwrap_err().to_string(), "no folder");
    assert_eq!(Folder::of("src").unwrap_err().to_string(), "src isn't a full path to a folder");
    for good in ["/", "/work/app", " /work/app ", r"C:\work\app", "C:/work/app", r"\\host\share\app"] {
        assert_eq!(Folder::of(good).unwrap().to_string(), good.trim(), "{good:?}");
    }
    // a worktree that's gone falls back to the task's folder; none at all is None
    assert_eq!(Folder::first(["", "/work/app"]).unwrap().path(), std::path::Path::new("/work/app"));
    assert!(Folder::first(["", "relative"]).is_none());
    let w: wisp_kernel::WireError = Folder::of("").unwrap_err().into();
    assert_eq!(w.message, "no folder");
}
