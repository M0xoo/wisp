//! The desktop window for a wisp from npm (v1 bin/desktop-shell.js): the Tauri shell alone, one small
//! archive per platform on each GitHub release, downloaded once into ~/.wisp/desktop/<version>/,
//! checked against that release's SHA256SUMS.txt, unpacked with the system's tar, moved into place in
//! one step. It runs this binary as its server (`WISP_BIN`, `WISP_PORT`). Anything short of a shell that's
//! all there and checked gives a reason, and the caller opens a browser tab instead.
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

pub const RELEASES: &str = "https://github.com/WispAgents/wisp/releases/download";
pub const GET_APP: &str = "https://trywisp.dev/#install";

/// desktop/scripts/package.mjs names them the same way.
pub fn shell_asset(os: &str, arch: &str) -> Option<String> {
    let os = match os {
        "macos" => "mac",
        "windows" => "windows",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("wisp-shell-{os}-{arch}.tar.gz"))
}

/// The app bundle on a Mac (its Info.plist names the Dock tile), the bare binary elsewhere.
pub fn shell_exe(dir: &Path, os: &str) -> PathBuf {
    match os {
        "macos" => dir.join("wisp.app/Contents/MacOS/wisp"),
        "windows" => dir.join("wisp.exe"),
        _ => dir.join("wisp"),
    }
}

/// The rolling nightly is tagged `nightly`, every other release v<version>; `WISP_SHELL_URL` stands in.
pub fn release_url(version: &str, over: Option<&str>) -> String {
    over.map_or_else(|| format!("{RELEASES}/{}", if version.contains("-nightly.") { "nightly".to_owned() } else { format!("v{version}") }), str::to_owned).trim_end_matches('/').to_owned()
}

pub fn sum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let (hash, file) = l.trim().split_once(char::is_whitespace)?;
        (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && file.trim().trim_start_matches('*') == name).then(|| hash.to_ascii_lowercase())
    })
}

async fn get(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let r = client.get(url).timeout(timeout).send().await.map_err(|e| format!("couldn't reach {url} ({e})"))?;
    if r.status().as_u16() == 404 {
        return Err(format!("{url} isn't there"));
    }
    if !r.status().is_success() {
        return Err(format!("{url} answered {}", r.status()));
    }
    Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/// The shell's executable, fetched if this version has none yet; Err: why there is no window.
pub async fn shell(home: &Path, version: &str) -> Result<PathBuf, String> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let name = shell_asset(os, arch).ok_or_else(|| format!("no wisp app for {os} {arch}"))?;
    let dir = home.join("desktop").join(version);
    let exe = shell_exe(&dir, os);
    if exe.is_file() {
        return Ok(exe);
    }
    let base = release_url(version, std::env::var("WISP_SHELL_URL").ok().as_deref());
    let client = reqwest::Client::new();
    let sums = String::from_utf8_lossy(&get(&client, &format!("{base}/SHA256SUMS.txt"), Duration::from_secs(10)).await?).into_owned();
    let want = sum_for(&sums, &name).ok_or_else(|| format!("wisp {version} has no {name}"))?;
    eprintln!("  ◌ getting the wisp app for {version} (once)…");
    let body = get(&client, &format!("{base}/{name}"), Duration::from_secs(120)).await?;
    if crate::services::hex(&Sha256::digest(&body)) != want {
        return Err(format!("{name} doesn't match SHA256SUMS.txt"));
    }
    let part = dir.with_extension(format!("part-{}", std::process::id()));
    let out = unpack(&part, &name, &body, os).and_then(|()| {
        std::fs::create_dir_all(dir.parent().unwrap_or(home)).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&dir);
        // another wisp may have got there first: its copy is as good
        std::fs::rename(&part, &dir).or_else(|e| if exe.is_file() { Ok(()) } else { Err(e.to_string()) })
    });
    let _ = std::fs::remove_dir_all(&part);
    out.map(|()| exe)
}

fn unpack(part: &Path, name: &str, body: &[u8], os: &str) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(part);
    std::fs::create_dir_all(part).map_err(|e| e.to_string())?;
    std::fs::write(part.join(name), body).map_err(|e| e.to_string())?;
    // from inside the folder: Git Bash's GNU tar takes C:\ for a host name
    let tar = if os == "windows" { std::env::var("SystemRoot").map_or_else(|_| PathBuf::from(r"C:\Windows\System32\tar.exe"), |r| Path::new(&r).join(r"System32\tar.exe")) } else { PathBuf::from("tar") };
    let ok = std::process::Command::new(tar).args(["-xzf", name]).current_dir(part).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map_err(|e| format!("couldn't unpack {name}: {e}"))?;
    if !ok.success() {
        return Err(format!("couldn't unpack {name}"));
    }
    let _ = std::fs::remove_file(part.join(name));
    if !shell_exe(part, os).is_file() {
        return Err(format!("{name} holds no wisp app"));
    }
    Ok(())
}

/// Starts the window, detached: it runs this binary as its server and outlives the terminal.
pub fn launch(exe: &Path, port: u16) -> std::io::Result<()> {
    let me = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.env("WISP_PORT", port.to_string()).env("WISP_BIN", me).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd.spawn().map(drop)
}

pub fn no_app_line(why: &str) -> String {
    format!("  ◌ no wisp app here ({why}): opening a browser tab. The app: {GET_APP}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_sums() {
        assert_eq!(shell_asset("macos", "aarch64").as_deref(), Some("wisp-shell-mac-arm64.tar.gz"));
        assert_eq!(shell_asset("linux", "arm"), None);
        assert_eq!(shell_exe(Path::new("/d"), "macos"), PathBuf::from("/d/wisp.app/Contents/MacOS/wisp"));
        assert_eq!(release_url("2.0.0", None), format!("{RELEASES}/v2.0.0"));
        assert_eq!(release_url("2.1.0-nightly.3", None), format!("{RELEASES}/nightly"));
        assert_eq!(release_url("2.0.0", Some("http://x/y/")), "http://x/y");
        let h = "a".repeat(64);
        assert_eq!(sum_for(&format!("{h}  wisp-shell-mac-arm64.tar.gz\n{}  other", "b".repeat(64)), "wisp-shell-mac-arm64.tar.gz"), Some(h.clone()));
        assert_eq!(sum_for(&format!("{h} *x.tar.gz"), "x.tar.gz"), Some(h));
        assert_eq!(sum_for("zz  x.tar.gz", "x.tar.gz"), None);
    }
}
