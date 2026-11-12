//! An answer's pictures through the host (v1 routes/sessions.js `/sessions/:id/file`, `/reveal`): a picture in the
//! task's folder is found on disk, anything else is not, and Show in folder on a gone file says so.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{rig, rig_with, until};
use wisp_runtime::Recorder;
use wisp_runtime_api::commands::StartArgs;

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
    std::fs::write(&shot, b"png bytes").unwrap();
    let r = rig_with(Recorder { shots: Some(shots.clone()), ..Recorder::default() }).await;
    let id = r.rt.create(StartArgs { prompt: format!("shot {}", shot.display()), cwd: Some(work.display().to_string()), ..StartArgs::default() }).await.unwrap().id.0;
    until("the turn to end", || async { r.rt.turns(&id, None, None).await.unwrap().last().is_some_and(|t| t.presentation.is_some()) }).await;
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    let block = t.presentation.unwrap().blocks.into_iter().find(|b| b["type"] == "image").expect("the picture");
    let copy = shots.join(&id).join(format!("{}-1.png", t.id.as_str()));
    assert_eq!(block["path"], copy.display().to_string());
    assert_eq!(block["source"], shot.display().to_string());
    assert_eq!(std::fs::read(&copy).unwrap(), b"png bytes");
    // /tmp cleared: the page still gets the picture, by either path
    std::fs::remove_file(&shot).unwrap();
    assert_eq!(r.rt.media(&id, &shot.display().to_string()).await.unwrap().unwrap().path, copy);
    // the task deleted: its pictures go with it
    r.rt.delete(&id).await.unwrap();
    assert!(!shots.join(&id).exists());
    std::fs::remove_dir_all(&tmp).ok();
}
