//! `runtime.discover` (v1 places.js `discoverRepos`): git repos under the usual folders of your home, two levels down,
//! not projects yet, the 24 changed last. Async reads: it runs in a request.

use std::path::{Path, PathBuf};

use wisp_runtime_api::commands::FoundRepo;

/// The folders under your home v1 looked in (`REPO_ROOTS`).
pub const ROOTS: [&str; 14] = ["code", "Code", "dev", "Developer", "projects", "Projects", "src", "repos", "work", "git", "GitHub", "Documents", "Downloads", "Desktop"];
const MAX_SEEN: usize = 60;
const SHOWN: usize = 24;

fn ms(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The folder as the disk names it: on a case-insensitive disk `~/code` and `~/Code` are one folder (v1 listed
/// each repo twice), and a known project reached by the other spelling is still known. Windows' `\\?\` prefix goes.
async fn real(p: &Path) -> String {
    let r = tokio::fs::canonicalize(p).await.unwrap_or_else(|_| p.to_owned()).display().to_string();
    r.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(r)
}

/// The repos under `home`'s usual folders, minus `known` (project paths).
pub async fn discover(home: &Path, known: &[String]) -> Vec<FoundRepo> {
    let mut known_real = Vec::new();
    for k in known {
        known_real.push(real(Path::new(k.trim_end_matches('/'))).await);
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut found = Vec::new();
    let mut stack: Vec<(PathBuf, u8)> = ROOTS.iter().rev().map(|r| (home.join(r), 2)).collect();
    while let Some((dir, depth)) = stack.pop() {
        if found.len() >= MAX_SEEN {
            break;
        }
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
        let mut subs = Vec::new();
        let mut repo = false;
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                repo = true;
                break;
            }
            if depth > 0 && !name.starts_with('.') && name != "node_modules" && e.file_type().await.is_ok_and(|t| t.is_dir()) {
                subs.push(e.path());
            }
        }
        if repo {
            let path = real(&dir).await;
            if seen.insert(path.clone()) && !known_real.contains(&path) {
                let mtime = ms(tokio::fs::metadata(&dir).await.and_then(|m| m.modified()));
                found.push(FoundRepo { name: Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path, mtime });
            }
            continue;
        }
        subs.sort();
        stack.extend(subs.into_iter().rev().map(|d| (d, depth - 1)));
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    found.truncate(SHOWN);
    found
}

/// The suggestions a folder picker shows (v1 `GET /fs?q=`).
const FOLDERS_SHOWN: usize = 12;

/// The folders `q` could go on to: under its folder (all of it when `q` ends in a separator), the ones whose name
/// starts with what follows (any case), no hidden ones, sorted, 12 at most. `~` is `home`, and a path typed from
/// `~` is answered from `~`. A relative path gets
/// none: v1 read it against the server's own working folder, which is no folder of yours.
pub async fn folders(q: &str, home: Option<&Path>) -> Vec<String> {
    let (raw, tilde) = match (q.strip_prefix('~'), home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with(['/', '\\']) => (format!("{}{rest}", h.display()), Some(h.display().to_string())),
        (Some(_), _) => return Vec::new(),
        (None, _) => (q.to_owned(), None),
    };
    if !Path::new(&raw).is_absolute() {
        return Vec::new();
    }
    let trailing = raw.ends_with(['/', '\\']);
    let p = Path::new(&raw);
    let (dir, prefix) = if trailing { (p.to_owned(), String::new()) } else { (p.parent().map_or_else(|| p.to_owned(), Path::to_owned), p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()) };
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { return Vec::new() };
    let mut out = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.to_lowercase().starts_with(&prefix) {
            continue;
        }
        if e.file_type().await.is_ok_and(|t| t.is_dir()) {
            out.push(dir.join(&name).display().to_string());
        }
    }
    out.sort();
    out.truncate(FOLDERS_SHOWN);
    // typed from `~`: answered from `~` too, so the box keeps the form you typed
    if let Some(h) = tilde {
        for p in &mut out {
            if let Some(rest) = p.strip_prefix(&h) {
                *p = format!("~{rest}");
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// v1 places.js: a repo two levels under a usual folder is found, one already a project isn't, nothing inside a
    /// repo or under `node_modules` or a dot folder is looked at, and a folder outside the usual ones is left alone.
    /// Each repo once, though `code` and `Code` are one folder on a case-insensitive disk (v1 listed it twice).
    #[tokio::test]
    async fn repos_on_this_computer_that_arent_projects_yet_are_found() {
        let home = std::env::temp_dir().join(format!("wisp-found-{}", wisp_kernel::ids::uuid7()));
        for d in ["code/web/.git", "code/group/api/.git", "code/group/api/sub/.git", "code/node_modules/x/.git", "code/.hidden/y/.git", "Projects/known/.git", "elsewhere/z/.git", "code/a/b/c/.git"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        let known = vec![home.join("Projects/known").display().to_string()];
        let mut names: Vec<String> = discover(&home, &known).await.into_iter().map(|f| f.name).collect();
        names.sort();
        assert_eq!(names, ["api", "web"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// v1 `GET /fs?q=`: the folders under the typed path's folder that start with its last part, any case; a trailing
    /// separator lists the folder; no files, no hidden folders; `~` is home (and the answer keeps it); 12 at most, sorted. A relative path gets
    /// none (v1 listed the server's working folder) and so does `~user`.
    #[tokio::test]
    async fn a_typed_path_suggests_the_folders_it_could_go_on_to_v1_fs() {
        let home = std::env::temp_dir().join(format!("wisp-folders-{}", wisp_kernel::ids::uuid7()));
        for d in ["code/web", "code/Wisp", "code/wiki", "code/.wip", "notes"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::write(home.join("code/wip.txt"), "x").unwrap();
        let h = home.display().to_string();
        let got = folders(&format!("{h}/code/wi"), None).await;
        assert_eq!(got, [format!("{h}/code/Wisp"), format!("{h}/code/wiki")]);
        assert_eq!(folders(&format!("{h}/code/"), None).await.len(), 3, "a trailing / lists the folder: web, Wisp, wiki");
        assert_eq!(folders("~/no", Some(&home)).await, ["~/notes"], "typed from ~, answered from ~");
        assert_eq!(folders("code/wi", Some(&home)).await, Vec::<String>::new(), "relative: none");
        assert_eq!(folders("~bob/x", Some(&home)).await, Vec::<String>::new());
        for i in 0..20 {
            std::fs::create_dir_all(home.join(format!("many/d{i:02}"))).unwrap();
        }
        assert_eq!(folders(&format!("{h}/many/"), None).await.len(), 12);
        let _ = std::fs::remove_dir_all(&home);
    }
}
