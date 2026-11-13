//! boxd's socket (v1 grid/boxd.js `createBoxd`, `serveBoxd`, `migrate`). One JSON line per connection: `ping`,
//! `remove` or `run`. A run's connection stays open while its box runs: `{log}` lines, then `{exit}`. The grid may
//! send `{signal: "SIGTERM" | "SIGKILL"}` on it; closing it stops the box (TERM, then hard after 10 s).

use std::collections::HashMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use crate::json::{J, parse};
use crate::run::{Container, check_run, container_name, container_run, env_file_text, is_id};

const KILL_AFTER: Duration = Duration::from_secs(10);
const MAX_LINE: usize = 64 * 1024;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// boxd's settings.
#[derive(Debug, Clone)]
pub struct Opts {
    pub socket: PathBuf,
    pub group: String,
    pub data: PathBuf,
    pub boxes: PathBuf,
    pub docker: String,
    pub container: Container,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            socket: "/run/wisp-grid/box.sock".into(),
            group: "wisp".into(),
            data: "/var/lib/wisp-grid".into(),
            boxes: "/var/lib/wisp-grid-boxes".into(),
            docker: "docker".into(),
            container: Container::default(),
        }
    }
}

/// One box running: its docker process, and a flag that's set when it's gone.
struct Running {
    pid: u32,
    name: String,
    done: Arc<(Mutex<bool>, Condvar)>,
}

impl std::fmt::Debug for Boxd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Boxd").field("o", &self.o).field("running", &lock(&self.runs).len()).finish_non_exhaustive()
    }
}

pub struct Boxd {
    pub o: Opts,
    runs: Mutex<HashMap<String, Arc<Running>>>,
    root: bool,
}

/// Whether this process is root (Linux: `/proc/self` is owned by the effective user).
pub fn is_root() -> bool {
    std::fs::metadata("/proc/self").is_ok_and(|m| m.uid() == 0)
}

fn path_env() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into())
}

fn send(w: &Mutex<UnixStream>, m: &J) {
    let mut s = m.to_string();
    s.push('\n');
    let _ = lock(w).write_all(s.as_bytes());
}

