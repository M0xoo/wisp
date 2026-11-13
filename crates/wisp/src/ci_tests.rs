//! The CI deliverables (ADR-0040): `action/run.sh` run with a fake `wisp` and `gh`, and the image's Dockerfile.
#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fake(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Runs the action's step with a fake wisp whose task ends `state`. → (exit code, gh's calls, summary, outputs).
fn run(state: &str, pr: bool) -> (i32, String, String, String) {
    let d = std::env::temp_dir().join(format!("wisp-action-{state}-{pr}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let bin = d.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = d.join("calls");
    fake(
        &bin,
        "wisp",
        &format!(
            r#"echo "wisp $*" >> "{log}"
case "$1" in
  wait) exit 0 ;;
  show) if [ "$3" = "--json" ]; then echo '{{"id":"t1","state":"{state}"}}'; else echo "◌ Fix the test  [{state}]  t1"; echo "Fixed it."; fi ;;
  *) echo '[{{"id":"t1"}}]' ;;
esac"#,
            log = log.display()
        ),
    );
    fake(&bin, "gh", &format!("echo \"gh $*\" >> \"{}\"; cat \"$5\" >> \"{}\"", log.display(), log.display()));
    let event = d.join("event.json");
    std::fs::write(&event, if pr { r#"{"pull_request":{"number":7}}"# } else { "{}" }).unwrap();
    let (summary, out) = (d.join("summary"), d.join("out"));
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let st = std::process::Command::new("bash")
        .arg(root().join("action/run.sh"))
        .current_dir(&d)
        .env("PATH", path)
        .env("WISP_PROMPT", "fix the failing test")
        .env("WISP_MODE", "edits")
        .env("WISP_COMMENT", "true")
        .env("WISP_FAIL_ON", "failed")
        .env("GITHUB_EVENT_PATH", &event)
        .env("GITHUB_STEP_SUMMARY", &summary)
        .env("GITHUB_OUTPUT", &out)
        .output()
        .unwrap();
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    (st.status.code().unwrap_or(-1), read(&log), read(&summary), read(&out))
}

#[test]
fn the_action_runs_a_task_and_posts_its_report() {
    let (code, calls, summary, out) = run("review", true);
    assert_eq!(code, 0, "{calls}");
    assert!(calls.contains("wisp --mode edits --json -- fix the failing test"), "{calls}");
    assert!(calls.contains("wisp wait t1"), "it waits for the task: {calls}");
    assert!(calls.contains("gh pr comment 7 --body-file"), "{calls}");
    assert!(calls.contains("Fixed it."), "the report is the comment: {calls}");
    assert!(summary.contains("### wisp: review") && summary.contains("Fixed it."));
    assert!(out.contains("task=t1") && out.contains("state=review"));
    // not a pull request: no comment; a failed task fails the job
    let (code, calls, ..) = run("error", false);
    assert_eq!(code, 1);
    assert!(!calls.contains("gh pr comment"));
}

#[test]
fn the_image_runs_wisp_headless() {
    let d = std::fs::read_to_string(root().join("ci/image/Dockerfile")).unwrap();
    assert!(d.contains("npm install -g \"wisp-agents@"));
    assert!(d.contains("git") && d.contains(" gh"));
    assert!(d.contains("USER wisp"), "not root");
    assert!(d.contains("ENTRYPOINT [\"wisp\"]"));
    let a = std::fs::read_to_string(root().join("action/action.yml")).unwrap();
    assert!(a.contains("using: composite") && a.contains("run.sh") && a.contains("fail-on"));
}
