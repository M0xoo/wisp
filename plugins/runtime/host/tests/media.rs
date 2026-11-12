//! An answer's pictures through the host (v1 routes/sessions.js `/sessions/:id/file`, `/reveal`): a picture in the
//! task's folder is found on disk, anything else is not, and Show in folder on a gone file says so.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{rig, rig_with, until};
use wisp_runtime::Recorder;
use wisp_runtime_api::commands::StartArgs;

/// A PNG's first bytes: enough for the content check on a file outside the folder.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

#[tokio::test(flavor = "multi_thread")]
async fn a_picture_in_the_tasks_folder_loads_and_nothing_outside_it_does_v1_media_host() {
    let r = rig().await;
    let dir = std::env::temp_dir().join(format!("wisp-media-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("shot.png"), b"png").unwrap();
    std::fs::write(dir.join("notes.txt"), b"txt").unwrap();
    let id = r.rt.create(StartArgs { prompt: "screenshot".into(), cwd: Some(dir.display().to_string()), hold: true, ..StartArgs::default() }).await.unwrap().id.0;

    let f = r.rt.media(&id, "shot.png").await.unwrap().expect("in the folder");
    assert_eq!(f.path, dir.join("shot.png"));
    assert!(r.rt.media(&id, "notes.txt").await.unwrap().is_none(), "not a picture");
    assert!(r.rt.media(&id, "gone.png").await.unwrap().is_none(), "not on disk");
    assert!(r.rt.media(&id, "../../../etc/hosts.png").await.unwrap().is_none(), "outside, named by no block");
    let gone = r.rt.reveal(&id, "gone.png").await.unwrap_err();
    assert_eq!(gone.to_string(), "That file is gone.");
    // Show in folder names the file it opened on: a picture, or a doc block's markdown in the folder
    std::fs::write(dir.join("plan.md"), b"# plan").unwrap();
    assert_eq!(r.rt.reveal(&id, "shot.png").await.unwrap()["path"], dir.join("shot.png").display().to_string());
    assert_eq!(r.rt.reveal(&id, "plan.md").await.unwrap()["path"], dir.join("plan.md").display().to_string());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screenshot_in_tmp_is_copied_into_shots_and_still_shows_once_its_gone_v1_keep_images() {
    let tmp = std::env::temp_dir().join(format!("wisp-shots-{}", std::process::id()));
    let (home, work, shots) = (tmp.join("tmp"), tmp.join("work"), tmp.join("home/shots"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let shot = home.join("shot.png");
    std::fs::write(&shot, PNG).unwrap();
    let r = rig_with(Recorder { shots: Some(shots.clone()), ..Recorder::default() }).await;
    let id = r.rt.create(StartArgs { prompt: format!("shot {}", shot.display()), cwd: Some(work.display().to_string()), ..StartArgs::default() }).await.unwrap().id.0;
    until("the turn to end", || async { r.rt.turns(&id, None, None).await.unwrap().last().is_some_and(|t| t.presentation.is_some()) }).await;
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    let block = t.presentation.unwrap().blocks.into_iter().find(|b| b["type"] == "image").expect("the picture");
    let copy = shots.join(&id).join(format!("{}-1.png", t.id.as_str()));
    assert_eq!(block["path"], copy.display().to_string());
    assert_eq!(block["source"], shot.display().to_string());
    assert_eq!(std::fs::read(&copy).unwrap(), PNG);
    // /tmp cleared: the page still gets the picture, by either path
    std::fs::remove_file(&shot).unwrap();
    assert_eq!(r.rt.media(&id, &shot.display().to_string()).await.unwrap().unwrap().path, copy);
    // the task deleted: its pictures go with it
    r.rt.delete(&id).await.unwrap();
    assert!(!shots.join(&id).exists());
    std::fs::remove_dir_all(&tmp).ok();
}

/// GET /api/sessions/:id/file: a path an answer block names outside the task's folder goes only when its bytes are
/// the picture or video its extension says. A key renamed `.png`, a `.png` link to a secret (outside, or one in the
/// folder pointing out) are never served; a real picture there is.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_file_a_block_names_outside_the_folder_is_served_only_when_its_bytes_are_a_picture_or_video() {
    let tmp = std::env::temp_dir().join(format!("wisp-media-out-{}", std::process::id()));
    let (work, out) = (tmp.join("work"), tmp.join("out"));
    std::fs::create_dir_all(&work).unwrap();
    std::fs::create_dir_all(&out).unwrap();
    let secret = out.join("id_rsa");
    std::fs::write(&secret, b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk").unwrap();
    std::fs::write(out.join("real.png"), PNG).unwrap();
    std::fs::write(out.join("key.png"), b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
    std::fs::write(out.join("clip.mp4"), PNG).unwrap();
    std::os::unix::fs::symlink(&secret, out.join("link.png")).unwrap();
    std::os::unix::fs::symlink(&secret, work.join("inside.png")).unwrap();
    std::fs::write(work.join("own.png"), b"whatever the agent wrote").unwrap();
    let r = rig().await;
    let served = |name: &str| {
        let (rt, work, path) = (r.rt.clone(), work.clone(), if name.starts_with('/') { name.to_owned() } else { out.join(name).display().to_string() });
        async move {
            let id = rt.create(StartArgs { prompt: format!("shot {path}"), cwd: Some(work.display().to_string()), ..StartArgs::default() }).await.unwrap().id.0;
            until("the answer", || async { rt.turns(&id, None, None).await.unwrap().last().is_some_and(|t| t.presentation.is_some()) }).await;
            rt.media(&id, &path).await.unwrap().map(|f| f.path)
        }
    };
    assert_eq!(served("real.png").await, Some(out.join("real.png")), "a real picture a block named");
    assert_eq!(served("key.png").await, None, "a key renamed .png");
    assert_eq!(served("link.png").await, None, "a .png link to a secret");
    assert_eq!(served("clip.mp4").await, None, "a picture named .mp4: the kinds must agree");
    assert_eq!(served("id_rsa").await, None, "no extension of ours");
    let inside = work.join("inside.png").display().to_string();
    assert_eq!(served(&inside).await, None, "a link in the folder that points out of it");
    // inside the folder, as v1: the extension is enough
    let own = work.join("own.png").display().to_string();
    assert_eq!(served(&own).await, Some(work.join("own.png")));
    std::fs::remove_dir_all(&tmp).ok();
}