fn signal(pid: u32, sig: &str) {
    let _ = Command::new("kill").args([&format!("-{sig}"), &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

impl Boxd {
    pub fn new(o: Opts) -> Arc<Self> {
        Arc::new(Self { o, runs: Mutex::new(HashMap::new()), root: is_root() })
    }

    fn docker(&self, args: &[&str]) -> i32 {
        Command::new(&self.o.docker)
            .args(args)
            .env_clear()
            .env("PATH", path_env())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_or(127, |s| s.code().unwrap_or(1))
    }

    /// `<boxes>/<id>` (root, 0700) holds the box's env file and resolv.conf, and its home (the box's uid).
    fn prepare(&self, id: &str) -> Result<(PathBuf, PathBuf), String> {
        let dir = self.o.boxes.join(id);
        let home = dir.join("home");
        if !home.exists() {
            let old = self.o.data.join("users").join(id).join("home");
            if std::fs::symlink_metadata(&old).is_ok_and(|m| m.is_dir()) {
                return Err(format!("Its files are still at {}: stop the grid and run `wisp-grid-boxd migrate`.", old.display()));
            }
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        if !home.exists() {
            std::fs::create_dir(&home).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            if self.root {
                std::os::unix::fs::chown(&home, Some(self.o.container.uid), Some(self.o.container.uid)).map_err(|e| e.to_string())?;
            }
        }
        Ok((dir, home))
    }

    /// Stops a run (hard) and waits for it to be gone.
    fn stop_run(&self, id: &str) {
        let Some(r) = lock(&self.runs).get(id).cloned() else { return };
        self.hard(&r);
        Self::wait(&r, None);
    }

    fn hard(&self, r: &Running) {
        if *lock(&r.done.0) {
            return;
        }
        let _ = self.docker(&["kill", &r.name]);
        signal(r.pid, "KILL");
    }

    fn wait(r: &Running, at_most: Option<Duration>) -> bool {
        let (m, cv) = &*r.done;
        let mut done = lock(m);
        let deadline = at_most.map(|d| std::time::Instant::now() + d);
        while !*done {
            match deadline {
                Some(d) => {
                    let left = d.saturating_duration_since(std::time::Instant::now());
                    if left.is_zero() {
                        return false;
                    }
                    done = cv.wait_timeout(done, left).unwrap_or_else(PoisonError::into_inner).0;
                }
                None => done = cv.wait(done).unwrap_or_else(PoisonError::into_inner),
            }
        }
        true
    }

    fn write_private(path: &Path, text: &str, mode: u32) -> Result<(), String> {
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(&tmp).map_err(|e| e.to_string())?;
            f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    /// A run: the box starts, its output streams back, its exit ends the connection.
    fn run(self: &Arc<Self>, conn: &UnixStream, req: &J, out: &Arc<Mutex<UnixStream>>) -> Result<Arc<Running>, String> {
        let r = check_run(req, &self.o.container)?;
        let name = container_name(&r.id);
        self.stop_run(&r.id); // one the grid lost track of (it restarted)
        let _ = self.docker(&["rm", "-f", &name]); // and any box left from before boxd restarted
        let (dir, home) = self.prepare(&r.id)?;
        let resolv = dir.join("resolv.conf");
        Self::write_private(&resolv, &r.dns.iter().fold(String::new(), |acc, x| acc + "nameserver " + x + "\n"), 0o644)?;
        let env_file = dir.join("env");
        Self::write_private(&env_file, &env_file_text(&r.env)?, 0o600)?;
        let args = container_run(&self.o.container, &r, &resolv.to_string_lossy(), &env_file.to_string_lossy(), &home.to_string_lossy());
        let mut child: Child = Command::new(&self.o.docker)
            .args(&args)
            .env_clear()
            .env("PATH", path_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{}: {e}", self.o.docker))?;
        let running = Arc::new(Running { pid: child.id(), name: name.clone(), done: Arc::new((Mutex::new(false), Condvar::new())) });
        lock(&self.runs).insert(r.id.clone(), running.clone());
        let pipes: Vec<Box<dyn std::io::Read + Send>> = [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        .collect();
        let mut readers = Vec::new();
        for mut p in pipes {
            let out = out.clone();
            readers.push(std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = p.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    send(&out, &J::obj(vec![("log", J::Str(String::from_utf8_lossy(&buf[..n]).into_owned()))]));
                }
            }));
        }
        let (me, id, out2, done, conn2) = (self.clone(), r.id.clone(), out.clone(), running.clone(), conn.try_clone().ok());
        std::thread::spawn(move || {
            let st = child.wait();
            for t in readers {
                let _ = t.join();
            }
            let _ = std::fs::remove_file(&env_file);
            {
                let mut runs = lock(&me.runs);
                if runs.get(&id).is_some_and(|x| Arc::ptr_eq(x, &done)) {
                    runs.remove(&id);
                }
            }
            let (code, sig) = match st {
                Ok(s) => {
                    use std::os::unix::process::ExitStatusExt as _;
                    (s.code().map_or(J::Null, |c| J::Num(f64::from(c))), s.signal().map_or(J::Null, |n| J::Str(format!("signal {n}"))))
                }
                Err(_) => (J::Num(127.0), J::Null),
            };
            send(&out2, &J::obj(vec![("exit", code), ("signal", sig)]));
            *lock(&done.done.0) = true;
            done.done.1.notify_all();
            if let Some(c) = conn2 {
                let _ = c.shutdown(std::net::Shutdown::Both);
            }
        });
        Ok(running)
    }

    /// Deletes a box for good: the container, then its folder (home, logins and all).
    fn remove(&self, req: &J) -> Result<(), String> {
        let id = req.get("id").map(J::text).unwrap_or_default();
        if !is_id(&id) {
            return Err("remove: a user id, please.".into());
        }
        self.stop_run(&id);
        let _ = self.docker(&["rm", "-f", &container_name(&id)]);
        let dir = self.o.boxes.join(&id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// One connection.
    #[allow(clippy::needless_pass_by_value)] // the connection is this thread's, and ends with it
    pub fn handle(self: &Arc<Self>, conn: UnixStream) {
        let Ok(w) = conn.try_clone() else { return };
        let out = Arc::new(Mutex::new(w));
        let mut rd = BufReader::new(match conn.try_clone() {
            Ok(c) => c,
            Err(_) => return,
        });
        let mut line = String::new();
        let first = match rd.by_ref().take(MAX_LINE as u64).read_line(&mut line) {
            Ok(n) if n > 0 && line.ends_with('\n') => parse(line.trim_end()),
            _ => return,
        };
        let end = |out: &Arc<Mutex<UnixStream>>| {
            let _ = lock(out).shutdown(std::net::Shutdown::Both);
        };
        let Ok(m) = first else {
            send(&out, &J::obj(vec![("error", J::Str("Not JSON.".into()))]));
            return end(&out);
        };
        let fail = |e: String| {
            send(&out, &J::obj(vec![("error", J::Str(e))]));
            end(&out);
        };
        match m.get("op").and_then(J::str) {
            Some("ping") => {
                let c = &self.o.container;
                send(
                    &out,
                    &J::obj(vec![
                        ("ok", J::Bool(true)),
                        ("boxes", J::Str(self.o.boxes.to_string_lossy().into_owned())),
                        ("image", J::Str(c.image.clone())),
                        ("runtime", J::Str(c.runtime.clone())),
                        ("network", J::Str(c.network.clone())),
                        ("running", J::Num(f64::from(u32::try_from(lock(&self.runs).len()).unwrap_or(u32::MAX)))),
                    ]),
                );
                end(&out);
            }
            Some("remove") => match self.remove(&m) {
                Ok(()) => {
                    send(&out, &J::obj(vec![("ok", J::Bool(true))]));
                    end(&out);
                }
                Err(e) => fail(e),
            },
            Some("run") => match self.run(&conn, &m, &out) {
                Ok(r) => self.control(rd, &r),
                Err(e) => fail(e),
            },
            other => fail(format!("Unknown op \"{}\".", other.unwrap_or(""))),
        }
    }

    /// A run's connection after the request: signals, until it closes, which stops the box.
    fn control(self: &Arc<Self>, mut rd: BufReader<UnixStream>, r: &Arc<Running>) {
        let mut line = String::new();
        loop {
            line.clear();
            match rd.by_ref().take(MAX_LINE as u64).read_line(&mut line) {
                Ok(n) if n > 0 => match parse(line.trim_end()).ok().as_ref().and_then(|m| m.get("signal")).and_then(J::str) {
                    // `docker run` passes it on to the container
                    Some("SIGTERM") => signal(r.pid, "TERM"),
                    Some("SIGKILL") => self.hard(r),
                    _ => {}
                },
                _ => break,
            }
            if *lock(&r.done.0) {
                return;
            }
        }
        // the grid went away (it stopped or restarted): stop the box, as when the grid stops it
        if *lock(&r.done.0) {
            return;
        }
        signal(r.pid, "TERM");
        if !Self::wait(r, Some(KILL_AFTER)) {
            self.hard(r);
        }
    }

    /// boxd is stopping: every box stops the way the grid stops them, then hard after a while.
    pub fn stop_all(&self) {
        let all: Vec<Arc<Running>> = lock(&self.runs).values().cloned().collect();
        for r in &all {
            signal(r.pid, "TERM");
        }
        for r in &all {
            if !Self::wait(r, Some(KILL_AFTER)) {
                self.hard(r);
                Self::wait(r, Some(KILL_AFTER));
            }
        }
    }
}

/// boxd's folder and every folder above it: root's and writable by root only, or someone could swap a box's home
/// for a link to anywhere.
pub fn root_only_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut d = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    loop {
        let m = std::fs::symlink_metadata(&d).map_err(|e| e.to_string())?;
        if m.file_type().is_symlink() || m.uid() != 0 || m.mode() & 0o022 != 0 {
            return Err(format!("{} must be root's and writable by root only: boxd keeps the users' homes under it.", d.display()));
        }
        if !d.pop() {
            break;
        }
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

fn group_id(name: &str) -> Result<u32, String> {
    let text = std::fs::read_to_string("/etc/group").map_err(|e| e.to_string())?;
    text.lines()
        .map(|l| l.split(':').collect::<Vec<_>>())
        .find(|f| f.first() == Some(&name))
        .and_then(|f| f.get(2).and_then(|g| g.parse().ok()))
        .ok_or_else(|| format!("There's no group \"{name}\" (--group: the grid's user's group)."))
}

/// The users' network: containers can't talk to each other.
fn ensure_network(o: &Opts) -> Result<(), String> {
    let run = |args: &[&str]| {
        Command::new(&o.docker)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "The container driver needs Docker.".to_owned())
    };
    if run(&["network", "inspect", &o.container.network])?.success() {
        return Ok(());
    }
    let ok = run(&[
        "network",
        "create",
        "--driver",
        "bridge",
        "-o",
        "com.docker.network.bridge.enable_icc=false",
        "-o",
        "com.docker.network.bridge.name=br-wisp",
        &o.container.network,
    ])?
    .success();
    if ok { Ok(()) } else { Err(format!("docker network create {} failed", o.container.network)) }
}

/// Listens on the socket (0660, the grid's group) until the process is stopped.
pub fn serve(o: Opts) -> Result<(Arc<Boxd>, UnixListener), String> {
    let root = is_root();
    if root {
        root_only_dir(&o.boxes)?;
    } else {
        std::fs::create_dir_all(&o.boxes).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&o.boxes, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let gid = if root && !o.group.is_empty() { Some(group_id(&o.group)?) } else { None };
    if let Err(e) = ensure_network(&o) {
        eprintln!("boxd: {e}");
    }
    if std::fs::symlink_metadata(&o.socket).is_ok_and(|m| {
        use std::os::unix::fs::FileTypeExt as _;
        m.file_type().is_socket()
    }) {
        let _ = std::fs::remove_file(&o.socket);
    }
    if let Some(dir) = o.socket.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        // nobody but root and the group reaches the socket while its own mode is being set
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o750)).map_err(|e| e.to_string())?;
        if let Some(g) = gid {
            std::os::unix::fs::chown(dir, Some(0), Some(g)).map_err(|e| e.to_string())?;
        }
    }
    let l = UnixListener::bind(&o.socket).map_err(|e| format!("{}: {e}", o.socket.display()))?;
    if let Some(g) = gid {
        std::os::unix::fs::chown(&o.socket, Some(0), Some(g)).map_err(|e| e.to_string())?;
    }
    std::fs::set_permissions(&o.socket, std::fs::Permissions::from_mode(0o660)).map_err(|e| e.to_string())?;
    Ok((Boxd::new(o), l))
}

/// Accepts connections, each on its own thread.
pub fn accept(b: &Arc<Boxd>, l: &UnixListener) {
    for c in l.incoming().flatten() {
        let b = b.clone();
        std::thread::spawn(move || b.handle(c));
    }
}

/// Homes kept at the old place (`<data>/users/<id>/home`, in the grid's own folder) move into boxd's, with the grid
/// stopped. → (moved, skipped).
pub fn migrate(o: &Opts) -> Result<(Vec<String>, Vec<String>), String> {
    let ps = Command::new(&o.docker).args(["ps", "-q", "--filter", "name=wisp-u-"]).output();
    if ps.as_ref().is_ok_and(|p| p.status.success() && !String::from_utf8_lossy(&p.stdout).trim().is_empty()) {
        return Err("Boxes are running: stop the grid first (systemctl stop wisp-grid).".into());
    }
    if is_root() {
        root_only_dir(&o.boxes)?;
    } else {
        std::fs::create_dir_all(&o.boxes).map_err(|e| e.to_string())?;
    }
    let users = o.data.join("users");
    let mut ids: Vec<String> =
        std::fs::read_dir(&users).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    ids.sort();
    let (mut moved, mut skipped) = (Vec::new(), Vec::new());
    let real_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    for id in ids {
        let from = users.join(&id).join("home");
        if !is_id(&id) || !from.exists() {
            continue;
        }
        let to = o.boxes.join(&id).join("home");
        let why = if !real_dir(&users.join(&id)) || !real_dir(&from) {
            format!("{} isn't a folder", from.display())
        } else if to.exists() {
            format!("{} is already there", to.display())
        } else {
            String::new()
        };
        if !why.is_empty() {
            eprintln!("  ! {id}: skipped, {why}");
            skipped.push(id);
            continue;
        }
        let parent = o.boxes.join(&id);
        std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(&from, &to) {
            // another disk: mv copies it across (owners, modes and links kept) and removes the old one
            let ok = e.raw_os_error() == Some(18) && Command::new("mv").arg(&from).arg(&to).status().is_ok_and(|s| s.success());
            if !ok {
                let _ = std::fs::remove_dir_all(&parent);
                return Err(format!("{} → {}: {e}", from.display(), to.display()));
            }
        }
        eprintln!("  ✓ {id}: {} → {}", from.display(), to.display());
        moved.push(id);
    }
    Ok((moved, skipped))
}

#[cfg(test)]
#[path = "serve_tests.rs"]
mod tests;
