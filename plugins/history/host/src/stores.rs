//! `history.store@1` as wisp ships it: `files` (the working tree), `notes` (transcripts as git notes on
//! `refs/notes/wisp`), `lfs` (the files, transcripts routed to Git LFS by `.gitattributes`).

use std::path::PathBuf;
use std::sync::Arc;

use wisp_history_api::HistoryStore;
use wisp_kernel::{BoxFuture, Result, WireError};
use wisp_proc::Proc;

fn io(e: &std::io::Error) -> WireError {
    WireError::internal(format!("history: {e}"))
}

async fn write_files(root: &std::path::Path, files: Vec<(String, Vec<u8>)>) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for (rel, bytes) in files {
        let p = root.join(".wisp").join(&rel);
        if let Some(d) = p.parent() {
            tokio::fs::create_dir_all(d).await.map_err(|e| io(&e))?;
        }
        tokio::fs::write(&p, bytes).await.map_err(|e| io(&e))?;
        out.push(format!(".wisp/{rel}"));
    }
    Ok(out)
}

async fn remove_files(root: &std::path::Path, rels: Vec<String>) -> Vec<String> {
    let mut gone = Vec::new();
    for rel in rels {
        if tokio::fs::remove_file(root.join(".wisp").join(&rel)).await.is_ok() {
            gone.push(format!(".wisp/{rel}"));
        }
    }
    gone
}

pub struct Files;

impl HistoryStore for Files {
    fn id(&self) -> &'static str {
        "files"
    }
    fn write(&self, root: PathBuf, files: Vec<(String, Vec<u8>)>) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async move { write_files(&root, files).await })
    }
    fn remove(&self, root: PathBuf, rels: Vec<String>) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async move { Ok(remove_files(&root, rels).await) })
    }
    fn read(&self, root: PathBuf, rel: String) -> BoxFuture<'static, Option<Vec<u8>>> {
        Box::pin(async move { tokio::fs::read(root.join(".wisp").join(rel)).await.ok() })
    }
}

/// The line that sends transcripts to LFS.
pub const LFS_LINE: &str = ".wisp/history/*.zst filter=lfs diff=lfs merge=lfs -text";

pub struct Lfs;

impl HistoryStore for Lfs {
    fn id(&self) -> &'static str {
        "lfs"
    }
    fn write(&self, root: PathBuf, files: Vec<(String, Vec<u8>)>) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async move {
            let attrs = root.join(".gitattributes");
            let had = tokio::fs::read_to_string(&attrs).await.unwrap_or_default();
            let mut out = Vec::new();
            if !had.lines().any(|l| l.trim() == LFS_LINE) {
                let sep = if had.is_empty() || had.ends_with('\n') { "" } else { "\n" };
                tokio::fs::write(&attrs, format!("{had}{sep}{LFS_LINE}\n")).await.map_err(|e| io(&e))?;
                out.push(".gitattributes".into());
            }
            out.extend(write_files(&root, files).await?);
            Ok(out)
        })
    }
    fn remove(&self, root: PathBuf, rels: Vec<String>) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async move { Ok(remove_files(&root, rels).await) })
    }
    fn read(&self, root: PathBuf, rel: String) -> BoxFuture<'static, Option<Vec<u8>>> {
        Box::pin(async move { tokio::fs::read(root.join(".wisp").join(rel)).await.ok() })
    }
}

/// Transcripts (`history/…`) as git notes on `refs/notes/wisp`, each on a blob named after its path; the
/// task file and report stay in the tree.
pub struct Notes(pub Arc<Proc>);

async fn key_blob(proc: &Proc, root: &std::path::Path, rel: &str) -> Option<String> {
    let opts = wisp_proc::ExecOpts { cwd: Some(root.to_owned()), input: Some(format!("wisp history {rel}\n").into_bytes()), ..wisp_proc::ExecOpts::default() };
    let r = proc.exec("git", &["hash-object".to_owned(), "-w".to_owned(), "--stdin".to_owned()], opts).await.ok()?;
    r.exit.success().then(|| r.stdout_text().trim().to_owned())
}

