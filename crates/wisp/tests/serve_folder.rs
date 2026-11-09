//! Formulas as folders (ADR-0034), end to end on a real `wisp serve`: `.wisp/*.wisp.yml` with variables,
//! locals, a reference, `count`, a module from a path and one from git (`wisp init`, `.wisp/lock.yml`),
//! outputs and the graph; `-var`, workspaces; a cycle refused; `wisp mv`, `fmt`, `import`, `export` to
//! a folder (split by kind, `--with-deps`) and `destroy`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};

use common::{Api, start, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, cwd: &Path, port: u16, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp")).args(args).env("WISP_HOME", dir.join("home")).env("WISP_PORT", port.to_string()).env("NO_COLOR", "1").current_dir(cwd).stdin(Stdio::null()).output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

async fn profile(api: &Api, name: &str) -> Value {
    api.cmd("runtime.profiles", json!({})).await.as_array().unwrap().iter().find(|p| p["name"] == name).cloned().unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_formula_folder_with_variables_references_modules_and_workspaces() {
    let dir = temp("serve-folder");
    let repo = dir.join("proj");
    let w = repo.join(".wisp");
    std::fs::create_dir_all(w.join("x")).unwrap();
    // a module from a path, outside .wisp
    std::fs::create_dir_all(repo.join("shared/team")).unwrap();
    std::fs::write(repo.join("shared/team/team.wisp.yml"), "variables:\n  model: { type: string }\nagents:\n  reviewer: { harness: claude, model: \"${var.model}\" }\noutputs:\n  reviewer: { value: \"${agent.reviewer}\" }\n").unwrap();
    // a module from git
    let gm = dir.join("gitmod");
    std::fs::create_dir_all(gm.join("pack")).unwrap();
    std::fs::write(gm.join("pack/pack.wisp.yml"), "agents:\n  packer: { harness: codex, effort: low }\n").unwrap();
    git(&gm, &["init", "-q", "-b", "main"]);
    git(&gm, &["add", "."]);
    git(&gm, &["commit", "-qm", "pack"]);
    std::fs::write(w.join("agents.wisp.yml"), "variables:\n  model: { type: string, default: opus }\n  helpers: { type: number, default: 2 }\nlocals:\n  harness: claude\nagents:\n  reviewer: { harness: \"${local.harness}\", model: \"${var.model}\", instructions: \"Workspace ${workspace}\" }\n  helper:\n    count: ${var.helpers}\n    harness: codex\n    instructions: \"helper ${count.index}\"\n").unwrap();
    std::fs::write(w.join("x/tasks.wisp.yml"), format!("tasks:\n  nightly: {{ prompt: Update deps, agent: \"${{agent.reviewer}}\" }}\nmodules:\n  team: {{ source: ../../shared/team, inputs: {{ model: haiku }} }}\n  pack: {{ source: \"git::file://{}//pack?ref=main\" }}\noutputs:\n  reviewer_model: {{ value: \"${{agent.reviewer.model}}\" }}\n  team_reviewer: {{ value: \"${{module.team.reviewer}}\" }}\n", gm.display())).unwrap();
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };

    // a git module needs wisp init first
    let (code, _, err) = wisp(&dir, &repo, port, &["validate"]);
    assert_eq!(code, 1);
    assert!(err.contains("run wisp init"), "{err}");
    let (code, out, err) = wisp(&dir, &repo, port, &["init"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("module pack") && out.contains("module team"), "{out}");
    let lock = std::fs::read_to_string(w.join("lock.yml")).unwrap();
    assert!(lock.contains("commit:") && lock.contains("hash:"), "{lock}");
    assert!(std::fs::read_to_string(repo.join("AGENTS.md")).unwrap().contains("wisp tasks --touching"), "init adds the AGENTS.md note");

    let (code, out, err) = wisp(&dir, &repo, port, &["plan"]);
    assert_eq!(code, 0, "{out}{err}");
    for line in ["+ agent/reviewer", "+ agent/helper-0", "+ agent/helper-1", "+ agent/team-reviewer", "+ agent/pack-packer", "+ task/nightly"] {
        assert!(out.contains(line), "{line}: {out}");
    }
    let (code, out, err) = wisp(&dir, &repo, port, &["apply", "--yes", "-var", "model=sonnet"]);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(profile(&api, "reviewer").await["model"], "sonnet", "-var over the default");
    assert_eq!(profile(&api, "reviewer").await["instructions"], "Workspace default");
    assert_eq!(profile(&api, "team-reviewer").await["model"], "haiku", "the module's input");
    assert_eq!(profile(&api, "helper-1").await["instructions"], "helper 1");
    assert_eq!(profile(&api, "pack-packer").await["effort"], "low", "the git module");
    let tasks = api.cmd("automations.tasks", json!({})).await;
    assert!(tasks.to_string().contains("\"agent\":\"reviewer\""), "the reference is its name: {tasks}");

    let (_, out, _) = wisp(&dir, &repo, port, &["output", "team_reviewer"]);
    assert_eq!(out.trim(), "team-reviewer");
    let (_, out, _) = wisp(&dir, &repo, port, &["output", "--json"]);
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["reviewer_model"], "opus", "outputs without -var: the default");
    let (_, out, _) = wisp(&dir, &repo, port, &["graph"]);
    assert!(out.contains("\"task.nightly\" -> \"agent.reviewer\"") && out.contains("module.team.agent.reviewer"), "{out}");

    // workspaces: another variable set for the same files; plan shows the drift from what wisp has
    assert_eq!(wisp(&dir, &repo, port, &["workspace", "new", "prod"]).0, 0);
    std::fs::write(w.join("workspaces/prod.vars.yml"), "model: opus-4\n").unwrap();
    assert_eq!(wisp(&dir, &repo, port, &["workspace", "select", "prod"]).0, 0);
    let (_, out, _) = wisp(&dir, &repo, port, &["plan"]);
    assert!(out.contains("~ agent/reviewer") && out.contains("opus-4") && out.contains("drift"), "{out}");
    assert!(out.contains("workspace prod"), "{out}");
    assert_eq!(wisp(&dir, &repo, port, &["workspace", "select", "default"]).0, 0);

    // export: a folder split by kind, and one task with what it references
    let (code, out, err) = wisp(&dir, &repo, port, &["export", "-o", "out"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(repo.join("out/agents.wisp.yml").is_file() && repo.join("out/tasks.wisp.yml").is_file(), "{out}");
    let (code, out, err) = wisp(&dir, &repo, port, &["export", "task.nightly", "--with-deps", "-o", "share"]);
    assert_eq!(code, 0, "{out}{err}");
    let shared = std::fs::read_to_string(repo.join("share/agents.wisp.yml")).unwrap();
    assert!(shared.contains("reviewer") && !shared.contains("helper"), "only what nightly needs: {shared}");

    // mv: the declaration and its references
    let (code, out, err) = wisp(&dir, &repo, port, &["mv", "agent.reviewer", "agent.critic"]);
    assert_eq!(code, 0, "{out}{err}");
    let t = std::fs::read_to_string(w.join("x/tasks.wisp.yml")).unwrap();
    assert!(t.contains("${agent.critic}") && t.contains("${agent.critic.model}"), "{t}");
    assert!(std::fs::read_to_string(w.join("agents.wisp.yml")).unwrap().contains("  critic:"));
    assert_eq!(wisp(&dir, &repo, port, &["validate"]).0, 0);

    // fmt
    let a = w.join("agents.wisp.yml");
    std::fs::write(&a, std::fs::read_to_string(&a).unwrap().replace("locals:", "locals:   ")).unwrap();
    assert_eq!(wisp(&dir, &repo, port, &["fmt", "--check"]).0, 1);
    assert_eq!(wisp(&dir, &repo, port, &["fmt"]).0, 0);
    assert_eq!(wisp(&dir, &repo, port, &["fmt", "--check"]).0, 0);

    // import: something made in the app, into the files
    std::fs::write(dir.join("extra.yml"), "wisp: 1\nagents:\n  - name: extra\n    harness: codex\n").unwrap();
    assert_eq!(wisp(&dir, &dir, port, &["apply", "-f", "extra.yml", "--yes"]).0, 0);
    let (code, out, err) = wisp(&dir, &repo, port, &["import", "agent.extra"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(std::fs::read_to_string(&a).unwrap().contains("extra"), "it's in agents.wisp.yml");

    // a cycle is refused, naming it
    let cyc = dir.join("cyc");
    std::fs::create_dir_all(&cyc).unwrap();
    std::fs::write(cyc.join("a.wisp.yml"), "agents:\n  a: { model: \"${agent.b.model}\" }\n  b: { model: \"${agent.a.model}\" }\n").unwrap();
    let (code, _, err) = wisp(&dir, &dir, port, &["validate", "-f", "cyc"]);
    assert_eq!(code, 1);
    assert!(err.contains("a cycle"), "{err}");

    // destroy: what the folder declares goes
    let (code, out, err) = wisp(&dir, &repo, port, &["destroy", "--yes"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(profile(&api, "team-reviewer").await.is_null() && profile(&api, "helper-0").await.is_null(), "{out}");
    drop(serve);
}