impl HistoryStore for Notes {
    fn id(&self) -> &'static str {
        "notes"
    }
    fn write(&self, root: PathBuf, files: Vec<(String, Vec<u8>)>) -> BoxFuture<'static, Result<Vec<String>>> {
        let p = self.0.clone();
        Box::pin(async move {
            let (notes, tree): (Vec<_>, Vec<_>) = files.into_iter().partition(|(rel, _)| rel.starts_with("history/"));
            let mut out = write_files(&root, tree).await?;
            for (rel, bytes) in notes {
                let blob = key_blob(&p, &root, &rel).await.ok_or_else(|| WireError::invalid(format!("{} isn't a git repo: notes need one", root.display())))?;
                // the bytes as a blob of their own (`-C`: no message clean-up, so a binary transcript stays exact)
                let opts = wisp_proc::ExecOpts { cwd: Some(root.clone()), input: Some(bytes), ..wisp_proc::ExecOpts::default() };
                let content = p.exec("git", &["hash-object".to_owned(), "-w".to_owned(), "--stdin".to_owned()], opts).await.ok().filter(|r| r.exit.success()).map(|r| r.stdout_text().trim().to_owned());
                let ok = match content {
                    Some(c) => crate::git::run(&p, "git", &root, &["notes", "--ref=wisp", "add", "-f", "-C", &c, &blob]).await.is_some(),
                    None => false,
                };
                if !ok {
                    return Err(WireError::internal(format!("git notes couldn't keep {rel}")));
                }
                out.push(format!("refs/notes/wisp:{rel}"));
            }
            Ok(out)
        })
    }
    fn remove(&self, root: PathBuf, rels: Vec<String>) -> BoxFuture<'static, Result<Vec<String>>> {
        let p = self.0.clone();
        Box::pin(async move {
            let (notes, tree): (Vec<_>, Vec<_>) = rels.into_iter().partition(|rel| rel.starts_with("history/"));
            let mut gone = remove_files(&root, tree).await;
            for rel in notes {
                if let Some(blob) = key_blob(&p, &root, &rel).await
                    && crate::git::run(&p, "git", &root, &["notes", "--ref=wisp", "remove", &blob]).await.is_some()
                {
                    gone.push(format!("refs/notes/wisp:{rel}"));
                }
            }
            Ok(gone)
        })
    }
    fn read(&self, root: PathBuf, rel: String) -> BoxFuture<'static, Option<Vec<u8>>> {
        let p = self.0.clone();
        Box::pin(async move {
            if !rel.starts_with("history/") {
                return tokio::fs::read(root.join(".wisp").join(rel)).await.ok();
            }
            let blob = key_blob(&p, &root, &rel).await?;
            let opts = wisp_proc::ExecOpts { cwd: Some(root.clone()), max_output: 256 << 20, ..wisp_proc::ExecOpts::default() };
            let r = p.exec("git", &["notes".to_owned(), "--ref=wisp".to_owned(), "show".to_owned(), blob], opts).await.ok()?;
            r.exit.success().then_some(r.stdout)
        })
    }
}

/// `notes`, with the proc service looked up at each call.
pub struct LazyNotes(pub wisp_kernel::Ctx);

impl HistoryStore for LazyNotes {
    fn id(&self) -> &'static str {
        "notes"
    }
    fn write(&self, root: PathBuf, files: Vec<(String, Vec<u8>)>) -> BoxFuture<'static, Result<Vec<String>>> {
        match self.0.service::<Proc>() {
            Ok(p) => Notes(p).write(root, files),
            Err(e) => Box::pin(async move { Err(e) }),
        }
    }
    fn remove(&self, root: PathBuf, rels: Vec<String>) -> BoxFuture<'static, Result<Vec<String>>> {
        match self.0.service::<Proc>() {
            Ok(p) => Notes(p).remove(root, rels),
            Err(e) => Box::pin(async move { Err(e) }),
        }
    }
    fn read(&self, root: PathBuf, rel: String) -> BoxFuture<'static, Option<Vec<u8>>> {
        match self.0.service::<Proc>() {
            Ok(p) => Notes(p).read(root, rel),
            Err(_) => Box::pin(async { None }),
        }
    }
}
